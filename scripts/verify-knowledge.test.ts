import { describe, expect, it } from "vitest";

import {
  ageInDays,
  checkCatalogue,
  checkExecPlan,
  extractRelativeLinks,
  isIsoDate,
  linkPath,
  parseFrontmatter,
} from "./verify-knowledge";

describe("extractRelativeLinks + linkPath", () => {
  const md = [
    "[a](docs/guide.md)",
    "[b](../README.md#top)",
    "[c](https://example.com/y)",
    "[d](#anchor)",
    "![e](img.png)",
    '[f](target.md "title")',
  ].join(" ");

  it("collects link and image targets", () => {
    expect(extractRelativeLinks(md)).toEqual([
      "docs/guide.md",
      "../README.md#top",
      "https://example.com/y",
      "#anchor",
      "img.png",
      "target.md",
    ]);
  });

  it("linkPath keeps the file part, drops externals and pure anchors", () => {
    expect(linkPath("docs/guide.md")).toBe("docs/guide.md");
    expect(linkPath("../README.md#top")).toBe("../README.md");
    expect(linkPath("https://example.com/y")).toBeNull();
    expect(linkPath("#anchor")).toBeNull();
  });
});

describe("parseFrontmatter", () => {
  it("parses flat key: value pairs", () => {
    expect(
      parseFrontmatter(
        "---\nid: 0007\ntitle: a plan\nstatus: active\n---\n\n# a",
      ),
    ).toEqual({ id: "0007", title: "a plan", status: "active" });
  });

  it("returns null without frontmatter", () => {
    expect(parseFrontmatter("# just a doc")).toBeNull();
    expect(parseFrontmatter("---\nno closing fence")).toBeNull();
  });
});

describe("dates", () => {
  it("isIsoDate accepts real ISO dates only", () => {
    expect(isIsoDate("2026-09-01")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("soon")).toBe(false);
  });

  it("ageInDays counts whole days", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    expect(ageInDays("2026-09-01", now)).toBe(0);
    expect(ageInDays("2026-08-30", now)).toBe(2);
  });
});

describe("checkExecPlan", () => {
  const body = [
    "## Context",
    "why",
    "## Plan",
    "- [x] only step",
    "## Decision log",
    "| Date | Decision | Why |",
    "| --- | --- | --- |",
    "## Verification",
    "task check",
  ].join("\n");
  const plan = (status: string) =>
    `---\nid: 0007\ntitle: t\nstatus: ${status}\ncreated: 2026-08-01\nupdated: 2026-08-02\nowner: agent\n---\n\n${body}`;
  const completedPath = "repo/docs/plans/completed/0007-fix-thing.md";

  it("accepts a well-formed completed plan in completed/", () => {
    expect(checkExecPlan(completedPath, plan("completed"))).toEqual([]);
  });

  it("rejects an unknown status", () => {
    const errs = checkExecPlan(completedPath, plan("done"));
    expect(errs.some((e) => e.message.includes('status "done"'))).toBe(true);
  });

  it("rejects a completed status living in active/", () => {
    const errs = checkExecPlan(
      completedPath.replace("/completed/", "/active/"),
      plan("completed"),
    );
    expect(
      errs.some((e) => e.message.includes("does not belong in active/")),
    ).toBe(true);
  });

  it("rejects an id that does not match the filename number", () => {
    const errs = checkExecPlan(
      completedPath.replace("0007", "0008"),
      plan("completed"),
    );
    expect(errs.some((e) => e.message.includes("filename number"))).toBe(true);
  });

  it("rejects unchecked steps in a completed plan", () => {
    const unchecked = body.replace("- [x] only step", "- [ ] only step");
    const md = `---\nid: 0007\ntitle: t\nstatus: completed\ncreated: 2026-08-01\nupdated: 2026-08-02\nowner: agent\n---\n\n${unchecked}`;
    expect(
      checkExecPlan(completedPath, md).some((e) =>
        e.message.includes("unchecked steps"),
      ),
    ).toBe(true);
  });

  it("rejects missing headings and updated-before-created", () => {
    const md =
      "---\nid: 0007\ntitle: t\nstatus: active\ncreated: 2026-08-02\nupdated: 2026-08-01\nowner: agent\n---\n\n## Context\n";
    const errs = checkExecPlan("repo/docs/plans/active/0007-fix-thing.md", md);
    expect(errs.some((e) => e.message.includes("## Plan"))).toBe(true);
    expect(errs.some((e) => e.message.includes("precedes created"))).toBe(true);
  });
});

describe("checkCatalogue", () => {
  const catalogue = (date: string) =>
    [
      "<!-- verifier: catalogue-start -->",
      "| Doc | Audience | Covers | Verified by | Last verified |",
      "| --- | --- | --- | --- | --- |",
      `| doc.md | users | things | task check | ${date} |`,
      "<!-- verifier: catalogue-end -->",
    ].join("\n");
  const now = new Date("2026-09-01T00:00:00Z");

  it("accepts a fresh, well-formed row", () => {
    expect(checkCatalogue(catalogue("2026-08-30"), now)).toEqual([]);
  });

  it("flags a stale row with a remediation hint", () => {
    const errs = checkCatalogue(catalogue("2026-01-01"), now);
    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toContain("doc.md");
    expect(errs[0]?.fix).toContain("Verified by");
  });

  it("flags a non-date last cell", () => {
    expect(
      checkCatalogue(catalogue("recently"), now).some((e) =>
        e.message.includes("not a date"),
      ),
    ).toBe(true);
  });

  it("flags missing markers", () => {
    expect(
      checkCatalogue("| Doc |", now).some((e) => e.message.includes("markers")),
    ).toBe(true);
  });
});
