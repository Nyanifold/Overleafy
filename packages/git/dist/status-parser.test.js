import assert from "node:assert/strict";
import test from "node:test";
import { parsePorcelainV2 } from "./status-parser.js";
test("parses ordinary, rename, untracked and conflicted records", () => {
    const output = [
        "1 M. N... 100644 100644 100644 a a main.tex",
        "1 .M N... 100644 100644 100644 b b notes.tex",
        "2 R. N... 100644 100644 100644 c c R100 renamed.tex",
        "old.tex",
        "? figures/new plot.png",
        "u UU N... 100644 100644 100644 100644 d d d conflict.tex",
        "",
    ].join("\0");
    assert.deepEqual(parsePorcelainV2(output), {
        staged: ["main.tex", "renamed.tex"],
        unstaged: ["notes.tex"],
        untracked: ["figures/new plot.png"],
        conflicted: ["conflict.tex"],
    });
});
//# sourceMappingURL=status-parser.test.js.map