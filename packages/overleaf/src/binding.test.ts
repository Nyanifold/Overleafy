import assert from "node:assert/strict";
import test from "node:test";
import { OverleafyError } from "@nyanifold/core";
import { createProjectBinding, extractProjectId } from "./binding.js";

test("extracts project IDs from bare IDs and web URLs", () => {
  assert.equal(
    extractProjectId("0123456789ABCDEF01234567"),
    "0123456789abcdef01234567",
  );
  assert.equal(
    extractProjectId(
      "https://www.overleaf.com/project/0123456789abcdef01234567",
    ),
    "0123456789abcdef01234567",
  );
});

test("creates a credential-free default binding", () => {
  const binding = createProjectBinding({
    project: "0123456789abcdef01234567",
    localBranch: "main",
  });
  assert.equal(
    binding.gitUrl,
    "https://git.overleaf.com/0123456789abcdef01234567",
  );
  assert.equal(binding.remoteName, "overleaf");
  assert.equal(new URL(binding.gitUrl).password, "");
});

test("rejects credentials in explicit Git URL", () => {
  assert.throws(
    () =>
      createProjectBinding({
        project: "0123456789abcdef01234567",
        localBranch: "main",
        gitUrl: "https://git:secret@git.overleaf.com/project",
      }),
    (error: unknown) =>
      error instanceof OverleafyError &&
      error.details.code === "BINDING_INVALID",
  );
});
