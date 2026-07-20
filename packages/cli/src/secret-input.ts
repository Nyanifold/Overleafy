import { lstat, readFile } from "node:fs/promises";
import { OverleafyError } from "@nyanifold/core";

const MAX_SECRET_BYTES = 64 * 1024;

export async function readSecretFile(filePath: string): Promise<string> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile()) {
    throw new OverleafyError(
      "AUTH_REQUIRED",
      "The secret path must refer to a regular file.",
    );
  }
  if (
    process.platform !== "win32" &&
    (metadata.mode & 0o077) !== 0
  ) {
    throw new OverleafyError(
      "AUTH_REQUIRED",
      "The secret file is readable or writable by other users.",
      { remediation: `Run: chmod 600 ${filePath}` },
    );
  }
  if (metadata.size > MAX_SECRET_BYTES) {
    throw new OverleafyError(
      "AUTH_REQUIRED",
      "The secret file exceeds the 64 KiB limit.",
    );
  }
  const value = (await readFile(filePath, "utf8")).trim();
  if (value === "") {
    throw new OverleafyError("AUTH_REQUIRED", "The secret file is empty.");
  }
  return value;
}

export async function promptSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new OverleafyError(
      "AUTH_REQUIRED",
      "A TTY is required for hidden secret input.",
      {
        remediation:
          "Use a mode-specific secret file option, or set the documented environment variable.",
      },
    );
  }

  return new Promise<string>((resolve, reject) => {
    const input = process.stdin;
    const characters: string[] = [];
    const previousRawMode = input.isRaw ?? false;

    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(previousRawMode);
      input.pause();
      process.stderr.write("\n");
    };

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          const value = characters.join("").trim();
          cleanup();
          if (value === "") {
            reject(
              new OverleafyError(
                "AUTH_REQUIRED",
                "Refusing to store an empty credential.",
              ),
            );
          } else {
            resolve(value);
          }
          return;
        }
        if (character === "\u0003") {
          cleanup();
          reject(
            new OverleafyError("AUTH_REQUIRED", "Secret input cancelled."),
          );
          return;
        }
        if (character === "\u007f" || character === "\b") {
          characters.pop();
        } else if (character >= " ") {
          characters.push(character);
        }
      }
    };

    process.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
