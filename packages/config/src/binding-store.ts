import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  OverleafyError,
  type BindingStorePort,
  type ProjectBinding,
} from "@nyanifold/core";
import { z } from "zod";

const syncOptionsSchema = z
  .object({
    mergeStrategy: z.literal("merge"),
    include: z.array(z.string().min(1)).min(1),
    exclude: z.array(z.string().min(1)),
    quietPeriodMs: z.number().int().min(0).max(300_000),
  })
  .strict();

export const projectBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    profile: z.string().min(1),
    projectId: z.string().regex(/^[a-fA-F0-9]{6,64}$/),
    projectName: z.string().min(1).optional(),
    webUrl: z.url(),
    gitUrl: z.url(),
    remoteName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    localBranch: z.string().min(1),
    remoteBranch: z.string().min(1),
    sync: syncOptionsSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    for (const [field, rawUrl] of [
      ["webUrl", binding.webUrl],
      ["gitUrl", binding.gitUrl],
    ] as const) {
      const url = new URL(rawUrl);
      if (url.username !== "" || url.password !== "") {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Credentials are not allowed in configured URLs.",
        });
      }
    }
  });

const CONFIG_DIRECTORY = ".overleafy";
const CONFIG_FILE = "config.json";

async function existingConfig(startPath: string): Promise<string | undefined> {
  let current = path.resolve(startPath);
  try {
    if (!(await stat(current)).isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    return undefined;
  }

  while (true) {
    const candidate = path.join(current, CONFIG_DIRECTORY, CONFIG_FILE);
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Keep walking toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export class FileBindingStore implements BindingStorePort {
  async read(repositoryPath: string): Promise<ProjectBinding | undefined> {
    const configPath = await existingConfig(repositoryPath);
    if (configPath === undefined) {
      return undefined;
    }

    try {
      const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
      return projectBindingSchema.parse(raw) as ProjectBinding;
    } catch (error) {
      throw new OverleafyError(
        "BINDING_INVALID",
        `Invalid binding configuration at ${configPath}.`,
        {
          remediation: "Fix the configuration or bind the repository again.",
          details: {
            configPath,
            reason: error instanceof Error ? error.message : String(error),
          },
          cause: error,
        },
      );
    }
  }

  async write(
    repositoryPath: string,
    binding: ProjectBinding,
  ): Promise<void> {
    const validated = projectBindingSchema.parse(binding);
    const root = await realpath(repositoryPath);
    const directory = path.join(root, CONFIG_DIRECTORY);
    const target = path.join(directory, CONFIG_FILE);
    const temporary = path.join(directory, `.config-${randomUUID()}.tmp`);

    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await chmod(target, 0o600);
  }

  async delete(repositoryPath: string): Promise<void> {
    const configPath = await existingConfig(repositoryPath);
    if (configPath === undefined) {
      return;
    }
    await rm(path.dirname(configPath), { recursive: true, force: true });
  }
}
