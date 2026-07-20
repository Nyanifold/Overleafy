import { Command, Option } from "commander";
import {
  FileBindingStore,
  FileRepositoryLock,
  FileSecretStore,
  FileStateStore,
  ProfileGitCredentials,
} from "../config/mod.js";
import {
  OverleafyError,
  SyncService,
  RESULT_SCHEMA_VERSION,
  type DirtyPolicy,
  type OperationResult,
  type RewritePolicy,
} from "../core/mod.js";
import { GitRepository, GitRunner } from "../git/mod.js";
import {
  createProjectBinding,
  OverleafAuthService,
  type OverleafProject,
} from "../overleaf/mod.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import {
  formatPlan,
  formatStatus,
  writeError,
  writeResult,
} from "./output.js";
import { promptSecret, readSecretFile } from "./secret-input.js";

interface GlobalOptions {
  json?: boolean;
}

function service(): SyncService {
  const secrets = new FileSecretStore();
  const repository = new GitRepository(
    new GitRunner(),
    new ProfileGitCredentials(secrets),
  );
  return new SyncService(repository, new FileBindingStore(), {
    states: new FileStateStore(),
    locks: new FileRepositoryLock(),
  });
}

function authService(): OverleafAuthService {
  return new OverleafAuthService(new FileSecretStore());
}

function result<T>(data: T): OperationResult<T> {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    operationId: randomUUID(),
    status: "ok",
    warnings: [],
    data,
  };
}

function isJson(command: Command): boolean {
  return Boolean(command.optsWithGlobals<GlobalOptions>().json);
}

