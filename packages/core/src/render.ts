import {
  anchorLabel,
  type Finding,
  type Note,
  type ReviewOutput,
} from "./types";

/**
 * Review-body rendering shared by every forge. GitHub, GitLab (and anything
 * else) all get the same Markdown: HTML-comment markers for dedup (rendered
 * invisibly on both), `<details>` blocks, and Mermaid diagrams.
 */

/** Per-reviewer marker prefixes: inline findings and the persistent summary.
 * Comments and the summary carry them so a later run can find, clean up, or
 * update its own output — and distinguish inline tags from summary tags. */
export function markerPrefix(reviewerName: string | undefined): string {
  return `<!-- loupe:${reviewerName ?? "default"} `;
}
export function summaryMarkerPrefix(reviewerName: string | undefined): string {
  return `<!-- loupe:summary:${reviewerName ?? "default"} `;
}
export function makeMarker(
  reviewerName: string | undefined,
  sha: string,
): string {
  return `${markerPrefix(reviewerName)}sha=${sha} -->`;
}
export function makeSummaryMarker(
  reviewerName: string | undefined,
  sha: string,
): string {
  return `${summaryMarkerPrefix(reviewerName)}sha=${sha} -->`;
}

/** Extract the sha a given marker prefix stamps in a body; undefined when the
 * body carries none (scoped to that marker, so unrelated text quoting a sha
 * never matches). */
export function shaFromMarker(
  body: string | null | undefined,
  prefix: string,
): string | undefined {
  if (!body) return undefined;
  const start = body.indexOf(prefix);
  if (start < 0) return undefined;
  return /sha=([0-9a-f]{7,40})\s*-->/.exec(body.slice(start))?.[1];
}

/** Parse only inline-finding markers, never summary markers. */
export function parseFindingMarker(
  body: string,
): { reviewer: string; sha: string } | undefined {
  const match =
    /<!-- loupe:(?!summary:)([^\s]+) sha=([0-9a-f]{7,40}) -->\s*$/.exec(body);
  const reviewer = match?.[1];
  const sha = match?.[2];
  return reviewer && sha ? { reviewer, sha } : undefined;
}

export const COMBINED_SUMMARY_MARKER = "<!-- loupe:summary:combined -->";

/** What to do with this reviewer's inline comments from a previous run. */
export type PriorComments = "resolve" | "delete" | "keep";

/**
 * How the run went, beyond the findings themselves. Rendered into the summary
 * so a degraded review (fallback, unverified, lossy parse) is visible on the PR
 * instead of only in the Actions log.
 */
export type ReviewDiagnostics = {
  /** How the review was produced: with tools, one-shot by design, or one-shot because the agentic run failed. */
  readonly mode: "agentic" | "headless" | "fallback";
  /** passed = complete valid verdicts applied; skipped = nothing to verify or verify off. */
  readonly verify: "passed" | "skipped" | "invalid" | "failed";
  /** unknown = history lookup or compare failed, so a full review ran without cleanup. */
  readonly incremental: "full" | "delta" | "unknown";
  readonly malformedDropped: {
    readonly findings: number;
    readonly concerns: number;
  };
  /** Findings anchored outside the reassessed files on an incremental run. */
  readonly outOfScopeDropped: number;
  /** Inline findings removed by the noise profile. */
  readonly profileDropped: number;
  /** Inline findings the verification pass judged not real. */
  readonly verifyDropped: number;
  /** Off-diff notes actually published under "Other notes". */
  readonly offDiff: number;
  /** Schema-rejected findings kept as notes instead of dropped. */
  readonly salvagedFindings: number;
};

/** True when the run lost or skipped something the reader should know about. */
export function isDegraded(d: ReviewDiagnostics): boolean {
  return (
    d.mode === "fallback" ||
    d.verify === "invalid" ||
    d.verify === "failed" ||
    d.incremental === "unknown" ||
    d.malformedDropped.findings + d.malformedDropped.concerns > 0 ||
    d.salvagedFindings > 0
  );
}

