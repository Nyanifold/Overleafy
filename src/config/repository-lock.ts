import { randomUUID } from "node:crypto";
import { open, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OverleafyError,
  type RepositoryLockHandle,
  type RepositoryLockPort,
} from "../core/mod.js";

interface LockRecord {
  token: string;
  operationId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export class FileRepositoryLock implements RepositoryLockPort {
  async acquire(
    repositoryPath: string,
    operationId: string,
  ): Promise<RepositoryLockHandle> {
    const directory = path.join(repositoryPath, ".overleafy");
    const lockPath = path.join(directory, "lock");
    const token = randomUUID();
    const record: LockRecord = {
      token,
      operationId,
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });

    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        let owner: unknown;
        try {
          owner = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
        } catch {
          owner = { unreadable: true };
        }
        throw new OverleafyError(
          "LOCKED",
          "Another overleafy operation holds the repository lock.",
          {
            remediation:
              "Wait for the owner to finish. Use doctor before removing a stale lock.",
            details: { lockPath, owner },
            cause: error,
          },
        );
      }
      throw error;
    } finally {
      await handle?.close();
    }

    return {
      release: async () => {
        try {
          const current = JSON.parse(
            await readFile(lockPath, "utf8"),
          ) as Partial<LockRecord>;
          if (current.token === token) {
            await rm(lockPath);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      },
    };
  }
}
