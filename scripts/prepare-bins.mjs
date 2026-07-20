import { chmod, mkdir, symlink } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import path from "node:path";

const root = new URL("..", import.meta.url);
const rootPath = new URL(".", root).pathname;

// Symlink workspace packages so @nyanifold/* imports resolve.
// npm pack resolves the symlinks and includes the actual files in the tarball.
const linkDir = new URL("node_modules/@nyanifold/", root);
await mkdir(linkDir, { recursive: true });

for (const name of ["cli", "config", "core", "git", "overleaf"]) {
  const linkPath = new URL(name, linkDir).pathname;
  const targetPath = path.join(rootPath, "packages", name);
  const relative = path.relative(path.dirname(linkPath), targetPath);
  try {
    await symlink(relative, linkPath, "dir");
  } catch {
    // Already exists — ignore.
  }
}

if (process.platform !== "win32") {
  await chmod(new URL("packages/cli/dist/main.js", root), 0o755);
}
