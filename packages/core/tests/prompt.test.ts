import { describe, expect, it } from "vitest";

import { renderFileTree, type DiffFile } from "../src/diff";
import { buildSystemPrompt, buildUserPrompt } from "../src/prompt";

const files: DiffFile[] = [
  { path: "src/a.ts", patch: "@@ -1,1 +1,2 @@\n line\n+added line\n-removed" },
  { path: "img.png", patch: undefined },
];

describe("renderFileTree", () => {
  it("lists paths with +/- counts, and marks binaries", () => {
    const tree = renderFileTree(files);
    expect(tree).toContain("- src/a.ts (+1 −1)");
    expect(tree).toContain("- img.png (binary/too large)");
    // it must NOT contain the actual patch body
    expect(tree).not.toContain("added line");
  });
});

describe("buildUserPrompt", () => {
  const base = { title: "t", description: "", files };

  it("headless mode inlines the full diff", () => {
    const p = buildUserPrompt(base);
    expect(p).toContain("Diff under review:");
    expect(p).toContain("+added line"); // the patch body is present
    expect(p).not.toContain("is written to");
  });

  it("agentic mode (diffPath) sends the tree + a pointer, not the diff body", () => {
    const p = buildUserPrompt({ ...base, diffPath: "/tmp/x/pr.diff" });
    expect(p).toContain("Changed files");
    expect(p).toContain("- src/a.ts (+1 −1)");
    expect(p).toContain("/tmp/x/pr.diff");
    expect(p).not.toContain("+added line"); // the diff body is NOT inlined
  });
});

describe("buildSystemPrompt", () => {
  it("teaches findings to carry an (unfenced) suggestion", () => {
    const p = buildSystemPrompt({ reasoning: "medium" });
    // guidance: when to suggest
    expect(p).toContain('"suggestion"');
    // output contract: the field is part of the findings schema, as plain code
    expect(p).toMatch(/"suggestion".*WITHOUT markdown fences/s);
  });
});
