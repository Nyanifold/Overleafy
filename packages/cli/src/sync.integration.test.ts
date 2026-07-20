import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FileBindingStore,
  FileRepositoryLock,
  FileStateStore,
} from "@nyanifold/config";
import {
  OverleafyError,
  SyncService,
  type ProjectBinding,
} from "@nyanifold/core";
import { GitRepository, GitRunner } from "@nyanifold/git";

const runner = new GitRunner();

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runner.run(args, { cwd })).stdout.trim();
}

async function createFixture(): Promise<{
  root: string;
  remote: string;
  binding: ProjectBinding;
  service: SyncService;
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "overleafy-"));
  const root = path.join(parent, "local");
  const remote = path.join(parent, "overleaf.git");
  await git(parent, ["init", "--bare", remote]);
  await git(parent, ["init", "-b", "main", root]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(root, "main.tex"), "initial\n");
  await git(root, ["add", "main.tex"]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["remote", "add", "seed", remote]);
  await git(root, ["push", "seed", "HEAD:master"]);
  await git(root, ["remote", "remove", "seed"]);
  await git(remote, ["symbolic-ref", "HEAD", "refs/heads/master"]);

  const binding: ProjectBinding = {
    schemaVersion: 1,
    profile: "default",
    projectId: "0123456789abcdef01234567",
    projectName: "Paper",
    webUrl: "https://www.overleaf.com",
    gitUrl: `file://${remote}`,
    remoteName: "overleaf",
    localBranch: "main",
    remoteBranch: "master",
    sync: {
      mergeStrategy: "merge",
      include: ["**"],
      exclude: [".git/**", ".overleafy/**"],
      quietPeriodMs: 2_000,
    },
  };
  const service = new SyncService(
    new GitRepository(),
    new FileBindingStore(),
    {
      states: new FileStateStore(),
      locks: new FileRepositoryLock(),
    },
  );
  await service.bind(root, binding);
  return { root, remote, binding, service };
}

async function createDivergence(): Promise<
  Awaited<ReturnType<typeof createFixture>>
> {
  const fixture = await createFixture();
  const { root, remote } = fixture;
  await writeFile(path.join(root, "main.tex"), "local version\n");
  await git(root, ["add", "main.tex"]);
  await git(root, ["commit", "-m", "local edit"]);

  const webEditor = path.join(path.dirname(root), "web-editor-conflict");
  await git(path.dirname(root), ["clone", remote, webEditor]);
  await git(webEditor, ["config", "user.name", "Web User"]);
  await git(webEditor, ["config", "user.email", "web@example.com"]);
  await writeFile(path.join(webEditor, "main.tex"), "overleaf version\n");
  await git(webEditor, ["add", "main.tex"]);
  await git(webEditor, ["commit", "-m", "Overleaf edit"]);
  await git(webEditor, ["push", "origin", "master"]);
  return fixture;
}

test("applies an equal clean plan as a verified no-op", async () => {
  const { root, service } = await createFixture();
  const plan = await service.plan(root, {
    dirtyPolicy: "fail",
    rewritePolicy: "fail",
  });
  assert.equal(plan.data.classification, "equal_clean");

  const result = await service.apply(root, plan.data.planId, {
    dirtyPolicy: "fail",
    rewritePolicy: "fail",
  });
  assert.equal(result.status, "noop");
  assert.equal(result.data.headOid, result.data.remoteOid);
});

test("applies a reviewed binding plan and treats repetition as a no-op", async () => {
  const { root, binding, service } = await createFixture();
  await rm(path.join(root, ".overleafy", "config.json"));

  const plan = await service.planBinding(root, binding);
  assert.deepEqual(plan.data.actions, [
    "add_or_validate_remote",
    "write_binding",
  ]);
  const applied = await service.applyBinding(root, binding, plan.data.planId);
  assert.equal(applied.data.alreadyBound, false);

  const repeatedPlan = await service.planBinding(root, binding);
  assert.equal(repeatedPlan.data.alreadyBound, true);
  const repeated = await service.applyBinding(
    root,
    binding,
    repeatedPlan.data.planId,
  );
  assert.equal(repeated.status, "noop");
});

test("checkpoints a dirty worktree and pushes with remote verification", async () => {
  const { root, remote, service } = await createFixture();
  await writeFile(path.join(root, "main.tex"), "local update\n");
  const options = {
    dirtyPolicy: "checkpoint" as const,
    rewritePolicy: "fail" as const,
    commitMessage: "Update from agent",
  };
  const plan = await service.plan(root, options);
  assert.deepEqual(
    plan.data.actions.map((action) => action.type),
    ["checkpoint", "push"],
  );

  const result = await service.apply(root, plan.data.planId, options);
  assert.equal(result.data.headOid, result.data.remoteOid);
  assert.equal(await git(root, ["status", "--porcelain"]), "");
  assert.equal(
    await git(remote, ["show", "master:main.tex"]),
    "local update",
  );
});

test("fast-forwards a clean local branch after a remote edit", async () => {
  const { root, remote, service } = await createFixture();
  const collaborator = path.join(path.dirname(root), "web-editor");
  await git(path.dirname(root), ["clone", remote, collaborator]);
  await git(collaborator, ["config", "user.name", "Web User"]);
  await git(collaborator, ["config", "user.email", "web@example.com"]);
  await writeFile(path.join(collaborator, "remote.tex"), "remote update\n");
  await git(collaborator, ["add", "remote.tex"]);
  await git(collaborator, ["commit", "-m", "web edit"]);
  await git(collaborator, ["push", "origin", "master"]);

  const options = {
    dirtyPolicy: "fail" as const,
    rewritePolicy: "fail" as const,
  };
  const plan = await service.plan(root, options);
  assert.equal(plan.data.classification, "remote_ahead");
  const result = await service.apply(root, plan.data.planId, options);
  assert.equal(result.data.headOid, result.data.remoteOid);
  assert.equal(
    await readFile(path.join(root, "remote.tex"), "utf8"),
    "remote update\n",
  );
});

