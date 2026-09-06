#!/usr/bin/env bun
/**
 * Knowledge-base verifier — the mechanical half of this repo's
 * agent-legibility conventions (AGENTS.md, docs/knowledge-map.md,
 * docs/plans/README.md).
 *
 *  1. required knowledge files exist
 *  2. AGENTS.md stays a table of contents (line budget + required pointers)
 *  3. every relative markdown link resolves to a real file
 *  4. docs/knowledge-map.md indexes every doc, example, and ExecPlan
 *  5. knowledge-map catalogue rows carry a fresh "Last verified" date
 *  6. ExecPlans follow docs/plans/README.md (naming, frontmatter, status vs
 *     location, required headings, no unchecked steps once completed)
 *
 * Every error prints a `fix:` line so an agent can remediate without
 * reading this file. Run: `task verify:knowledge` (also in `task check`
 * and CI).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export type CheckError = { file: string; message: string; fix: string };

export const AGENTS_MAX_LINES = 120;
export const STALE_AFTER_DAYS = 120;
export const PLAN_STATUSES: readonly string[] = [
  "draft",
  "active",
  "completed",
  "abandoned",
];
const REQUIRED_PLAN_HEADINGS = [
  "## Context",
  "## Plan",
  "## Decision log",
  "## Verification",
];
const CATALOGUE_START = "<!-- verifier: catalogue-start -->";
const CATALOGUE_END = "<!-- verifier: catalogue-end -->";
const AGENTS_POINTERS = [
  "docs/knowledge-map.md",
  "docs/plans/README.md",
  "docs/README.md",
];

const err = (file: string, message: string, fix: string): CheckError => ({
  file,
  message,
  fix,
});
const read = (path: string): string => readFileSync(path, "utf8");

/** All markdown link/image targets, external and relative alike. */
export function extractRelativeLinks(md: string): string[] {
  const out: string[] = [];
  for (const match of md.matchAll(
    /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
  )) {
    const target = match[1];
    if (target) out.push(target);
  }
  return out;
}

/** File path of a link target; null for external URLs and pure anchors. */
export function linkPath(target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) {
    return null;
  }
  return target.split("#")[0] ?? "";
}

