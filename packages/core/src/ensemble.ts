import type { Finding, Note, Severity } from "./types";

const SEV_RANK: Record<Severity, number> = { blocker: 3, warning: 2, nit: 1 };

export type EnsembleResult = {
  /** Findings a majority of models agreed on — high confidence. */
  readonly confirmed: readonly Finding[];
  /** Findings only a minority raised — surfaced as lower-confidence. */
  readonly uncertain: readonly Finding[];
};

/** Majority threshold for N models: 2-of-2, 2-of-3, 3-of-4, … */
export function majority(n: number): number {
  return Math.floor(n / 2) + 1;
}

/**
 * Merge the findings from several models into agreement clusters. Two findings
 * agree when they're on the same file within a small line window AND their
 * bodies are textually similar (see {@link findingsAgree}). A cluster
 * confirmed by at least `threshold` distinct models is
 * high-confidence; the rest are uncertain. The representative is the
 * highest-severity, most detailed finding in the cluster.
 *
 * The union is sorted by (path, line) and clustered in a single left-to-right
 * pass using a fixed anchor (the earliest member), the same approach as
 * {@link dedupeFindings}. This prevents transitive chaining: without it, a
 * model's vote on a nearby-but-distinct issue could inflate an unrelated
 * finding to "confirmed" by pooling votes through an intermediate finding.
 */
export function mergeEnsemble(
  perModel: readonly (readonly Finding[])[],
  threshold: number,
): EnsembleResult {
  // Flatten into one stream tagged with model index, then sort by (path, line).
  type Member = { model: number; finding: Finding };
  const flat: Member[] = [];
  perModel.forEach((findings, model) => {
    for (const finding of findings) flat.push({ model, finding });
  });
  flat.sort((a, b) =>
    a.finding.path < b.finding.path
      ? -1
      : a.finding.path > b.finding.path
        ? 1
        : a.finding.line - b.finding.line,
  );

  // Cluster in a single left-to-right pass. A finding joins a cluster when it
  // agrees with that cluster's anchor (earliest member), not with the previous
  // finding. Since agreement now has a textual term, a dissimilar finding on
  // the same lines can start a new cluster BETWEEN two agreeing findings — so
  // scan back over every earlier cluster still within the line window, not
  // just the last one. The scan stops as soon as a cluster's anchor is too far
  // away or on another path, so it stays bounded by the window.
  type Cluster = { anchor: Member; rep: Member; models: Set<number> };
  const clusters: Cluster[] = [];
  for (const member of flat) {
    let target: Cluster | undefined;
    for (let i = clusters.length - 1; i >= 0; i--) {
      const c = clusters[i];
      if (!c) break;
      if (c.anchor.finding.path !== member.finding.path) break;
      // Anchors are sorted by line, so the first one more than a window away
      // marks the end of the scan — earlier anchors are farther still.
      if (member.finding.line - c.anchor.finding.line > 5) break;
      if (findingsAgree(c.anchor.finding, member.finding)) {
        target = c;
        break;
      }
    }
    if (target) {
      target.models.add(member.model);
      if (isStronger(member.finding, target.rep.finding)) target.rep = member;
    } else {
      clusters.push({
        anchor: member,
        rep: member,
        models: new Set([member.model]),
      });
    }
  }

  const confirmed: Finding[] = [];
  const uncertain: Finding[] = [];
  for (const c of clusters) {
    (c.models.size >= threshold ? confirmed : uncertain).push(c.rep.finding);
  }
  return { confirmed, uncertain };
}

function isStronger(a: Finding, b: Finding): boolean {
  if (SEV_RANK[a.severity] !== SEV_RANK[b.severity]) {
    return SEV_RANK[a.severity] > SEV_RANK[b.severity];
  }
  return a.body.length > b.body.length;
}

/**
 * A finding tagged with the reviewer (or single-model run) that produced it.
 * The reviewer name is carried through so the dedupe can hand the surviving
 * representative back to the right reviewer for posting.
 */
export type ReviewerFindings = {
  readonly reviewer: string;
  readonly findings: readonly Finding[];
};

/**
 * Result of cross-reviewer dedupe: one reviewer's surviving inline findings
 * (after near-duplicates raised by other reviewers were suppressed) plus the
 * number that were dropped as duplicates of a finding kept by another reviewer.
 */
