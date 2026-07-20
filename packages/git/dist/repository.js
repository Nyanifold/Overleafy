import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, appendFile, lstat, mkdir, readFile, readlink, } from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import { OverleafyError, sha256, } from "@nyanifold/core";
import { withGitAskpass } from "./askpass.js";
import { GitRunner } from "./runner.js";
import { parsePorcelainV2 } from "./status-parser.js";
const EMPTY_WORKTREE = {
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
};
async function exists(filePath) {
    try {
        await access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
function urlsEqual(left, right) {
    const normalize = (raw) => {
        try {
            const url = new URL(raw);
            url.username = "";
            url.password = "";
            return url.toString().replace(/\/$/, "");
        }
        catch {
            return raw.replace(/\/$/, "");
        }
    };
    return normalize(left) === normalize(right);
}
export class GitRepository {
    runner;
    credentials;
    constructor(runner = new GitRunner(), credentials) {
        this.runner = runner;
        this.credentials = credentials;
    }
    async inspect(repositoryPath, binding, options) {
        const root = await this.resolveRoot(repositoryPath);
        if (binding !== undefined) {
            await this.assertBoundRemote(root, binding);
            if (options.fetch) {
                await this.fetch(root, binding);
            }
        }
        const snapshot = await this.snapshot(root, binding);
        const relationship = await this.relationship(root, snapshot);
        const remoteRewritten = options.lastRemoteOid !== undefined &&
            snapshot.remoteOid !== null &&
            options.lastRemoteOid !== snapshot.remoteOid &&
            !(await this.isAncestor(root, options.lastRemoteOid, snapshot.remoteOid));
        return {
            snapshot,
            relationship,
            remoteRewritten,
            ...(options.lastRemoteOid === undefined
                ? {}
                : { lastRemoteOid: options.lastRemoteOid }),
        };
    }
    async bind(repositoryPath, binding) {
        const root = await this.resolveRoot(repositoryPath);
        const current = await this.runner.run(["remote", "get-url", binding.remoteName], {
            cwd: root,
            allowExitCodes: [0, 2],
        });
        if (current.exitCode === 0) {
            const currentUrl = current.stdout.trim();
            this.assertCredentialFreeUrl(currentUrl, binding.remoteName);
            if (!urlsEqual(currentUrl, binding.gitUrl)) {
                throw new OverleafyError("BINDING_INVALID", `Remote '${binding.remoteName}' already points to a different URL.`, {
                    remediation: "Choose another remote name or update the existing remote explicitly.",
                    details: {
                        remoteName: binding.remoteName,
                        currentUrl: this.redactUrl(currentUrl),
                    },
                });
            }
        }
        else {
            await this.runner.run(["remote", "add", binding.remoteName, binding.gitUrl], { cwd: root });
        }
        await this.ensureLocalExclude(root);
        return root;
    }
    async unbind(repositoryPath, remoteName) {
        const root = await this.resolveRoot(repositoryPath);
        await this.runner.run(["remote", "remove", remoteName], { cwd: root, allowExitCodes: [0, 128] });
    }
    async apply(repositoryPath, binding, plan, operationId) {
        const root = await this.resolveRoot(repositoryPath);
        await this.assertBoundRemote(root, binding);
        const emptyHooks = path.join(root, ".overleafy", "empty-hooks");
        await mkdir(emptyHooks, { recursive: true, mode: 0o700 });
        const hooksConfig = ["-c", `core.hooksPath=${emptyHooks}`];
        for (const action of plan.actions) {
            switch (action.type) {
                case "checkpoint":
                    if (action.paths.length === 0) {
                        break;
                    }
                    await this.runner.run(["add", "-A", "--", ...action.paths], {
                        cwd: root,
                    });
                    {
                        const staged = await this.runner.run(["diff", "--cached", "--quiet"], { cwd: root, allowExitCodes: [0, 1] });
                        if (staged.exitCode === 1) {
                            await this.runner.run([...hooksConfig, "commit", "-m", action.message ?? "Checkpoint"], { cwd: root });
                        }
                    }
                    break;
                case "create_backup_ref":
                    await this.createBackupRefs(root, plan, operationId, action.target);
                    break;
                case "fast_forward":
                    await this.runner.run(["merge", "--ff-only", action.oid], {
                        cwd: root,
                    });
                    break;
                case "merge":
                    try {
                        await this.runner.run([...hooksConfig, "merge", "--no-edit", action.oid], { cwd: root });
                    }
                    catch (error) {
                        const status = await this.runner.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: root });
                        if (parsePorcelainV2(status.stdout).conflicted.length > 0) {
                            throw new OverleafyError("CONFLICT", "The merge stopped with unresolved conflicts.", {
                                remediation: "List and resolve conflicts, then continue the active operation.",
                                cause: error,
                            });
                        }
                        throw error;
                    }
                    break;
                case "push":
                    await this.withAuthentication(binding, async (env) => {
                        await this.verifyRemoteLease(root, binding, action.expectedRemoteOid, env);
                        await this.runner.run([
                            "push",
                            binding.remoteName,
                            `HEAD:refs/heads/${binding.remoteBranch}`,
                        ], { cwd: root, timeoutMs: 60_000, env });
                    });
                    break;
                case "reset_to_remote":
                    await this.runner.run(["reset", "--hard", action.oid], {
                        cwd: root,
                    });
                    break;
                case "force_push_with_lease":
                    await this.withAuthentication(binding, async (env) => {
                        await this.verifyRemoteLease(root, binding, action.expectedRemoteOid, env);
                        await this.runner.run([
                            "push",
                            `--force-with-lease=refs/heads/${binding.remoteBranch}:${action.expectedRemoteOid}`,
                            binding.remoteName,
                            `HEAD:refs/heads/${binding.remoteBranch}`,
                        ], { cwd: root, timeoutMs: 60_000, env });
                    });
                    break;
            }
        }
    }
    async listConflicts(repositoryPath) {
        const root = await this.resolveRoot(repositoryPath);
        const result = await this.runner.run(["ls-files", "-u", "-z"], {
            cwd: root,
        });
        const files = new Map();
        for (const record of result.stdout.split("\0")) {
            if (record === "") {
                continue;
            }
            const match = /^\d+\s+[0-9a-f]+\s+([123])\t([\s\S]+)$/.exec(record);
            if (match === null) {
                throw new OverleafyError("GIT_FAILED", "Git returned an invalid unmerged-index record.");
            }
            const stage = Number(match[1]);
            const filePath = match[2];
            if (filePath === undefined) {
                continue;
            }
            const stages = files.get(filePath) ?? new Set();
            stages.add(stage);
            files.set(filePath, stages);
        }
        return [...files]
            .map(([filePath, stages]) => ({
            path: filePath,
            stages: [...stages].sort(),
        }))
            .sort((left, right) => left.path.localeCompare(right.path));
    }
    async resolveConflict(repositoryPath, filePath, resolution) {
        const root = await this.resolveRoot(repositoryPath);
        const conflict = (await this.listConflicts(root)).find((file) => file.path === filePath);
        if (conflict === undefined) {
            throw new OverleafyError("CONFLICT", `Path '${filePath}' is not an unresolved conflict.`, { remediation: "List conflicts again and use an exact returned path." });
        }
        const stage = resolution === "ours" ? 2 : 3;
        if (conflict.stages.includes(stage)) {
            await this.runner.run(["checkout", `--${resolution}`, "--", filePath], {
                cwd: root,
            });
            await this.runner.run(["add", "--", filePath], { cwd: root });
        }
        else {
            await this.runner.run(["rm", "--ignore-unmatch", "--", filePath], {
                cwd: root,
            });
        }
    }
    async continueConflict(repositoryPath, binding, mergeTargetOid, expectedRemoteOid) {
        const root = await this.resolveRoot(repositoryPath);
        await this.assertBoundRemote(root, binding);
        const conflicts = await this.listConflicts(root);
        if (conflicts.length > 0) {
            throw new OverleafyError("CONFLICT", `${conflicts.length} path(s) still have unresolved conflicts.`, { remediation: "Resolve every listed conflict before continuing." });
        }
        const gitDir = (await this.runner.run(["rev-parse", "--absolute-git-dir"], { cwd: root })).stdout.trim();
        const operation = await this.operation(gitDir);
        if (operation === "merge") {
            const emptyHooks = path.join(root, ".overleafy", "empty-hooks");
            await mkdir(emptyHooks, { recursive: true, mode: 0o700 });
            await this.runner.run(["-c", `core.hooksPath=${emptyHooks}`, "commit", "--no-edit"], { cwd: root });
        }
        else if (operation !== "none") {
            throw new OverleafyError("OPERATION_IN_PROGRESS", `Cannot continue a sync conflict during Git ${operation}.`);
        }
        const headOid = await this.optionalRevParse(root, "HEAD");
        if (headOid === null ||
            !(await this.isAncestor(root, mergeTargetOid, headOid))) {
            throw new OverleafyError("OPERATION_IN_PROGRESS", "HEAD no longer contains the merge target from the active sync.", {
                remediation: "Abort the active sync or restore its merge before continuing.",
            });
        }
        await this.withAuthentication(binding, async (env) => {
            const actualRemoteOid = await this.readRemoteOid(root, binding, env);
            if (actualRemoteOid === headOid) {
                return;
            }
            if (actualRemoteOid !== expectedRemoteOid) {
                throw this.remoteMoved(expectedRemoteOid, actualRemoteOid);
            }
            await this.runner.run([
                "push",
                binding.remoteName,
                `HEAD:refs/heads/${binding.remoteBranch}`,
            ], { cwd: root, timeoutMs: 60_000, env });
        });
    }
    async abortConflict(repositoryPath, operationId) {
        const root = await this.resolveRoot(repositoryPath);
        const gitDir = (await this.runner.run(["rev-parse", "--absolute-git-dir"], { cwd: root })).stdout.trim();
        const operation = await this.operation(gitDir);
        if (operation === "merge") {
            await this.runner.run(["merge", "--abort"], { cwd: root });
            return;
        }
        if (operation !== "none") {
            throw new OverleafyError("OPERATION_IN_PROGRESS", `Cannot abort a sync conflict during Git ${operation}.`);
        }
        const backupRef = `refs/overleafy/backup/${operationId}/local`;
        const backupOid = await this.optionalRevParse(root, backupRef);
        if (backupOid === null) {
            throw new OverleafyError("GIT_FAILED", "The local backup ref for this active operation is missing.", {
                remediation: "Inspect the repository manually before clearing sync state.",
                details: { backupRef },
            });
        }
        await this.runner.run(["reset", "--hard", backupOid], { cwd: root });
    }
    async resolveRoot(repositoryPath) {
        try {
            const result = await this.runner.run(["rev-parse", "--show-toplevel"], { cwd: path.resolve(repositoryPath) });
            return result.stdout.trim();
        }
        catch (error) {
            throw new OverleafyError("REPO_NOT_FOUND", `Not a Git worktree: ${path.resolve(repositoryPath)}`, {
                remediation: "Run the command inside a non-bare Git worktree.",
                cause: error,
            });
        }
    }
    async fetch(root, binding) {
        await this.withAuthentication(binding, async (env) => {
            try {
                await this.runner.run([
                    "fetch",
                    "--no-tags",
                    binding.remoteName,
                    `+refs/heads/${binding.remoteBranch}:refs/remotes/${binding.remoteName}/${binding.remoteBranch}`,
                ], { cwd: root, timeoutMs: 60_000, env });
            }
            catch (error) {
                if (error instanceof Error &&
                    error.message.includes("couldn't find remote ref")) {
                    // Remote branch doesn't exist yet — treat as unborn.
                    return;
                }
                throw error;
            }
        });
    }
    async optionalRevParse(root, revision) {
        const result = await this.runner.run(["rev-parse", "--verify", "--quiet", revision], { cwd: root, allowExitCodes: [0, 1] });
        return result.exitCode === 0 ? result.stdout.trim() : null;
    }
    async snapshot(root, binding) {
        const gitDir = (await this.runner.run(["rev-parse", "--absolute-git-dir"], { cwd: root })).stdout.trim();
        const branchResult = await this.runner.run(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, allowExitCodes: [0, 1] });
        const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
        const headOid = await this.optionalRevParse(root, "HEAD");
        const status = await this.runner.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: root });
        const worktree = this.filterWorktree(parsePorcelainV2(status.stdout), binding);
        const operation = await this.operation(gitDir);
        const remoteOid = binding === undefined
            ? null
            : await this.optionalRevParse(root, `refs/remotes/${binding.remoteName}/${binding.remoteBranch}`);
        const worktreeFingerprint = await this.fingerprintWorktree(root, headOid, branch, operation, worktree, binding);
        return {
            repositoryPath: root,
            gitDir,
            branch,
            headOid,
            remoteName: binding?.remoteName ?? null,
            remoteBranch: binding?.remoteBranch ?? null,
            remoteOid,
            operation,
            worktree: worktree ?? EMPTY_WORKTREE,
            worktreeFingerprint,
        };
    }
    async operation(gitDir) {
        if (await exists(path.join(gitDir, "MERGE_HEAD"))) {
            return "merge";
        }
        if ((await exists(path.join(gitDir, "rebase-merge"))) ||
            (await exists(path.join(gitDir, "rebase-apply")))) {
            return "rebase";
        }
        if (await exists(path.join(gitDir, "CHERRY_PICK_HEAD"))) {
            return "cherry-pick";
        }
        if (await exists(path.join(gitDir, "REVERT_HEAD"))) {
            return "revert";
        }
        if (await exists(path.join(gitDir, "BISECT_LOG"))) {
            return "bisect";
        }
        return "none";
    }
    filterWorktree(worktree, binding) {
        const includes = binding?.sync.include ?? ["**"];
        const excludes = [
            ".git/**",
            ".overleafy/**",
            ...(binding?.sync.exclude ?? []),
        ];
        const matches = (filePath) => {
            const options = { dot: true, matchBase: false };
            const included = includes.some((pattern) => minimatch(filePath, pattern, options));
            const excluded = excludes.some((pattern) => minimatch(filePath, pattern, options));
            return included && !excluded;
        };
        const partition = (paths) => {
            const inScope = [];
            const outOfScope = [];
            for (const filePath of paths) {
                (matches(filePath) ? inScope : outOfScope).push(filePath);
            }
            return [inScope, outOfScope];
        };
        const [staged, stagedOutOfScope] = partition(worktree.staged);
        const [unstaged, unstagedOutOfScope] = partition(worktree.unstaged);
        const [, conflictedOutOfScope] = partition(worktree.conflicted);
        const untracked = worktree.untracked.filter(matches);
        const outOfScope = [
            ...new Set([
                ...stagedOutOfScope,
                ...unstagedOutOfScope,
                ...conflictedOutOfScope,
            ]),
        ].sort();
        return {
            staged,
            unstaged,
            untracked,
            conflicted: worktree.conflicted,
            ...(outOfScope.length === 0 ? {} : { outOfScope }),
        };
    }
    async fingerprintWorktree(root, headOid, branch, operation, worktree, binding) {
        const index = await this.runner.run(["ls-files", "--stage", "-z"], {
            cwd: root,
        });
        const changedWorktreePaths = [
            ...new Set([
                ...worktree.unstaged,
                ...worktree.untracked,
                ...worktree.conflicted,
                ...(worktree.outOfScope ?? []),
            ]),
        ].sort();
        const worktreeContent = [];
        for (const relativePath of changedWorktreePaths) {
            const absolutePath = path.join(root, relativePath);
            try {
                const metadata = await lstat(absolutePath);
                if (metadata.isSymbolicLink()) {
                    worktreeContent.push({
                        path: relativePath,
                        kind: "symlink",
                        hash: sha256(await readlink(absolutePath)),
                    });
                }
                else if (metadata.isFile()) {
                    worktreeContent.push({
                        path: relativePath,
                        kind: "file",
                        hash: await this.hashFile(absolutePath),
                    });
                }
                else {
                    worktreeContent.push({ path: relativePath, kind: "other" });
                }
            }
            catch (error) {
                if (error.code === "ENOENT") {
                    worktreeContent.push({ path: relativePath, kind: "missing" });
                }
                else {
                    throw error;
                }
            }
        }
        return sha256({
            headOid,
            branch,
            operation,
            worktree,
            syncScope: binding === undefined
                ? null
                : {
                    include: binding.sync.include,
                    exclude: binding.sync.exclude,
                },
            index: sha256(index.stdout),
            worktreeContent,
        });
    }
    async hashFile(filePath) {
        const hash = createHash("sha256");
        await new Promise((resolve, reject) => {
            const stream = createReadStream(filePath);
            stream.on("data", (chunk) => hash.update(chunk));
            stream.on("error", reject);
            stream.on("end", resolve);
        });
        return `sha256:${hash.digest("hex")}`;
    }
    async relationship(root, snapshot) {
        const local = snapshot.headOid;
        const remote = snapshot.remoteOid;
        if (local === null && remote === null) {
            return "both_unborn";
        }
        if (local === null) {
            return "local_unborn";
        }
        if (remote === null) {
            return "remote_unborn";
        }
        if (local === remote) {
            return "equal";
        }
        if (await this.isAncestor(root, remote, local)) {
            return "local_ahead";
        }
        if (await this.isAncestor(root, local, remote)) {
            return "remote_ahead";
        }
        return "diverged";
    }
    async isAncestor(root, ancestor, descendant) {
        const result = await this.runner.run(["merge-base", "--is-ancestor", ancestor, descendant], { cwd: root, allowExitCodes: [0, 1] });
        return result.exitCode === 0;
    }
    async createBackupRefs(root, plan, operationId, target) {
        const base = `refs/overleafy/backup/${operationId}`;
        if ((target === "local" || target === "both") &&
            plan.preconditions.headOid !== null) {
            await this.runner.run(["update-ref", `${base}/local`, plan.preconditions.headOid], { cwd: root });
        }
        if ((target === "remote" || target === "both") &&
            plan.preconditions.remoteOid !== null) {
            await this.runner.run(["update-ref", `${base}/remote`, plan.preconditions.remoteOid], { cwd: root });
        }
    }
    async verifyRemoteLease(root, binding, expectedOid, env) {
        const actualOid = await this.readRemoteOid(root, binding, env);
        if (actualOid !== expectedOid) {
            throw this.remoteMoved(expectedOid, actualOid);
        }
    }
    async readRemoteOid(root, binding, env) {
        const result = await this.runner.run([
            "ls-remote",
            binding.remoteName,
            `refs/heads/${binding.remoteBranch}`,
        ], { cwd: root, timeoutMs: 60_000, env });
        return result.stdout.trim().split(/\s+/)[0] || null;
    }
    remoteMoved(expectedOid, actualOid) {
        return new OverleafyError("REMOTE_MOVED", "The Overleaf remote moved after the plan was created.", {
            remediation: "Fetch and create a new sync plan.",
            details: { expectedOid, actualOid },
        });
    }
    async withAuthentication(binding, action) {
        return withGitAskpass(binding, this.credentials, action);
    }
    async ensureLocalExclude(root) {
        const rawExcludePath = (await this.runner.run(["rev-parse", "--git-path", "info/exclude"], {
            cwd: root,
        })).stdout.trim();
        const excludePath = path.isAbsolute(rawExcludePath)
            ? rawExcludePath
            : path.resolve(root, rawExcludePath);
        await mkdir(path.dirname(excludePath), { recursive: true });
        let content = "";
        try {
            content = await readFile(excludePath, "utf8");
        }
        catch {
            // The file will be created below.
        }
        const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
        if (!lines.has(".overleafy/")) {
            const separator = content === "" || content.endsWith("\n") ? "" : "\n";
            await appendFile(excludePath, `${separator}# overleafy managed\n.overleafy/\n`, "utf8");
        }
    }
    async assertBoundRemote(root, binding) {
        const result = await this.runner.run(["remote", "get-url", binding.remoteName], { cwd: root, allowExitCodes: [0, 2] });
        if (result.exitCode !== 0) {
            throw new OverleafyError("BINDING_INVALID", `Configured remote '${binding.remoteName}' does not exist.`, { remediation: "Run bind again after inspecting the repository." });
        }
        const currentUrl = result.stdout.trim();
        this.assertCredentialFreeUrl(currentUrl, binding.remoteName);
        if (!urlsEqual(currentUrl, binding.gitUrl)) {
            throw new OverleafyError("BINDING_INVALID", `Configured remote '${binding.remoteName}' no longer matches the binding.`, {
                remediation: "Inspect the remote change and bind again only if it is intentional.",
                details: {
                    remoteName: binding.remoteName,
                    currentUrl: this.redactUrl(currentUrl),
                },
            });
        }
    }
    assertCredentialFreeUrl(raw, remoteName) {
        try {
            const url = new URL(raw);
            if (url.username !== "" || url.password !== "") {
                throw new OverleafyError("BINDING_INVALID", `Remote '${remoteName}' contains credentials in its URL.`, {
                    remediation: "Remove URL credentials and use a credential profile instead.",
                });
            }
        }
        catch (error) {
            if (error instanceof OverleafyError) {
                throw error;
            }
            // SCP-style and local paths cannot contain URL userinfo.
        }
    }
    redactUrl(raw) {
        try {
            const url = new URL(raw);
            url.username = url.username === "" ? "" : "***";
            url.password = url.password === "" ? "" : "***";
            return url.toString();
        }
        catch {
            return raw;
        }
    }
}
//# sourceMappingURL=repository.js.map