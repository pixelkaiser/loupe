import type { Finding, ReviewOutput } from "./types";

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
  return bits.join(" · ");
}

/** Assemble the rich Markdown review body from the structured review output. */
export function renderReviewBody(
  title: string,
  stats: string,
  review: ReviewOutput,
  inline: readonly Finding[],
  dropped: readonly Finding[],
  tag: string,
): string {
  const parts: string[] = [`### 🔍 ${title}\n\n${stats}`];
  if (review.summary.trim()) parts.push(review.summary.trim());

  if (review.concerns.length > 0) {
    parts.push(
      `#### Concerns\n${review.concerns
        .map(
          (c) =>
            `- ${SEV_EMOJI[c.severity]} **${c.title}** — ${c.detail.replace(/\n/g, " ")}`,
        )
        .join("\n")}`,
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
        .map(
          (f) =>
            `- ${SEV_EMOJI[f.severity]} \`${f.path}:${f.line}\` — ${f.body.replace(/\n/g, " ")}`,
        )
        .join("\n")}\n\n</details>`,
    );
  }
  parts.push(tag);
  return parts.join("\n\n");
}
