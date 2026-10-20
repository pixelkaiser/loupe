import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildReviewEvidence } from "../src/evidence";

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "loupe-evidence-test-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "unit_tests"));
  return root;
}

describe("review evidence", () => {
  it.each(["latest", "contest"])(
    "keeps %s.ts as production source and includes its matching test",
    (name) => {
      const root = checkout();
      writeFileSync(
        join(root, "src/" + name + ".ts"),
        "export function changed() {\n return 1;\n}",
      );
      writeFileSync(
        join(root, "unit_tests/" + name + ".test.ts"),
        "export function check() {\n changed();\n}",
      );
      spawnSync("git", ["init", "--quiet", root]);
      spawnSync("git", ["-C", root, "add", "."]);
      const evidence = buildReviewEvidence(root, [
        {
          path: "src/" + name + ".ts",
          patch: "@@ -1,3 +1,3 @@\n context\n-old\n+new\n context",
        },
      ]);
      expect(evidence.changed).toEqual([
        { name: "changed", file: "src/" + name + ".ts" },
      ]);
      expect(evidence.text).toContain("unit_tests/" + name + ".test.ts");
      expect(evidence.text).toContain("changed();");
    },
  );

  it("recognizes standalone PHPUnit filenames as tests", () => {
    const root = checkout();
    writeFileSync(
      join(root, "ReportTest.php"),
      "<?php\nclass ReportTest {\n public function testImport() {}\n}",
    );
    const evidence = buildReviewEvidence(root, [
      {
        path: "ReportTest.php",
        patch: "@@ -1,4 +1,4 @@\n context\n context\n-old\n+new\n context",
      },
    ]);
    expect(evidence.changed).toEqual([]);
  });

  it("matches dotted TypeScript test basenames", () => {
    const root = checkout();
    writeFileSync(
      join(root, "src/report.ts"),
      "export function report() {\n return 1;\n}",
    );
    writeFileSync(
      join(root, "unit_tests/report.test.ts"),
      "export function checkReport() {\n report();\n}",
    );
    spawnSync("git", ["init", "--quiet", root]);
    spawnSync("git", ["-C", root, "add", "."]);
    const evidence = buildReviewEvidence(root, [
      {
        path: "src/report.ts",
        patch: "@@ -1,3 +1,3 @@\n context\n-old\n+new\n context",
      },
    ]);
    expect(evidence.text).toContain("unit_tests/report.test.ts");
    expect(evidence.text).toContain("report();");
  });

  it("supplies helpers outside PHP hunks, constants, and matching unchanged tests", () => {
    const root = checkout();
    writeFileSync(
      join(root, "src/Report.php"),
      [
        "<?php",
        "class Report {",
        "    const RETENTION_DAYS = 365;",
        "    public static function Import($token) {",
        "        return self::Range($token);",
        "    }",
        ...Array.from({ length: 80 }, () => ""),
        "    private static function Range($token) {",
        "        return today()->modify(self::RETENTION_DAYS);",
        "    }",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "unit_tests/ReportTest.php"),
      [
        "<?php",
        "function testImport() {",
        "    Report::Import('2026-09-20');",
        "}",
      ].join("\n"),
    );
    spawnSync("git", ["init", "--quiet", root]);
    spawnSync("git", ["-C", root, "add", "."]);
    const evidence = buildReviewEvidence(root, [
      {
        path: "src/Report.php",
        patch:
          "@@ -4,3 +4,3 @@\n public static function Import($token) {\n- old\n+ return self::Range($token);\n }",
      },
    ]);
    expect(evidence.text).toContain("today()->modify(self::RETENTION_DAYS)");
    expect(evidence.text).toContain("const RETENTION_DAYS = 365");
    expect(evidence.text).toContain("Report::Import('2026-09-20')");
    expect(evidence.changed).toEqual([
      { file: "src/Report.php", name: "Import" },
    ]);
  });

  it("is independent of input file order and absolute checkout paths", () => {
    const roots = [checkout(), checkout()];
    for (const root of roots) {
      writeFileSync(
        join(root, "src/a.ts"),
        "export function alpha() {\n return 1;\n}",
      );
      writeFileSync(
        join(root, "src/b.ts"),
        "export function beta() {\n return 2;\n}",
      );
    }
    const files = ["a", "b"].map((name) => ({
      path: "src/" + name + ".ts",
      patch: "@@ -1,3 +1,3 @@\n line\n-old\n+new\n line",
    }));
    expect(buildReviewEvidence(roots[0]!, files)).toEqual(
      buildReviewEvidence(roots[1]!, [...files].reverse()),
    );
  });

  it("preserves changes deep inside long functions and bounds huge evidence", () => {
    const root = checkout();
    writeFileSync(
      join(root, "src/large.ts"),
      [
        "export function large() {",
        ...Array.from(
          { length: 2_000 },
          (_, i) => "  work(" + i + "); // " + "x".repeat(150),
        ),
        "}",
      ].join("\n"),
    );
    const evidence = buildReviewEvidence(root, [
      {
        path: "src/large.ts",
        patch: "@@ -1500,3 +1500,3 @@\n context\n-old\n+new\n context",
      },
    ]);
    expect(evidence.text).toContain("1501| ");
    expect(evidence.text.length).toBeLessThan(49_000);
    expect(evidence.text).toContain("Evidence budget reached");
  });

  it("does not follow paths or symlinks outside the checkout", () => {
    const root = checkout();
    const outside = mkdtempSync(join(tmpdir(), "loupe-outside-"));
    writeFileSync(join(outside, "secret.ts"), "never include this");
    symlinkSync(join(outside, "secret.ts"), join(root, "src/link.ts"));
    const evidence = buildReviewEvidence(
      root,
      ["src/link.ts", "../secret.ts"].map((path) => ({
        path,
        patch: "@@ -1 +1 @@\n-old\n+new",
      })),
    );
    expect(evidence.text).not.toContain("never include this");
  });

  it("skips deleted, binary, and unreadable source without failing the review", () => {
    const root = checkout();
    writeFileSync(join(root, "src/binary.ts"), "\0binary");
    const evidence = buildReviewEvidence(
      root,
      ["gone.ts", "src/binary.ts"].map((path) => ({
        path,
        patch: "@@ -1 +1 @@\n-old\n+new",
      })),
    );
    expect(evidence.changed).toEqual([]);
    expect(evidence.text).toContain("bounded excerpts");
    expect(evidence.text).not.toContain("binary");
  });
});
