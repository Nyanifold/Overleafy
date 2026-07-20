import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, } from "node:fs/promises";
import path from "node:path";
import { OverleafyError, } from "@nyanifold/core";
import { z } from "zod";
const stateSchema = z
    .object({
    schemaVersion: z.literal(1),
    lastSuccessfulSync: z
        .object({
        localOid: z.string().min(1),
        remoteOid: z.string().min(1),
        at: z.iso.datetime(),
    })
        .strict()
        .optional(),
    activeOperation: z
        .object({
        operationId: z.string().min(1),
        planId: z.string().min(1),
        phase: z.enum(["applying", "conflict", "failed"]),
        startedAt: z.iso.datetime(),
        errorCode: z.string().optional(),
        mergeTargetOid: z.string().min(1).optional(),
        expectedRemoteOid: z.string().min(1).optional(),
    })
        .strict()
        .optional(),
})
    .strict();
async function stateRoot(startPath) {
    let current = path.resolve(startPath);
    try {
        if (!(await stat(current)).isDirectory()) {
            current = path.dirname(current);
        }
    }
    catch {
        return current;
    }
    while (true) {
        try {
            if ((await stat(path.join(current, ".overleafy", "config.json"))).isFile()) {
                return current;
            }
        }
        catch {
            // Keep walking.
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return path.resolve(startPath);
        }
        current = parent;
    }
}
export class FileStateStore {
    async read(repositoryPath) {
        const root = await stateRoot(repositoryPath);
        const statePath = path.join(root, ".overleafy", "state.json");
        try {
            const raw = JSON.parse(await readFile(statePath, "utf8"));
            return stateSchema.parse(raw);
        }
        catch (error) {
            const code = error.code;
            if (code === "ENOENT") {
                return { schemaVersion: 1 };
            }
            throw new OverleafyError("BINDING_INVALID", `Invalid sync state at ${statePath}.`, {
                remediation: "Run doctor before changing or removing the state file.",
                details: {
                    statePath,
                    reason: error instanceof Error ? error.message : String(error),
                },
                cause: error,
            });
        }
    }
    async write(repositoryPath, state) {
        const validated = stateSchema.parse(state);
        const root = await stateRoot(repositoryPath);
        const directory = path.join(root, ".overleafy");
        const target = path.join(directory, "state.json");
        const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temporary, target);
        await chmod(target, 0o600);
    }
}
//# sourceMappingURL=state-store.js.map