import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OverleafyError } from "../core/mod.js";
import { FileRepositoryLock } from "./repository-lock.js";

test("serializes repository operations and releases by ownership token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "overleaf-lock-"));
  const locks = new FileRepositoryLock();
  const first = await locks.acquire(root, "op_first");

  await assert.rejects(
    locks.acquire(root, "op_second"),
    (error: unknown) =>
      error instanceof OverleafyError && error.details.code === "LOCKED",
  );
  await first.release();
  const second = await locks.acquire(root, "op_second");
  await second.release();
});
