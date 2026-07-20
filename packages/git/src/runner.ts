import { spawn } from "node:child_process";
import {
  OverleafyError,
  type ErrorCode,
} from "@nyanifold/core";

export interface GitRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowExitCodes?: number[];
  maxOutputBytes?: number;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function classifyGitFailure(stderr: string): ErrorCode {
  const normalized = stderr.toLowerCase();
  if (
    normalized.includes("authentication failed") ||
    normalized.includes("could not read username") ||
    normalized.includes("http basic: access denied")
  ) {
    return "AUTH_REQUIRED";
  }
  if (
    normalized.includes("could not resolve host") ||
    normalized.includes("connection timed out") ||
    normalized.includes("connection refused")
  ) {
    return "NETWORK";
  }
  return "GIT_FAILED";
}

export class GitRunner {
  async run(args: string[], options: GitRunOptions): Promise<GitRunResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
    const allowed = new Set(options.allowExitCodes ?? [0]);

    return new Promise<GitRunResult>((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          ...options.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const finishWithError = (
        code: ErrorCode,
        message: string,
        details: Record<string, unknown>,
        cause?: unknown,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(
          new OverleafyError(code, message, {
            retryable: code === "NETWORK",
            details,
            ...(cause === undefined ? {} : { cause }),
          }),
        );
      };

      const append = (
        chunks: Buffer[],
        currentBytes: number,
        chunk: Buffer,
      ): number | undefined => {
        if (currentBytes + chunk.length > maxOutputBytes) {
          child.kill("SIGKILL");
          finishWithError(
            "GIT_FAILED",
            "Git command output exceeded the configured limit.",
            { subcommand: args[0] ?? "unknown", maxOutputBytes },
          );
          return undefined;
        }
        chunks.push(chunk);
        return currentBytes + chunk.length;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const next = append(stdoutChunks, stdoutBytes, chunk);
        if (next !== undefined) {
          stdoutBytes = next;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const next = append(stderrChunks, stderrBytes, chunk);
        if (next !== undefined) {
          stderrBytes = next;
        }
      });

      child.on("error", (error) => {
        finishWithError(
          "GIT_FAILED",
          "Unable to start Git.",
          { subcommand: args[0] ?? "unknown" },
          error,
        );
      });

      child.on("close", (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const code = exitCode ?? 1;
        const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
        const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (!allowed.has(code)) {
          const errorCode = classifyGitFailure(stderrText);
          reject(
            new OverleafyError(
              errorCode,
              stderrText || `Git exited with code ${code}.`,
              {
                retryable: errorCode === "NETWORK",
                details: {
                  subcommand: args[0] ?? "unknown",
                  exitCode: code,
                  signal,
                },
              },
            ),
          );
          return;
        }
        resolve({
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: code,
        });
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
        finishWithError(
          "GIT_FAILED",
          `Git command timed out after ${timeoutMs}ms.`,
          { subcommand: args[0] ?? "unknown", timeoutMs },
        );
      }, timeoutMs);
      timer.unref();
    });
  }
}