test("rejects a stale plan before creating a commit", async () => {
  const { root, service } = await createFixture();
  await writeFile(path.join(root, "main.tex"), "first update\n");
  const options = {
    dirtyPolicy: "checkpoint" as const,
    rewritePolicy: "fail" as const,
    commitMessage: "Update",
  };
  const plan = await service.plan(root, options);
  await writeFile(path.join(root, "main.tex"), "second update\n");

  await assert.rejects(
    service.apply(root, plan.data.planId, options),
    (error: unknown) =>
      error instanceof OverleafyError &&
      error.details.code === "PLAN_STALE",
  );
  assert.equal(await git(root, ["log", "-1", "--format=%s"]), "initial");
});

test("refuses to sync a branch other than the bound local branch", async () => {
  const { root, service } = await createFixture();
  await git(root, ["checkout", "-b", "other"]);
  await assert.rejects(
    service.plan(root, {
      dirtyPolicy: "fail",
      rewritePolicy: "fail",
    }),
    (error: unknown) =>
      error instanceof OverleafyError &&
      error.details.code === "BINDING_INVALID",
  );
});

test("resolves and continues a conflicting two-way merge", async () => {
  const { root, remote, service } = await createDivergence();
  const options = {
    dirtyPolicy: "fail" as const,
    rewritePolicy: "fail" as const,
  };
  const plan = await service.plan(root, options);
  assert.equal(plan.data.classification, "diverged");

  await assert.rejects(
    service.apply(root, plan.data.planId, options),
    (error: unknown) =>
      error instanceof OverleafyError &&
      error.details.code === "CONFLICT",
  );
  const conflicts = await service.conflicts(root);
  assert.deepEqual(conflicts.data.files, [
    { path: "main.tex", stages: [1, 2, 3] },
  ]);

  const resolved = await service.resolveConflict(root, "main.tex", "ours");
  assert.deepEqual(resolved.data.remaining, []);
  const continued = await service.continueConflict(root);
  assert.equal(continued.data.headOid, continued.data.remoteOid);
  assert.equal(await git(remote, ["show", "master:main.tex"]), "local version");
  assert.equal((await service.status(root)).data.activeOperation, undefined);
});

test("aborts a conflicting merge and restores the local backup", async () => {
  const { root, remote, service } = await createDivergence();
  const localBefore = await git(root, ["rev-parse", "HEAD"]);
  const remoteBefore = await git(remote, ["rev-parse", "master"]);
  const options = {
    dirtyPolicy: "fail" as const,
    rewritePolicy: "fail" as const,
  };
  const plan = await service.plan(root, options);
  await assert.rejects(service.apply(root, plan.data.planId, options));

  const aborted = await service.abortConflict(root);
  assert.equal(aborted.data.headOid, localBefore);
  assert.equal(await git(root, ["rev-parse", "HEAD"]), localBefore);
  assert.equal(await git(remote, ["rev-parse", "master"]), remoteBefore);
  assert.equal(await git(root, ["status", "--porcelain"]), "");
  assert.equal((await service.status(root)).data.activeOperation, undefined);
});

test("blocks a restored remote history by default and accepts it explicitly", async () => {
  const { root, remote, service } = await createFixture();
  const initialPlan = await service.plan(root, {
    dirtyPolicy: "fail",
    rewritePolicy: "fail",
  });
  await service.apply(root, initialPlan.data.planId, {
    dirtyPolicy: "fail",
    rewritePolicy: "fail",
  });

  const webEditor = path.join(path.dirname(root), "web-editor-restore");
  await git(path.dirname(root), ["clone", remote, webEditor]);
  await git(webEditor, ["config", "user.name", "Web User"]);
  await git(webEditor, ["config", "user.email", "web@example.com"]);
  await git(webEditor, ["checkout", "--orphan", "restored"]);
  await git(webEditor, ["rm", "-rf", "."]);
  await writeFile(path.join(webEditor, "main.tex"), "restored history\n");
  await git(webEditor, ["add", "main.tex"]);
  await git(webEditor, ["commit", "-m", "restore project history"]);
  await git(webEditor, ["push", "--force", "origin", "HEAD:master"]);

  const blocked = await service.plan(root, {
    dirtyPolicy: "fail",
    rewritePolicy: "fail",
  });
  assert.equal(blocked.data.classification, "remote_rewritten");
  assert.equal(blocked.data.blockedBy?.code, "REMOTE_REWRITTEN");

  const options = {
    dirtyPolicy: "fail" as const,
    rewritePolicy: "remote" as const,
    confirmation: true,
  };
  const accepted = await service.plan(root, options);
  assert.deepEqual(
    accepted.data.actions.map((action) => action.type),
    ["create_backup_ref", "reset_to_remote"],
  );
  const result = await service.apply(root, accepted.data.planId, options);
  assert.equal(result.data.headOid, result.data.remoteOid);
  assert.equal(await readFile(path.join(root, "main.tex"), "utf8"), "restored history\n");
});
