import assert from "node:assert/strict";
import test from "node:test";
import { planSync } from "./planner.js";
import type {
  CommitRelationship,
  PlanOptions,
  RepositorySnapshot,
  SyncObservation,
} from "./types.js";

const cleanSnapshot: RepositorySnapshot = {
  repositoryPath: "/tmp/repo",
  gitDir: "/tmp/repo/.git",
  branch: "main",
  headOid: "local",
  remoteName: "overleaf",
  remoteBranch: "master",
  remoteOid: "remote",
  operation: "none",
  worktree: {
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  },
  worktreeFingerprint: "clean",
};

const defaults: PlanOptions = {
  dirtyPolicy: "fail",
  rewritePolicy: "fail",
};

function observation(
  relationship: CommitRelationship,
  overrides: Partial<SyncObservation> = {},
): SyncObservation {
  return {
    snapshot: cleanSnapshot,
    relationship,
    remoteRewritten: false,
    ...overrides,
  };
}

test("plans a no-op for equal clean commits", () => {
  const plan = planSync(observation("equal"), defaults);
  assert.equal(plan.classification, "equal_clean");
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.blockedBy, undefined);
});

test("blocks dirty worktree by default", () => {
  const snapshot = {
    ...cleanSnapshot,
    worktree: {
      ...cleanSnapshot.worktree,
      unstaged: ["main.tex"],
    },
    worktreeFingerprint: "dirty",
  };
  const plan = planSync(observation("equal", { snapshot }), defaults);
  assert.equal(plan.classification, "equal_dirty");
  assert.equal(plan.blockedBy?.code, "DIRTY_WORKTREE");
  assert.deepEqual(plan.actions, []);
});

test("creates checkpoint and lease push when explicitly requested", () => {
  const snapshot = {
    ...cleanSnapshot,
    worktree: {
      ...cleanSnapshot.worktree,
      staged: ["main.tex"],
    },
    worktreeFingerprint: "dirty",
  };
  const plan = planSync(observation("equal", { snapshot }), {
    dirtyPolicy: "checkpoint",
    rewritePolicy: "fail",
    commitMessage: "Update main section",
  });
  assert.deepEqual(plan.actions, [
    {
      type: "checkpoint",
      paths: ["main.tex"],
      message: "Update main section",
    },
    {
      type: "push",
      expectedRemoteOid: "remote",
    },
  ]);
});

test("never checkpoints tracked changes outside the configured scope", () => {
  const snapshot = {
    ...cleanSnapshot,
    worktree: {
      ...cleanSnapshot.worktree,
      outOfScope: [".output/generated.pdf"],
    },
    worktreeFingerprint: "out-of-scope",
  };
  const plan = planSync(observation("equal", { snapshot }), {
    dirtyPolicy: "checkpoint",
    rewritePolicy: "fail",
    commitMessage: "Agent checkpoint",
  });
  assert.equal(plan.blockedBy?.code, "DIRTY_WORKTREE");
  assert.deepEqual(plan.actions, []);
});

test("does not treat ordinary divergence as a remote rewrite", () => {
  const plan = planSync(observation("diverged"), defaults);
  assert.equal(plan.classification, "diverged");
  assert.deepEqual(
    plan.actions.map((action) => action.type),
    ["create_backup_ref", "merge", "push"],
  );
});

test("requires an explicit policy for remote history rewrite", () => {
  const plan = planSync(
    observation("diverged", {
      remoteRewritten: true,
      lastRemoteOid: "old-remote",
    }),
    defaults,
  );
  assert.equal(plan.classification, "remote_rewritten");
  assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.blockedBy?.code, "REMOTE_REWRITTEN");
  assert.deepEqual(plan.actions, []);
});

test("plan id is deterministic and changes with preconditions", () => {
  const first = planSync(observation("equal"), defaults);
  const second = planSync(observation("equal"), defaults);
  const changed = planSync(
    observation("equal", {
      snapshot: {
        ...cleanSnapshot,
        headOid: "different",
      },
    }),
    defaults,
  );
  assert.equal(first.planId, second.planId);
  assert.notEqual(first.planId, changed.planId);
});
