import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { URL } from "node:url";

const root = new URL("..", import.meta.url);

async function main() {
  try {
    await stat(new URL("packages/cli/dist/main.js", root));
  } catch {
    process.stderr.write("Dist files missing, attempting rebuild...\n");
    const result = spawnSync("npm", ["run", "build"], {
      cwd: root,
      stdio: "inherit",
      timeout: 120_000,
    });
    if (result.status !== 0) {
      process.stderr.write(
        "Build failed. Run 'npm install && npm run build' manually.\n"
      );
      process.exit(1);
    }
  }
}

await main();
