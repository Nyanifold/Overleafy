import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OverleafyError, type ProjectBinding } from "@nyanifold/core";
import { FileBindingStore } from "./binding-store.js";

const binding: ProjectBinding = {
  schemaVersion: 1,
  profile: "default",
  projectId: "0123456789abcdef01234567",
  projectName: "Paper",
  webUrl: "https://www.overleaf.com",
  gitUrl: "https://git.overleaf.com/0123456789abcdef01234567",
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

test("writes atomically and discovers a binding from a nested path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "overleaf-config-"));
  const nested = path.join(root, "chapters");
  await mkdir(nested);
  const store = new FileBindingStore();

  await store.write(root, binding);
  assert.deepEqual(await store.read(nested), binding);
  const text = await readFile(
    path.join(root, ".overleafy", "config.json"),
    "utf8",
  );
  assert.equal(text.includes("0123456789abcdef01234567"), true);
});

test("rejects credentials embedded in URLs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "overleaf-config-"));
  const store = new FileBindingStore();
  await assert.rejects(
    store.write(root, {
      ...binding,
      gitUrl: "https://git:secret@git.overleaf.com/project",
    }),
  );
});

test("maps malformed config to BINDING_INVALID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "overleaf-config-"));
  const directory = path.join(root, ".overleafy");
  await mkdir(directory);
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(path.join(directory, "config.json"), "{}"),
  );
  const store = new FileBindingStore();

  await assert.rejects(
    store.read(root),
    (error: unknown) =>
      error instanceof OverleafyError &&
      error.details.code === "BINDING_INVALID",
  );
});