export function createProgram(): Command {
  const program = new Command()
    .name("overleafy")
    .description(
      "Synchronize a local Git worktree with an Overleaf project.",
    )
    .version("0.1.0")
    .option("--json", "emit one versioned JSON document");

  const auth = program
    .command("auth")
    .description("Manage credential profiles without storing plaintext locally.");

  auth
    .command("set-git-token")
    .description("Store an Overleaf Git token in the operating-system keyring.")
    .option("--profile <name>", "credential profile", "default")
    .action(async (options: { profile: string }, command: Command) => {
      const json = isJson(command);
      try {
        const token = await promptSecret("Overleaf Git token: ");
        await authService().setGitToken(options.profile, token);
        writeResult(
          result({ profile: options.profile, gitTokenStored: true }),
          json,
          (data) => `Stored Git token for profile '${data.profile}'.`,
        );
      } catch (error) {
        writeError(error, json);
        process.exitCode = 8;
      }
    });

  auth
    .command("import-cookie")
    .description(
      "Validate and store a Cookie from an already authenticated browser session.",
    )
    .option("--profile <name>", "credential profile", "default")
    .option("--web-url <url>", "Overleaf web base URL", "https://www.overleaf.com")
    .option(
      "--cookie-file <path>",
      "read Cookie from a regular file with mode 0600",
    )
    .action(
      async (
        options: { profile: string; webUrl: string; cookieFile?: string },
        command: Command,
      ) => {
        const json = isJson(command);
        try {
          const cookie =
            options.cookieFile === undefined
              ? await promptSecret("Overleaf browser Cookie: ")
              : await readSecretFile(options.cookieFile);
          const session = await authService().importCookie(
            options.profile,
            options.webUrl,
            cookie,
          );
          writeResult(
            result({
              profile: session.profile,
              webUrl: session.webUrl,
              sessionValidated: true,
            }),
            json,
            (data) =>
              `Validated browser session for profile '${data.profile}'.`,
          );
        } catch (error) {
          writeError(error, json);
          process.exitCode = 8;
        }
      },
    );

  auth
    .command("status")
    .description("Report whether a profile has Git and browser credentials.")
    .option("--profile <name>", "credential profile", "default")
    .action(async (options: { profile: string }, command: Command) => {
      const json = isJson(command);
      try {
        const status = await authService().status(options.profile);
        writeResult(
          result(status),
          json,
          (data) =>
            [
              `Profile: ${data.profile}`,
              `Git token: ${data.hasGitToken ? "configured" : "missing"}`,
              `Browser Cookie: ${data.hasWebCookie ? "configured" : "missing"}`,
            ].join("\n"),
        );
      } catch (error) {
        writeError(error, json);
        process.exitCode = 8;
      }
    });

  const projects = program
    .command("projects")
    .description("Use a stored browser session to access Overleaf projects.");

  projects
    .command("list")
    .description("List projects visible to the authenticated browser session.")
    .option("--profile <name>", "credential profile", "default")
    .option("--web-url <url>", "Overleaf web base URL", "https://www.overleaf.com")
    .action(
      async (
        options: { profile: string; webUrl: string },
        command: Command,
      ) => {
        const json = isJson(command);
        try {
          const values = await authService().listProjects(
            options.profile,
            options.webUrl,
          );
          writeResult(
            result({ profile: options.profile, projects: values }),
            json,
            (data: { profile: string; projects: OverleafProject[] }) =>
              data.projects.length === 0
                ? "No projects found."
                : data.projects
                    .map((project) => `${project.id}\t${project.name}`)
                    .join("\n"),
          );
        } catch (error) {
          writeError(error, json);
          process.exitCode = 8;
        }
      },
    );

  const conflicts = program
    .command("conflicts")
    .description("Inspect and recover an active synchronization conflict.");

  conflicts
    .command("list")
    .description("List unresolved paths in the active conflict.")
    .option("--repo <path>", "repository path", process.cwd())
    .action(async (options: { repo: string }, command: Command) => {
      const json = isJson(command);
      try {
        const response = await service().conflicts(options.repo);
        writeResult(
          response,
          json,
          (data) =>
            data.files.length === 0
              ? `Operation ${data.operationId}: no unresolved paths.`
              : data.files
                  .map(
                    (file) =>
                      `${file.path}\tstages=${file.stages.join(",")}`,
                  )
                  .join("\n"),
        );
      } catch (error) {
        writeError(error, json);
        process.exitCode = 8;
      }
    });

  conflicts
    .command("resolve")
    .description("Resolve one conflict by choosing the local or remote side.")
    .requiredOption("--path <path>", "exact path returned by conflicts list")
    .addOption(
      new Option("--use <side>", "side to keep")
        .choices(["ours", "theirs"])
        .makeOptionMandatory(),
    )
    .option("--repo <path>", "repository path", process.cwd())
    .action(
      async (
        options: {
          repo: string;
          path: string;
          use: "ours" | "theirs";
        },
        command: Command,
      ) => {
        const json = isJson(command);
        try {
          const response = await service().resolveConflict(
            options.repo,
            options.path,
            options.use,
          );
          writeResult(
            response,
            json,
            (data) =>
              `Resolved '${data.path}' using ${data.resolution}; ${data.remaining.length} conflict(s) remain.`,
          );
        } catch (error) {
          writeError(error, json);
          process.exitCode = 8;
        }
      },
    );

  conflicts
    .command("continue")
    .description("Commit a fully resolved merge and push with the saved lease.")
    .option("--repo <path>", "repository path", process.cwd())
    .action(async (options: { repo: string }, command: Command) => {
      const json = isJson(command);
      try {
        const response = await service().continueConflict(options.repo);
        writeResult(
          response,
          json,
          (data) =>
            `Continued ${data.operationId}; local and remote are ${data.headOid}.`,
        );
      } catch (error) {
        writeError(error, json);
        process.exitCode =
          error instanceof OverleafyError &&
          error.details.code === "CONFLICT"
            ? 6
            : 8;
      }
    });

  conflicts
    .command("abort")
    .description("Abort the active conflict and restore its local backup.")
    .option("--repo <path>", "repository path", process.cwd())
    .action(async (options: { repo: string }, command: Command) => {
      const json = isJson(command);
      try {
        const response = await service().abortConflict(options.repo);
        writeResult(
          response,
          json,
          (data) =>
            `Aborted ${data.operationId}; HEAD is ${data.headOid ?? "unborn"}.`,
        );
      } catch (error) {
        writeError(error, json);
        process.exitCode = 8;
      }
    });

  program
    .command("status")
    .description("Inspect the repository and its cached Overleaf remote state.")
    .option("--repo <path>", "repository path", process.cwd())
    .action(async (options: { repo: string }, command: Command) => {
      const json = isJson(command);
      try {
        const result = await service().status(options.repo);
        writeResult(result, json, formatStatus);
      } catch (error) {
        writeError(error, json);
        process.exitCode = 8;
      }
    });

  program
    .command("plan")
    .description("Fetch the bound Overleaf remote and create a sync plan.")
    .option("--repo <path>", "repository path", process.cwd())
    .addOption(
      new Option("--dirty-policy <policy>", "local dirty worktree policy")
        .choices(["fail", "checkpoint", "stash"])
        .default("fail"),
    )
    .addOption(
      new Option("--rewrite-policy <policy>", "remote rewrite policy")
        .choices(["fail", "remote", "local"])
        .default("fail"),
    )
    .option("--message <message>", "checkpoint commit message")
    .action(
      async (
        options: {
          repo: string;
          dirtyPolicy: DirtyPolicy;
          rewritePolicy: RewritePolicy;
          message?: string;
        },
        command: Command,
      ) => {
        const json = isJson(command);
        try {
          const result = await service().plan(options.repo, {
            dirtyPolicy: options.dirtyPolicy,
            rewritePolicy: options.rewritePolicy,
            ...(options.message === undefined
              ? {}
              : { commitMessage: options.message }),
          });
          writeResult(result, json, formatPlan);
          if (result.data.blockedBy !== undefined) {
            process.exitCode =
              result.data.blockedBy.code === "DIRTY_WORKTREE" ? 7 : 8;
          }
        } catch (error) {
          writeError(error, json);
          process.exitCode = 8;
        }
      },
    );

  program
    .command("config")
    .description("Set Git user identity for this repository (required for commits).")
    .requiredOption("--name <name>", "Git user name")
    .requiredOption("--email <email>", "Git user email")
    .option("--repo <path>", "repository path", process.cwd())
    .action(
      async (
        options: { name: string; email: string; repo: string },
        command: Command,
      ) => {
        const json = isJson(command);
        try {
          const runner = new GitRunner();
          await runner.run(
            ["config", "user.name", options.name],
            { cwd: options.repo },
          );
          await runner.run(
            ["config", "user.email", options.email],
            { cwd: options.repo },
          );
          writeResult(
            result({ name: options.name, email: options.email }),
            json,
            (data) =>
              `Set Git identity: ${data.name} <${data.email}>.`,
          );
        } catch (error) {
          writeError(error, json);
          process.exitCode = 8;
        }
      },
    );

  program
    .command("clone")
    .description(
      "Initialize a new Git repository, bind it to an Overleaf project, and pull any existing content.",
    )
    .argument("[project]", "Overleaf project ID or URL")
    .option("--project <id-or-url>", "Overleaf project ID or URL")
    .option("--dir <path>", "target directory", process.cwd())
    .option("--profile <name>", "credential profile", "default")
    .option("--web-url <url>", "Overleaf web base URL")
    .option("--git-url <url>", "explicit Overleaf Git URL")
    .option("--remote <name>", "Git remote name", "overleaf")
    .option("--remote-branch <name>", "Overleaf branch", "main")
    .action(
      async (
        projectArg: string | undefined,
        options: {
          project?: string;
          dir: string;
          profile: string;
          webUrl?: string;
          gitUrl?: string;
          remote: string;
          remoteBranch: string;
        },
        command: Command,
      ) => {
        const json = isJson(command);
        try {
          const projectId = projectArg ?? options.project;
          if (projectId === undefined) {
            throw new OverleafyError(
              "BINDING_INVALID",
              "A project ID or URL is required.",
              { remediation: "Pass the project ID as the first argument or via --project." },
            );
          }

          // Ensure target directory exists and is empty.
          await mkdir(options.dir, { recursive: true });
          const entries = await readdir(options.dir);
          if (entries.length > 0 && !entries.every((e) => e === ".git")) {
            throw new OverleafyError(
              "BINDING_INVALID",
              `Target directory '${options.dir}' is not empty.`,
              {
                remediation:
                  "Use an empty directory for clone, or run bind in an existing repository.",
              },
            );
          }

          // Initialize git repository.
          const repoService = service();
          const runner = new GitRunner();
          await runner.run(["init"], { cwd: options.dir });
          // Ensure we have a default branch name.
          await runner.run(
            ["symbolic-ref", "HEAD", "refs/heads/main"],
            { cwd: options.dir, allowExitCodes: [0, 128] },
          );

          // Bind.
          const binding = createProjectBinding({
            project: projectId,
            profile: options.profile,
            localBranch: "main",
            remoteBranch: options.remoteBranch,
            remoteName: options.remote,
            ...(options.webUrl === undefined
              ? {}
              : { webUrl: options.webUrl }),
            ...(options.gitUrl === undefined
              ? {}
              : { gitUrl: options.gitUrl }),
          });
          const plan = await repoService.planBinding(options.dir, binding);
          const applied = await repoService.applyBinding(
            options.dir,
            binding,
            plan.data.planId,
          );
          writeResult(
            applied,
            json,
            (data) =>
              `Cloned ${data.projectId} to '${options.dir}' (remote: ${data.remoteName}/${options.remoteBranch}).`,
          );

          // Try to pull Git content. Fall back to ZIP download if remote is empty.
          let pulled = false;
          try {
            const pullPlan = await repoService.plan(options.dir, {
              dirtyPolicy: "fail",
              rewritePolicy: "fail",
              direction: "pull",
            });
            if (pullPlan.data.actions.length > 0) {
              const result = await repoService.apply(
                options.dir,
                pullPlan.data.planId,
                { dirtyPolicy: "fail", rewritePolicy: "fail", confirmation: false, direction: "pull" },
              );
              if (result.data.appliedActions.length > 0) {
                pulled = true;
                process.stderr.write(
                  `Pulled ${result.data.appliedActions.length} commit(s) from Overleaf.\n`,
                );
              }
            }
          } catch {
            // Remote may be empty.
          }

          // If no Git content, try downloading the ZIP from Overleaf web.
          if (!pulled) {
            try {
              const webUrl = options.webUrl ?? "https://www.overleaf.com";
              const zip = await authService().downloadZip(
                options.profile,
                webUrl,
                applied.data.projectId,
              );
              const tmpDir = await mkdtemp("/tmp/overleafy-zip-XXXXXX");
              const zipPath = `${tmpDir}/project.zip`;
              await writeFile(zipPath, zip);
              const { execFileSync } = await import("node:child_process");
              execFileSync("unzip", ["-q", "-o", zipPath, "-d", options.dir], {
                stdio: "ignore",
              });
              await rm(tmpDir, { recursive: true, force: true });
              process.stderr.write("Downloaded project ZIP from Overleaf.\n");
              pulled = true;
            } catch {
              // ZIP download is best-effort.
            }
          }
        } catch (error) {
          writeError(error, json);
          process.exitCode = 8;
        }
      },
    );

  program
    .command("bind")
    .description(
      "Bind the repository to an Overleaf project. Plans and applies automatically; use --plan-id to apply a pre-reviewed plan.",
    )
    .requiredOption("--project <id-or-url>", "Overleaf project ID or URL")
    .option("--repo <path>", "repository path", process.cwd())
    .option("--project-name <name>", "human-readable project name")
    .option("--profile <name>", "credential profile", "default")
    .option("--web-url <url>", "Overleaf web base URL")
    .option("--git-url <url>", "explicit Overleaf Git URL")
    .option("--remote <name>", "Git remote name", "overleaf")
    .option("--local-branch <name>", "local branch; defaults to current branch")
    .option("--remote-branch <name>", "Overleaf branch", "main")
    .option("--plan-id <id>", "exact binding plan ID to apply")
    .option("--plan-only", "only generate and display the binding plan without applying")
    .action(
      async (
        options: {
          project: string;
          repo: string;
          projectName?: string;
          profile: string;
          webUrl?: string;
          gitUrl?: string;
          remote: string;
          localBranch?: string;
          remoteBranch: string;
          planId?: string;
          planOnly?: boolean;
        },
        command: Command,
      ) => {
        const json = isJson(command);
        try {
          const syncService = service();
          const current = await syncService.status(options.repo);
          const localBranch =
            options.localBranch ?? current.data.snapshot.branch;
          if (localBranch === null) {
            throw new OverleafyError(
              "BINDING_INVALID",
              "Cannot bind a detached HEAD without --local-branch.",
            );
          }
          const binding = createProjectBinding({
            project: options.project,
            profile: options.profile,
            localBranch,
            remoteBranch: options.remoteBranch,
            remoteName: options.remote,
            ...(options.projectName === undefined
              ? {}
              : { projectName: options.projectName }),
            ...(options.webUrl === undefined
              ? {}
              : { webUrl: options.webUrl }),
            ...(options.gitUrl === undefined
              ? {}
              : { gitUrl: options.gitUrl }),
          });
          if (options.planId !== undefined) {
            // Explicit plan ID: apply a pre-reviewed binding plan
            const applied = await syncService.applyBinding(
              options.repo,
              binding,
              options.planId,
            );
            writeResult(
              applied,
              json,
              (data) =>
                `${data.alreadyBound ? "Already bound" : "Bound"} ${data.projectId} to remote '${data.remoteName}' (${data.remoteBranch}).`,
            );
          } else if (options.planOnly) {
            // Review mode: only generate the plan, print planId for later apply
            const planned = await syncService.planBinding(
              options.repo,
              binding,
            );
            writeResult(
              planned,
              json,
              (data) =>
                [
                  `Binding plan: ${data.planId}`,
                  `Project: ${data.binding.projectId}`,
                  `Remote: ${data.binding.remoteName} (${data.binding.remoteBranch})`,
                  `Actions: ${data.actions.join(", ") || "none"}`,
                  "",
                  `To apply: overleafy bind --project ${data.binding.projectId} --plan-id ${data.planId}`,
                ].join("\n"),
            );
          } else {
            // Direct bind: plan internally and apply immediately
            const planned = await syncService.planBinding(
              options.repo,
              binding,
            );
            const applied = await syncService.applyBinding(
              options.repo,
              binding,
              planned.data.planId,
            );
            writeResult(
              applied,
              json,
              (data) =>
                `${data.alreadyBound ? "Already bound" : "Bound"} ${data.projectId} to remote '${data.remoteName}' (${data.remoteBranch}).`,
            );
          }
        } catch (error) {
          writeError(error, json);
          process.exitCode = 8;
        }
      },
    );

  program
    .command("unbind")
    .description(
      "Remove the Overleaf binding from this repository. Plans and applies automatically; use --plan-id to apply a pre-reviewed plan.",
    )
    .option("--repo <path>", "repository path", process.cwd())
    .option("--plan-id <id>", "exact unbind plan ID to apply")
    .option("--plan-only", "only generate and display the unbind plan without applying")
    .action(
      async (
        options: { repo: string; planId?: string; planOnly?: boolean },
        command: Command,
      ) => {
        const json = isJson(command);
        try {
          if (options.planId !== undefined) {
            const applied = await service().applyUnbind(
              options.repo,
              options.planId,
            );
            writeResult(
              applied,
              json,
              (data) =>
                `${data.remoteRemoved ? "Removed" : "No"} remote '${data.remoteName}'. ${data.configDeleted ? "Deleted" : "No"} binding config.`,
            );
          } else if (options.planOnly) {
            const planned = await service().planUnbind(options.repo);
            writeResult(
              planned,
              json,
              (data) =>
                [
                  `Unbind plan: ${data.planId}`,
                  `Project: ${data.projectId}`,
                  `Remote: ${data.remoteName}`,
                  `Actions: ${data.actions.join(", ") || "none"}`,
                  "",
                  `To apply: overleafy unbind --plan-id ${data.planId}`,
                ].join("\n"),
            );
          } else {
            const planned = await service().planUnbind(options.repo);
            const applied = await service().applyUnbind(
              options.repo,
              planned.data.planId,
            );
            writeResult(
              applied,
              json,
              (data) =>
                `${data.remoteRemoved ? "Removed" : "No"} remote '${data.remoteName}'. ${data.configDeleted ? "Deleted" : "No"} binding config.`,
            );
          }
        } catch (error) {
          writeError(error, json);
          process.exitCode = 8;
        }
      },
    );

  program
    .command("pull")
    .description("Fetch and merge Overleaf changes into the local repository.")
    .option("--repo <path>", "repository path", process.cwd())
    .action(async (options: { repo: string }, command: Command) => {
      const json = isJson(command);
      try {
        const svc = service();
        const plan = await svc.plan(options.repo, {
          dirtyPolicy: "checkpoint",
          rewritePolicy: "fail",
          direction: "pull",
        });
        const result = await svc.apply(options.repo, plan.data.planId, {
          dirtyPolicy: "checkpoint",
          rewritePolicy: "fail",
          confirmation: false,
          direction: "pull",
        });
        writeResult(
          result,
          json,
          (data) =>
            data.appliedActions.length === 0
              ? "Already up to date."
              : `Pulled ${data.headOid ?? "unborn"} (${data.appliedActions.join(", ")}).`,
        );
      } catch (error) {
        writeError(error, json);
        process.exitCode = 8;
      }
    });

  program
    .command("push")
    .description("Push local commits to Overleaf.")
    .option("--repo <path>", "repository path", process.cwd())
    .action(async (options: { repo: string }, command: Command) => {
      const json = isJson(command);
      try {
        const svc = service();
        const plan = await svc.plan(options.repo, {
          dirtyPolicy: "checkpoint",
          rewritePolicy: "fail",
          direction: "push",
        });
        const result = await svc.apply(options.repo, plan.data.planId, {
          dirtyPolicy: "checkpoint",
          rewritePolicy: "fail",
          confirmation: false,
          direction: "push",
        });
        writeResult(
          result,
          json,
          (data) =>
            data.appliedActions.length === 0
              ? "No local commits to push."
              : `Pushed ${data.headOid ?? "unborn"} (${data.appliedActions.join(", ")}).`,
        );
      } catch (error) {
        writeError(error, json);
        process.exitCode = 8;
      }
    });

  program
    .command("sync")
    .description("Synchronize the local repository with Overleaf.")
    .option("--repo <path>", "repository path", process.cwd())
    .option("--plan-id <id>", "exact plan ID returned by plan (optional; auto-plans if omitted)")
    .addOption(
      new Option("--dirty-policy <policy>", "local dirty worktree policy")
        .choices(["fail", "checkpoint", "stash"])
        .default("checkpoint"),
    )
    .addOption(
      new Option("--rewrite-policy <policy>", "remote rewrite policy")
        .choices(["fail", "remote", "local"])
        .default("fail"),
    )
    .option("--message <message>", "checkpoint commit message")
    .option(
      "--confirm-rewrite",
      "confirm the reviewed remote history rewrite actions",
    )
    .action(
      async (
        options: {
          planId?: string;
          repo: string;
          dirtyPolicy: DirtyPolicy;
          rewritePolicy: RewritePolicy;
          message?: string;
          confirmRewrite?: boolean;
        },
        command: Command,
      ) => {
        const json = isJson(command);
        try {
          const svc = service();
          const applyOptions = {
            dirtyPolicy: options.dirtyPolicy,
            rewritePolicy: options.rewritePolicy,
            confirmation: options.confirmRewrite ?? false,
            ...(options.message === undefined
              ? {}
              : { commitMessage: options.message }),
          };

          if (options.planId) {
            // Two-step: apply a pre-reviewed plan
            const result = await svc.apply(
              options.repo,
              options.planId,
              applyOptions,
            );
            writeResult(
              result,
              json,
              (data) =>
                `Synchronized ${data.headOid ?? "unborn"} (${data.appliedActions.join(", ") || "no changes"}).`,
            );
          } else {
            // Direct sync: plan internally and apply immediately
            const plan = await svc.plan(options.repo, applyOptions);
            const result = await svc.apply(
              options.repo,
              plan.data.planId,
              { ...applyOptions, confirmation: plan.data.requiresConfirmation || applyOptions.confirmation },
            );
            writeResult(
              result,
              json,
              (data) =>
                `Synchronized ${data.headOid ?? "unborn"} (${data.appliedActions.join(", ") || "no changes"}).`,
            );
          }
        } catch (error) {
          writeError(error, json);
          const code =
            error instanceof OverleafyError ? error.details.code : "INTERNAL";
          process.exitCode =
            code === "CONFLICT"
              ? 6
              : code === "PLAN_STALE" || code === "REMOTE_MOVED"
                ? 5
                : 8;
        }
      },
    );

  return program;
}