export type DedupeResult = {
  readonly reviewer: string;
  readonly inline: readonly Finding[];
  readonly suppressed: number;
};

/**
 * Similarity gate for body comparison: character-trigram Jaccard.
 *
 * Calibration (see the bodySimilarity tests in packages/core/tests/diff.test.ts):
 * real cross-model agreements (same defect, rephrased) score >= 0.09 even for
 * one-line bodies, while same-line findings describing *different* defects
 * score <= ~0.13 with the observed worst case at 0.133 — the classes are close,
 * so the threshold is deliberately inclusive (issue #40: a missed agreement
 * only demotes a finding to the uncertain section, and verify + the profile
 * severity filter still gate what gets posted; a false merge would post a
 * confirmed wrong comment, but position agreement below this threshold is
 * overwhelmingly unrelated same-line noise, which scores at the floor).
 *
 * Trigram sets are cheap to build but pair comparisons are quadratic, so cache
 * them per body string. The cache lives for the process; bodies are short and
 * bounded by the size of a review, so unbounded growth isn't a concern.
 */
export const SIMILARITY_THRESHOLD = 0.1;

const trigramCache = new Map<string, Set<string>>();

function trigrams(s: string): Set<string> {
  const cached = trigramCache.get(s);
  if (cached) return cached;
  const normalized = s.toLowerCase().replace(/\s+/g, " ").trim();
  const set = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i++)
    set.add(normalized.slice(i, i + 3));
  trigramCache.set(s, set);
  return set;
}

/**
 * Character-trigram Jaccard similarity between two strings, 0–1. Robust to word
 * order and punctuation for short review prose — the reason to use this over
 * token Jaccard: "SQL injection, unsanitized input" vs "user input not
 * parameterized, injection" still scores high.
 */
export function bodySimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 && B.size === 0) return 1; // both empty → treat as equal
  if (A.size === 0 || B.size === 0) return 0; // one empty → nothing in common
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Bodies too short for trigram Jaccard to be meaningful. */
function isDegenerateBody(s: string): boolean {
  return trigrams(s).size < 3;
}

/**
 * Findings agree when they're on the same file within `proximity` lines of each
 * other (default 5, matching `mergeEnsemble`) AND their bodies are similar.
 * Position is the cheap pre-filter; only positional candidates pay the
 * trigram comparison. We deliberately err on the side of leaving things in: a
 * degenerate (one-liner) body falls back to position-only agreement within the
 * tight 3-line window, and the threshold is low because a missed agreement
 * costs a finding its confirmed status while a false merge costs one comment.
 */
export function findingsAgree(a: Finding, b: Finding, proximity = 5): boolean {
  if (a.path !== b.path) return false;
  const near = Math.abs(a.line - b.line);
  // Degenerate (one-liner) bodies carry too few trigrams for a meaningful
  // similarity score, so fall back to position-only agreement — but only
  // within the tight 3-line window, so a tiny body can't merge with something
  // anchored far away.
  if (isDegenerateBody(a.body) || isDegenerateBody(b.body)) {
    return near <= 3;
  }
  return (
    near <= proximity && bodySimilarity(a.body, b.body) >= SIMILARITY_THRESHOLD
  );
}

/**
 * Deduplicate the union of several reviewers' inline findings before they're
 * published, so the same reworded claim raised by two reviewers posts once.
 *
 * Two findings are the same claim when they're on the same file within
 * `proximity` lines of each other AND their bodies are textually similar
 * (see {@link findingsAgree}). The union is sorted by (path, line) and
 * clustered in a single left-to-right pass: a finding joins the current cluster
 * only when it agrees with that cluster's **anchor** — its earliest member —
 * not with the previous finding. This prevents transitive chaining, where a
 * run of findings each within proximity of the next would collapse unrelated
 * issues that happen to sit a few lines apart into one survivor.
 *
 * Each cluster collapses to a single representative — the strongest
 * (highest-severity, then longest body) — attributed to the reviewer that
 * raised it. Other reviewers' copies are suppressed and counted. A reviewer
 * keeps a finding only when it owns the representative of that finding's
 * cluster; every other copy is dropped.
 *
 * Deterministic: sorting by (path, line) makes the result independent of
 * reviewer order. When two findings tie on severity and body length, the one
 * at the earlier line (then earlier in the flattened stream) is kept.
 */
