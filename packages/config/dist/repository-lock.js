import { randomUUID } from "node:crypto";
import { open, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OverleafyError, } from "@nyanifold/core";
export class FileRepositoryLock {
    async acquire(repositoryPath, operationId) {
        const directory = path.join(repositoryPath, ".overleafy");
        const lockPath = path.join(directory, "lock");
        const token = randomUUID();
        const record = {
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
        }
        catch (error) {
            if (error.code === "EEXIST") {
                let owner;
                try {
                    owner = JSON.parse(await readFile(lockPath, "utf8"));
                }
                catch {
                    owner = { unreadable: true };
                }
                throw new OverleafyError("LOCKED", "Another overleafy operation holds the repository lock.", {
                    remediation: "Wait for the owner to finish. Use doctor before removing a stale lock.",
                    details: { lockPath, owner },
                    cause: error,
                });
            }
            throw error;
        }
        finally {
            await handle?.close();
        }
        return {
            release: async () => {
                try {
                    const current = JSON.parse(await readFile(lockPath, "utf8"));
                    if (current.token === token) {
                        await rm(lockPath);
                    }
                }
                catch (error) {
                    if (error.code !== "ENOENT") {
                        throw error;
                    }
                }
            },
        };
    }
}
//# sourceMappingURL=repository-lock.js.map