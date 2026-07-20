import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectBinding } from "../core/mod.js";
import { GitRepository } from "./repository.js";
import { GitRunner } from "./runner.js";

const runner = new GitRunner();

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runner.run(args, { cwd })).stdout.trim();
}

async function fixture(): Promise<{
  root: string;
  remote: string;
  binding: ProjectBinding;
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "overleaf-git-"));
  const root = path.join(parent, "repo");
  const remote = path.join(parent, "remote.git");
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

  return {
    root,
    remote,
    binding: {
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
    },
  };
}

test("binds without replacing origin and observes equal commits", async () => {
  const { root, binding } = await fixture();
  const repository = new GitRepository();

  assert.equal(await repository.bind(root, binding), root);
  const observation = await repository.inspect(root, binding, { fetch: true });
  assert.equal(observation.relationship, "equal");
  assert.equal(observation.snapshot.branch, "main");
  assert.equal(observation.snapshot.remoteName, "overleaf");
  const exclude = await readFile(
    path.join(root, ".git", "info", "exclude"),
    "utf8",
  );
  assert.match(exclude, /\.overleafy\//);
});

test("reports dirty paths and changes the worktree fingerprint", async () => {
  const { root, binding } = await fixture();
  const repository = new GitRepository();
  await repository.bind(root, binding);
  const clean = await repository.inspect(root, binding, { fetch: true });

  await writeFile(path.join(root, "main.tex"), "changed\n");
  const dirty = await repository.inspect(root, binding, { fetch: false });
  assert.deepEqual(dirty.snapshot.worktree.unstaged, ["main.tex"]);
  assert.notEqual(
    clean.snapshot.worktreeFingerprint,
    dirty.snapshot.worktreeFingerprint,
  );
});

test("ignores excluded untracked output but reports excluded tracked edits", async () => {
  const { root, binding } = await fixture();
  binding.sync.exclude.push(".output/**");
  const repository = new GitRepository();
  await repository.bind(root, binding);
  const clean = await repository.inspect(root, binding, { fetch: true });

  await mkdir(path.join(root, ".output"));
  await writeFile(path.join(root, ".output", "generated.pdf"), "generated\n");
  const ignored = await repository.inspect(root, binding, { fetch: false });
  assert.deepEqual(ignored.snapshot.worktree.untracked, []);
  assert.equal(
    ignored.snapshot.worktreeFingerprint,
    clean.snapshot.worktreeFingerprint,
  );

  await git(root, ["add", "-f", ".output/generated.pdf"]);
  const staged = await repository.inspect(root, binding, { fetch: false });
  assert.deepEqual(staged.snapshot.worktree.outOfScope, [
    ".output/generated.pdf",
  ]);
});

test("rejects remote URL drift and credentials embedded in an existing remote", async () => {
  const { root, binding } = await fixture();
  const repository = new GitRepository();
  await repository.bind(root, binding);
  await git(root, ["remote", "set-url", "overleaf", "file:///tmp/other.git"]);
  await assert.rejects(
    repository.inspect(root, binding, { fetch: false }),
    (error: unknown) =>
      error instanceof Error &&
      "details" in error &&
      (error as { details: { code: string } }).details.code ===
        "BINDING_INVALID",
  );

  await git(root, [
    "remote",
    "set-url",
    "overleaf",
    "https://git:secret@git.overleaf.com/project",
  ]);
  await assert.rejects(
    repository.bind(root, {
      ...binding,
      gitUrl: "https://git.overleaf.com/project",
    }),
  );
});