function renderDiagnostics(d: ReviewDiagnostics): string {
  const rows = [
    `- review: ${
      d.mode === "fallback" ? "headless fallback (agentic run failed)" : d.mode
    }`,
    `- verification: ${d.verify}`,
    `- scope: ${d.incremental}${d.incremental === "unknown" ? " (history lookup failed; prior comments kept)" : ""}`,
    `- dropped: ${d.malformedDropped.findings} malformed finding(s), ${d.malformedDropped.concerns} malformed concern(s), ${d.outOfScopeDropped} out of scope, ${d.profileDropped} below profile, ${d.verifyDropped} rejected by verification`,
    `- off-diff notes published: ${d.offDiff}${
      d.salvagedFindings > 0
        ? ` (${d.salvagedFindings} salvaged from malformed finding(s))`
        : ""
    }`,
  ];
  return `<details><summary>Run details</summary>\n\n${rows.join("\n")}\n\n</details>`;
}

export const SEV_EMOJI: Record<Finding["severity"], string> = {
  blocker: "🔴",
  warning: "🟡",
  nit: "🔵",
};

/** One-line severity tally across inline findings + PR-level concerns. */
export function statLine(
  inline: readonly Finding[],
  review: ReviewOutput,
  fileCount: number,
  degraded: boolean,
): string {
  const all = [...inline, ...review.concerns];
  const n = (s: Finding["severity"]): number =>
    all.filter((f) => f.severity === s).length;
  const bits: string[] = [];
  if (n("blocker")) bits.push(`🔴 ${n("blocker")}`);
  if (n("warning")) bits.push(`🟡 ${n("warning")}`);
  if (n("nit")) bits.push(`🔵 ${n("nit")}`);
  if (bits.length === 0) bits.push("✅ no issues");
  bits.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
  if (degraded) bits.push("⚠️ degraded run");
  return bits.join(" · ");
}

/**
 * The body of one inline finding comment — identical Markdown on every forge:
 * severity line, finding body, and, when the finding carries replacement code,
 * a fenced block the forge renders as a one-click-apply suggestion (GitHub
 * review comments and GitLab positioned discussions both recognize the
 * "suggestion" fence language).
 */