/** Naive flat `key: value` frontmatter; null when there is none. */
export function parseFrontmatter(md: string): Record<string, string> | null {
  if (!md.startsWith("---\n")) return null;
  const end = md.indexOf("\n---", 4);
  if (end === -1) return null;
  const fm: Record<string, string> = {};
  for (const line of md.slice(4, end).split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) fm[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return fm;
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function ageInDays(iso: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
}

/** Format-check one ExecPlan (docs/plans/README.md § Enforcement). */
export function checkExecPlan(file: string, md: string): CheckError[] {
  const errs: CheckError[] = [];
  const add = (message: string, fix: string) =>
    errs.push(err(file, message, fix));
  const name = basename(file);

  const numbered = /^(\d{4})-[a-z0-9]+(-[a-z0-9]+)*\.md$/.exec(name);
  if (!numbered) {
    add(
      `filename "${name}" must look like NNNN-short-slug.md`,
      "rename it — see docs/plans/README.md § Lifecycle",
    );
  }

  const fm = parseFrontmatter(md);
  if (!fm) {
    add(
      "missing frontmatter",
      "copy docs/plans/TEMPLATE.md and fill in its frontmatter",
    );
    return errs;
  }
  for (const key of ["id", "title", "status", "created", "updated"]) {
    if (!fm[key]) {
      add(
        `frontmatter key "${key}" is missing or empty`,
        `set "${key}" — the contract is docs/plans/README.md § Frontmatter contract`,
      );
    }
  }
  const status = fm["status"] ?? "";
  if (status && !PLAN_STATUSES.includes(status)) {
    add(
      `status "${status}" is not one of ${PLAN_STATUSES.join(" | ")}`,
      "use a status from docs/plans/README.md § Frontmatter contract",
    );
  }
  if (numbered && fm["id"] !== numbered[1]) {
    add(
      `id "${fm["id"] ?? ""}" does not match filename number ${numbered[1]}`,
      "make id the NNNN part of the filename",
    );
  }
  const created = fm["created"] ?? "";
  const updated = fm["updated"] ?? "";
  for (const [key, value] of [
    ["created", created],
    ["updated", updated],
  ]) {
    if (value && !isIsoDate(value)) {
      add(`${key} "${value}" is not a YYYY-MM-DD date`, "use an ISO date");
    }
  }
  if (isIsoDate(created) && isIsoDate(updated) && updated < created) {
    add(
      `updated (${updated}) precedes created (${created})`,
      "bump updated to today whenever you touch the plan",
    );
  }

  const folder = file.split(/[\\/]/).at(-2) ?? "";
  const wantsActive = status === "draft" || status === "active";
  const wantsDone = status === "completed" || status === "abandoned";
  if (status && folder === "active" && !wantsActive) {
    add(
      `status "${status}" does not belong in active/`,
      `git mv the plan to docs/plans/completed/ (status stays "${status}")`,
    );
  }
  if (status && folder === "completed" && !wantsDone) {
    add(
      `status "${status}" does not belong in completed/`,
      'move the plan back to docs/plans/active/ and set status there ("draft" or "active")',
    );
  }

  for (const heading of REQUIRED_PLAN_HEADINGS) {
    if (!md.includes(heading)) {
      add(
        `missing required heading "${heading}"`,
        "add it — see docs/plans/TEMPLATE.md",
      );
    }
  }
  if (status === "completed" && /^- \[ \]/m.test(md)) {
    add(
      "completed plan still has unchecked steps",
      "tick the steps, or move the plan back to active/ with status: active",
    );
  }
  return errs;
}

/** Freshness-gate the catalogue rows between the verifier markers. */
export function checkCatalogue(
  md: string,
  now: Date = new Date(),
): CheckError[] {
  const file = "docs/knowledge-map.md";
  const start = md.indexOf(CATALOGUE_START);
  const end = md.indexOf(CATALOGUE_END);
  if (start === -1 || end === -1 || end < start) {
    return [
      err(
        file,
        `missing ${CATALOGUE_START} / ${CATALOGUE_END} markers`,
        "restore the markers around the catalogue table — the verifier reads the rows between them",
      ),
    ];
  }
  const pipeLines = md
    .slice(start, end)
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"));
  const rows = pipeLines.filter((line) => !/^\s*\|[\s:|-]+\|\s*$/.test(line));
  const dataRows = rows.slice(1); // the first pipe row is the header
  if (dataRows.length === 0) {
    return [
      err(
        file,
        "catalogue has no data rows",
        "index every doc — one row each, see the page header for the rules",
      ),
    ];
  }
  const errs: CheckError[] = [];
  dataRows.forEach((row, i) => {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 5) {
      errs.push(
        err(
          file,
          `catalogue row ${i + 1} has ${cells.length} cells (need 5)`,
          "complete the row: Doc, Audience, Covers, Verified by, Last verified",
        ),
      );
      return;
    }
    const doc = cells[0] ?? "?";
    const date = cells[4] ?? "";
    if (!isIsoDate(date)) {
      errs.push(
        err(
          file,
          `catalogue row "${doc}" ends with "${date}", not a date`,
          "set the Last verified cell to YYYY-MM-DD",
        ),
      );
      return;
    }
    const age = ageInDays(date, now);
    if (age > STALE_AFTER_DAYS) {
      errs.push(
        err(
          file,
          `"${doc}" was last verified ${date} (${age} days ago; limit ${STALE_AFTER_DAYS})`,
          're-verify the doc (run its "Verified by" backstop), then bump Last verified',
        ),
      );
    }
  });
  return errs;
}

function* walkFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "build") continue;
      yield* walkFiles(path);
    } else {
      yield path;
    }
  }
}

const mdFiles = (dir: string): string[] =>
  [...walkFiles(dir)].filter((path) => path.endsWith(".md"));

