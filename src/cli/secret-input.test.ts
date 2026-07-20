import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OverleafyError } from "../core/mod.js";
import { readSecretFile } from "./secret-input.js";

test("reads a secret only from a permission-restricted file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "overleaf-secret-"));
  const filePath = path.join(root, "cookie");
  await writeFile(filePath, "overleaf_session2=value\n", { mode: 0o600 });
  assert.equal(await readSecretFile(filePath), "overleaf_session2=value");

  if (process.platform !== "win32") {
    await chmod(filePath, 0o644);
    await assert.rejects(
      readSecretFile(filePath),
      (error: unknown) =>
        error instanceof OverleafyError &&
        error.details.code === "AUTH_REQUIRED",
    );
  }
});
