import { cp, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the overleafy-guide skill directory relative to the package root.
 * From dist/cli/skill.js, the package root is ../../.
 */
function skillDir(): string {
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  return resolve(moduleDir, "..", "..", "skills", "overleafy-guide");
}

/** Read and concatenate SKILL.md + commands.md. */
async function buildGuideContent(): Promise<string> {
  const dir = skillDir();
  const skillText = await readFile(join(dir, "SKILL.md"), "utf-8");
  const commandsText = await readFile(
    join(dir, "references", "commands.md"),
    "utf-8",
  );
  return skillText + "\n" + commandsText;
}

/**
 * Write the concatenated skill guide.
 *
 * - If `output` is omitted, prints to stdout.
 * - If `output` is an existing directory, writes `overleafy-guide.md` inside it.
 * - Otherwise `output` is treated as the destination file path.
 */
export async function printSkillGuide(output?: string): Promise<string> {
  const content = await buildGuideContent();

  if (output === undefined) {
    process.stdout.write(content);
    return "(stdout)";
  }

  const resolved = resolve(output);
  let dest: string;
  try {
    const s = await stat(resolved);
    if (s.isDirectory()) {
      dest = join(resolved, "overleafy-guide.md");
    } else {
      dest = resolved;
    }
  } catch {
    // Path does not exist — treat as a file.
    dest = resolved;
  }

  await writeFile(dest, content, "utf-8");
  return dest;
}

/**
 * Copy the entire overleafy-guide directory to the target directory.
 * The target directory is the parent directory where overleafy-guide/ will be placed.
 */
export async function copySkillGuide(targetDir: string): Promise<void> {
  const src = skillDir();
  const dest = resolve(targetDir, "overleafy-guide");
  await cp(src, dest, { recursive: true });
}