/** Run every knowledge-base check against a repo root. */
export function runAll(root: string): CheckError[] {
  const errs: CheckError[] = [];
  const rel = (path: string) => relative(root, path) || ".";
  const at = (...parts: string[]) => join(root, ...parts);

  // 1. required knowledge files exist
  for (const file of [
    "AGENTS.md",
    "docs/knowledge-map.md",
    "docs/plans/README.md",
    "docs/plans/TEMPLATE.md",
    "docs/plans/debt.md",
    "docs/plans/active/.gitkeep",
    "docs/plans/completed/.gitkeep",
    "scripts/verify-knowledge.ts",
    ".github/workflows/ci.yml",
  ]) {
    if (!existsSync(at(file))) {
      errs.push(
        err(
          file,
          "required knowledge file is missing",
          `restore it — ${file} is part of the agent-legibility skeleton (AGENTS.md § Mechanical verification)`,
        ),
      );
    }
  }

  // 2. AGENTS.md stays a table of contents
  const agentsPath = at("AGENTS.md");
  if (existsSync(agentsPath)) {
    const agents = read(agentsPath);
    const lines = agents.split("\n").length;
    if (lines > AGENTS_MAX_LINES) {
      errs.push(
        err(
          "AGENTS.md",
          `${lines} lines (max ${AGENTS_MAX_LINES})`,
          "AGENTS.md is a table of contents, not an encyclopedia — move detail into docs/ and leave a link",
        ),
      );
    }
    for (const pointer of AGENTS_POINTERS) {
      if (!agents.includes(pointer)) {
        errs.push(
          err(
            "AGENTS.md",
            `missing required pointer "${pointer}"`,
            `link "${pointer}" from the Start here table`,
          ),
        );
      }
    }
  }

  // 3. every relative markdown link resolves
  for (const file of [
    agentsPath,
    at("README.md"),
    ...mdFiles(at("docs")),
    ...mdFiles(at("examples")),
  ]) {
    if (!existsSync(file)) continue;
    const md = read(file);
    for (const target of extractRelativeLinks(md)) {
      const path = linkPath(target);
      if (path === null || path === "") continue;
      let decoded = path;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        // keep the raw target if it isn't valid percent-encoding
      }
      if (!existsSync(resolve(dirname(file), decoded))) {
        errs.push(
          err(
            rel(file),
            `broken link "${target}"`,
            "fix the link or restore the target — every relative link is verified in CI",
          ),
        );
      }
    }
  }

  // 4. the knowledge map covers every doc, example, and ExecPlan
  const mapPath = at("docs/knowledge-map.md");
  if (existsSync(mapPath)) {
    const map = read(mapPath);
    const docs = readdirSync(at("docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/${name}`);
    const examples = [...walkFiles(at("examples"))].map(rel);
    const plans = [
      ...mdFiles(at("docs/plans/active")),
      ...mdFiles(at("docs/plans/completed")),
    ].map(rel);
    for (const file of [...docs, ...examples, ...plans]) {
      if (!map.includes(file)) {
        errs.push(
          err(
            "docs/knowledge-map.md",
            `"${file}" is not indexed`,
            "add a row (or delete the file if it is dead) — the map covers every doc, example, and ExecPlan",
          ),
        );
      }
    }
    // 5. catalogue freshness
    errs.push(...checkCatalogue(map));
  }

  // 6. ExecPlan format, and unique plan numbers
  const planFiles = [
    ...mdFiles(at("docs/plans/active")),
    ...mdFiles(at("docs/plans/completed")),
  ];
  for (const file of planFiles) {
    errs.push(...checkExecPlan(rel(file), read(file)));
  }
  const seen = new Map<string, string>();
  for (const file of planFiles) {
    const numbered = /^(\d{4})-/.exec(basename(file));
    if (!numbered) continue;
    const num = numbered[1] ?? "";
    const prior = seen.get(num);
    if (prior) {
      errs.push(
        err(
          rel(file),
          `plan number ${num} is already used by ${prior}`,
          "renumber sequentially — NNNN must be unique across active/ and completed/",
        ),
      );
    } else {
      seen.set(num, rel(file));
    }
  }
  return errs;
}

if (import.meta.main) {
  const errs = runAll(resolve(import.meta.dir, ".."));
  if (errs.length > 0) {
    console.error(
      `\nknowledge-base verification failed (${errs.length} error${errs.length === 1 ? "" : "s"}):\n`,
    );
    for (const e of errs) {
      console.error(`  ${e.file}: ${e.message}`);
      console.error(`    fix: ${e.fix}`);
    }
    console.error("");
    process.exitCode = 1;
  } else {
    console.log(
      "knowledge base verified — files, AGENTS.md shape, links, coverage, freshness, ExecPlans",
    );
  }
}
