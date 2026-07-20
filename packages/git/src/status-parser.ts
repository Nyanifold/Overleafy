import type { WorktreeStatus } from "@nyanifold/core";

function addIfChanged(
  target: Set<string>,
  marker: string,
  path: string,
): void {
  if (marker !== ".") {
    target.add(path);
  }
}

export function parsePorcelainV2(output: string): WorktreeStatus {
  const staged = new Set<string>();
  const unstaged = new Set<string>();
  const untracked = new Set<string>();
  const conflicted = new Set<string>();
  const records = output.split("\0");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "") {
      continue;
    }
    const kind = record[0];
    if (kind === "?") {
      untracked.add(record.slice(2));
      continue;
    }
    if (kind === "u") {
      const fields = record.split(" ");
      const path = fields.slice(10).join(" ");
      if (path !== "") {
        conflicted.add(path);
      }
      continue;
    }
    if (kind !== "1" && kind !== "2") {
      continue;
    }

    const fields = record.split(" ");
    const xy = fields[1];
    const pathStart = kind === "1" ? 8 : 9;
    const filePath = fields.slice(pathStart).join(" ");
    if (xy === undefined || filePath === "") {
      continue;
    }
    addIfChanged(staged, xy[0] ?? ".", filePath);
    addIfChanged(unstaged, xy[1] ?? ".", filePath);
    if (kind === "2") {
      index += 1;
    }
  }

  return {
    staged: [...staged].sort(),
    unstaged: [...unstaged].sort(),
    untracked: [...untracked].sort(),
    conflicted: [...conflicted].sort(),
  };
}