export function inlineFindingBody(f: Finding, tag: string): string {
  const suggestion = f.suggestion
    ? `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``
    : "";
  return `${SEV_EMOJI[f.severity]} **${f.severity}** ${f.body}${suggestion}\n\n${tag}`;
}

/** Assemble the rich Markdown review body from the structured review output. */
export function renderReviewBody(
  title: string,
  stats: string,
  review: ReviewOutput,
  inline: readonly Finding[],
  dropped: readonly Note[],
  diagnostics: ReviewDiagnostics | undefined,
  tag: string,
): string {
  const parts: string[] = [`### 🔍 ${title}\n\n${stats}`];
  if (review.summary.trim()) parts.push(review.summary.trim());

  // Concern details and note bodies are Markdown and may span paragraphs or
  // code fences, so each one is its own block rather than a bullet.
  if (review.concerns.length > 0) {
    parts.push(
      `#### Concerns\n\n${review.concerns
        .map(
          (c) =>
            `${SEV_EMOJI[c.severity]} **${c.title}**\n\n${c.detail.trim()}`,
        )
        .join("\n\n")}`,
    );
  }
  if (review.highlights.length > 0) {
    parts.push(
      `#### Highlights\n${review.highlights.map((h) => `- ✅ ${h}`).join("\n")}`,
    );
  }
  if (inline.length > 0) {
    parts.push(
      `_${inline.length} inline comment${inline.length === 1 ? "" : "s"} on the diff below._`,
    );
  }
  if (review.diagram) {
    parts.push("```mermaid\n" + review.diagram + "\n```");
  }
  if (dropped.length > 0) {
    parts.push(
      `<details><summary>Other notes (${dropped.length})</summary>\n\n${dropped
        .map((f) => {
          const head = `${SEV_EMOJI[f.severity]} \`${anchorLabel(f)}\`${
            f.line === undefined ? " _unanchored_" : ""
          }`;
          // Off-diff: a suggestion fence would be inert outside a positioned
          // note, so show the code as a plain indented fence instead.
          return f.suggestion
            ? `${head}\n\n${f.body.trim()}\n\n  ${["```", ...f.suggestion.split("\n"), "```"].join("\n  ")}`
            : `${head}\n\n${f.body.trim()}`;
        })
        .join("\n\n")}\n\n</details>`,
    );
  }
  if (diagnostics) parts.push(renderDiagnostics(diagnostics));
  parts.push(tag);
  return parts.join("\n\n");
}

function priorReviewerSection(
  priorBody: string,
  reviewer: string,
): string | undefined {
  const escaped = reviewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startMarker = `<!-- loupe:section:${reviewer}:start -->`;
  const endMarker = `<!-- loupe:section:${reviewer}:end -->`;
  const markedStart = priorBody.indexOf(startMarker);
  if (markedStart >= 0) {
    const markedEnd = priorBody.indexOf(endMarker, markedStart);
    if (markedEnd >= 0) {
      return priorBody
        .slice(markedStart + startMarker.length + 1, markedEnd)
        .trim();
    }
  }

  // Legacy combined summaries had no section boundaries. Bound the section by
  // the next generated reviewer heading/footer; accept a SHA marker only when
  // it is actually inside those bounds, never one retained at the comment end.
  const heading = `## ${reviewer}\n\n`;
  const start = priorBody.indexOf(heading);
  if (start < 0) return undefined;
  const afterHeading = start + heading.length;
  const nextHeading = priorBody.indexOf("\n\n---\n\n## ", afterHeading);
  const footer = priorBody.indexOf("\n\n---\n\nUse `@loupe fix`", afterHeading);
  const combinedMarker = priorBody.indexOf(
    "\n\n<!-- loupe:summary:combined -->",
    afterHeading,
  );
  const candidates = [nextHeading, footer, combinedMarker].filter(
    (index) => index >= 0,
  );
  const end =
    candidates.length > 0 ? Math.min(...candidates) : priorBody.length;
  const section = priorBody.slice(start, end).trim();
  const marker = new RegExp(
    `<!-- loupe:summary:${escaped} sha=[0-9a-f]{7,40} -->`,
  ).exec(section);
  return marker ? section : undefined;
}

/**
 * Carry a skipped reviewer's last real section into the new combined summary
 * instead of overwriting it with a "_Not run_" stub.
 */
export function preserveSkippedSummarySections(
  body: string,
  priorBody?: string,
): string {
  if (!priorBody) return body;

  // New combined summaries have explicit structural boundaries. Replace only
  // the content inside a skipped reviewer's own pair and retain the new pair.
  const marked = body.replace(
    /<!-- loupe:section:([^\s]+):start -->\n([\s\S]*?)\n<!-- loupe:section:\1:end -->/g,
    (section, reviewer: string, content: string) => {
      if (!/^## [^\n]+\n\n_Not run: [^\n]*_$/s.test(content.trim())) {
        return section;
      }
      const priorSection = priorReviewerSection(priorBody, reviewer);
      return priorSection
        ? `<!-- loupe:section:${reviewer}:start -->\n${priorSection}\n\n> ℹ️ Not updated in this run.\n<!-- loupe:section:${reviewer}:end -->`
        : section;
    },
  );

  // Backward compatibility for callers/new bodies created before section
  // boundaries were introduced.
  return marked.replace(
    /## ([^\n]+)\n\n_Not run: [^\n]*_(?=\n\n---|$)/g,
    (stub, reviewer: string) => {
      const priorSection = priorReviewerSection(priorBody, reviewer);
      return priorSection
        ? `${priorSection}\n\n> ℹ️ Not updated in this run.`
        : stub;
    },
  );
}
