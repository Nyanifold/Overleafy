import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitCredentialProviderPort, ProjectBinding } from "@nyanifold/core";

const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *Username*|*username*) printf '%s\\n' "$OVERLEAFY_ASKPASS_USERNAME" ;;
  *) printf '%s\\n' "$OVERLEAFY_ASKPASS_PASSWORD" ;;
esac
`;

function usesHttpAuthentication(gitUrl: string): boolean {
  try {
    const protocol = new URL(gitUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export async function withGitAskpass<T>(
  binding: ProjectBinding,
  credentials: GitCredentialProviderPort | undefined,
  action: (env: NodeJS.ProcessEnv | undefined) => Promise<T>,
): Promise<T> {
  if (credentials === undefined || !usesHttpAuthentication(binding.gitUrl)) {
    return action(undefined);
  }

  const token = await credentials.getGitToken(binding.profile);
  if (token === undefined || token === "") {
    return action(undefined);
  }

  const directory = await mkdtemp(
    path.join(os.tmpdir(), "overleafy-askpass-"),
  );
  const scriptPath = path.join(directory, "askpass");

  try {
    await writeFile(scriptPath, ASKPASS_SCRIPT, {
      encoding: "utf8",
      mode: 0o700,
    });
    await chmod(scriptPath, 0o700);
    return await action({
      GIT_ASKPASS: scriptPath,
      GIT_ASKPASS_REQUIRE: "force",
      OVERLEAFY_ASKPASS_USERNAME: "git",
      OVERLEAFY_ASKPASS_PASSWORD: token,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
