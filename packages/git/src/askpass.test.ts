import assert from "node:assert/strict";
import { access, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import test from "node:test";
import type {
  GitCredentialProviderPort,
  ProjectBinding,
} from "@nyanifold/core";
import { withGitAskpass } from "./askpass.js";

const binding: ProjectBinding = {
  schemaVersion: 1,
  profile: "sso-user",
  projectId: "0123456789abcdef01234567",
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

function runAskpass(
  executable: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [prompt], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`askpass exited with ${code}`));
      } else {
        resolve(Buffer.concat(chunks).toString("utf8").trim());
      }
    });
  });
}

test("passes credentials through environment and removes helper", async () => {
  const credentials: GitCredentialProviderPort = {
    async getGitToken(profile) {
      assert.equal(profile, "sso-user");
      return "secret-token";
    },
  };
  let helperPath = "";

  await withGitAskpass(binding, credentials, async (env) => {
    assert.ok(env);
    helperPath = env.GIT_ASKPASS ?? "";
    assert.equal((await stat(helperPath)).mode & 0o777, 0o700);
    assert.equal(
      await runAskpass(helperPath, "Username for HTTPS", env),
      "git",
    );
    assert.equal(
      await runAskpass(helperPath, "Password for HTTPS", env),
      "secret-token",
    );
  });

  await assert.rejects(access(helperPath));
});

test("does not request credentials for a file remote", async () => {
  let requested = false;
  await withGitAskpass(
    { ...binding, gitUrl: "file:///tmp/overleaf.git" },
    {
      async getGitToken() {
        requested = true;
        return "secret-token";
      },
    },
    async (env) => {
      assert.equal(env, undefined);
    },
  );
  assert.equal(requested, false);
});