export function dedupeFindings(
  perReviewer: readonly ReviewerFindings[],
  proximity = 3,
): DedupeResult[] {
  // Flatten into one stream tagged with reviewer, then sort by (path, line) so
  // findings on the same file are contiguous and in line order.
  type Member = { reviewer: string; finding: Finding };
  const flat: Member[] = [];
  for (const { reviewer, findings } of perReviewer) {
    for (const finding of findings) flat.push({ reviewer, finding });
  }
  flat.sort((a, b) =>
    a.finding.path < b.finding.path
      ? -1
      : a.finding.path > b.finding.path
        ? 1
        : a.finding.line - b.finding.line,
  );

  // Cluster in a single left-to-right pass. Each cluster's anchor is its
  // first (earliest-line) member; a finding joins only if it agrees with the
  // anchor. Agreement has a textual term, so a dissimilar finding on the same
  // lines can start a new cluster BETWEEN two agreeing findings — scan back
  // over every earlier cluster still within `proximity`, not just the last
  // one. The scan stops at the first anchor beyond the window (anchors are
  // line-sorted) or on a different path.
  type Cluster = { anchor: Member; rep: Member; members: Member[] };
  const clusters: Cluster[] = [];
  for (const member of flat) {
    let target: Cluster | undefined;
    for (let i = clusters.length - 1; i >= 0; i--) {
      const c = clusters[i];
      if (!c) break;
      if (c.anchor.finding.path !== member.finding.path) break;
      if (member.finding.line - c.anchor.finding.line > proximity) break;
      if (findingsAgree(c.anchor.finding, member.finding, proximity)) {
        target = c;
        break;
      }
    }
    if (target) {
      target.members.push(member);
      if (isStronger(member.finding, target.rep.finding)) target.rep = member;
    } else {
      clusters.push({ anchor: member, rep: member, members: [member] });
    }
  }

  // Each cluster has exactly one owner (the reviewer of its representative).
  // The owner posts the representative once; every other member is a duplicate
  // and gets suppressed + counted.
  const byReviewer = new Map<string, { inline: Finding[]; suppressed: number }>(
    perReviewer.map((r) => [r.reviewer, { inline: [], suppressed: 0 }]),
  );
  for (const c of clusters) {
    const ownerSlot = byReviewer.get(c.rep.reviewer);
    if (ownerSlot) ownerSlot.inline.push(c.rep.finding);
    for (const m of c.members) {
      if (m.reviewer === c.rep.reviewer) continue;
      const slot = byReviewer.get(m.reviewer);
      if (!slot) continue; // reviewer with no findings still listed in result
      slot.suppressed++;
    }
  }
  return perReviewer.map((r) => {
    const slot = byReviewer.get(r.reviewer);
    // byReviewer is built from perReviewer keys, so every reviewer maps to its slot.
    if (!slot)
      throw new Error(`dedupeFindings: no slot for reviewer ${r.reviewer}`);
    return {
      reviewer: r.reviewer,
      inline: slot.inline,
      suppressed: slot.suppressed,
    };
  });
}

/**
 * Union several models' off-diff notes, collapsing reworded copies of the
 * same note. Notes have no reliable line anchor (a `line` may be missing
 * entirely, or salvaged from a malformed finding), so agreement is decided
 * solely on path + body similarity — no line term.
 *
 * Deterministic: notes are grouped by path (paths emit in first-seen order,
 * notes within a path in leg order, and the ensemble leg order is fixed), so
 * first-model-wins. A note is kept only when its body differs from EVERY note
 * kept so far on the same path — a last-note-only comparison would let an
 * unrelated note sit between two reworded copies and hide the match, since
 * trigram similarity doesn't follow lexicographic order.
 */
export function dedupeNotes(noteLists: readonly (readonly Note[])[]): Note[] {
  const flat: Note[] = [];
  for (const list of noteLists) flat.push(...list);
  const byPath = new Map<string, Note[]>();
  for (const note of flat) {
    const kept = byPath.get(note.path) ?? [];
    const dup = kept.some(
      (k) => bodySimilarity(k.body, note.body) >= SIMILARITY_THRESHOLD,
    );
    if (!dup) {
      kept.push(note);
      byPath.set(note.path, kept);
    }
  }
  const out: Note[] = [];
  const seen = new Set<string>();
  for (const note of flat) {
    if (seen.has(note.path)) continue;
    seen.add(note.path);
    out.push(...(byPath.get(note.path) ?? []));
  }
  return out;
}
