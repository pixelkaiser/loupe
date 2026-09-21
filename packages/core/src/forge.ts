import type { DiffFile } from "./diff";
import type { PriorComments, ReviewDiagnostics } from "./render";
import type { Finding, Note, ReviewOutput } from "./types";

/**
 * A forge is where the code lives and reviews land (GitHub, GitLab, …). The
 * engine (`runReview`) talks only to this interface — each adapter owns its
 * ref shape (PR `owner/repo#n`, MR `project!iid`, …) and its API client.
 * Factories take the token/logger/base-URL from the entry layer, so core
 * never reads the environment.
 */
export type Forge<R> = {
  readonly name: string;
  /** Human-readable ref for logs (e.g. "owner/repo#123", "group/proj!42"). */
  describeRef(ref: R): string;
  /** Stable repo identity (no PR number) for prompt-cache keys, e.g.
   * "owner/repo" or "group/project" — same repo must yield the same key. */
  repoRef(ref: R): string;
  /** Fetch PR/MR metadata and the changed files (with patches) in one place. */
  fetchPullContext(ref: R): Promise<PullContext>;
  /**
   * Fetch the target repo's own convention docs at the PR/MR head, in
   * priority order. Concatenated so the reviewer enforces the repo's actual
   * rules rather than a vendored copy. Missing files are skipped silently.
   */
  fetchConventions(ref: R, paths: readonly string[]): Promise<Conventions>;
  /**
   * The head SHA this reviewer last reviewed, read from the sha stamped in
   * its most recent summary/review marker. `unknown: true` means the history
   * lookup itself failed (full review, prior comments left alone).
   */
  getLastReviewed(
    ref: R,
    reviewerName: string | undefined,
  ): Promise<LastReviewed>;
  /** Files changed between two commits (the incremental-review delta). */
  changedFilesBetween(ref: R, base: string, head: string): Promise<Set<string>>;
  /**
   * Resolve or delete prior inline threads stranded by a rename or deletion
   * (anchored at a path that no longer exists at head). Best-effort.
   */
  cleanupStrandedThreads(
    ref: R,
    headPaths: ReadonlySet<string>,
    options?: { reviewerName?: string; priorComments?: PriorComments },
  ): Promise<void>;
  /** Post a top-level PR/MR comment (used for chat replies). */
  postIssueComment(ref: R, body: string): Promise<void>;
  /**
   * Create or update the single combined summary comment that aggregates all
   * reviewers (supersedes the per-reviewer persistent summaries).
   */
  upsertCombinedSummary(ref: R, body: string): Promise<void>;
  /**
   * Post one review with inline comments. First clears this reviewer's
   * comments from the previous run so re-reviews replace rather than
   * accumulate. Returns the summary body it published (or would have, when
   * `deferSummary` set it aside for a combined summary).
   */
  postReview(
    ref: R,
    review: ReviewOutput,
    inline: readonly Finding[],
    dropped: readonly Note[],
    opts: PostReviewOptions,
  ): Promise<string | undefined>;
};

export type PullContext = {
  readonly title: string;
  readonly description: string;
  readonly files: readonly DiffFile[];
  /** The PR/MR head commit SHA (what this review is of). */
  readonly headSha: string;
  /** Every file path that exists at head (the full PR/MR file list). */
  readonly headPaths: ReadonlySet<string>;
};

/**
 * The outcome of the last-reviewed history lookup: either a known state
 * (with the SHA when this reviewer reviewed before) or `unknown` when the
 * lookup itself failed.
 */
export type LastReviewed =
  | { readonly unknown: false; readonly sha?: string }
  | { readonly unknown: true; readonly reason: string };

export type Conventions = {
  /** Concatenated doc bodies for the prompt. */
  readonly text: string;
  /** Which requested paths actually resolved to a file at the PR/MR head. */
  readonly found: readonly string[];
};

export type PostReviewOptions = {
  readonly reviewerName?: string;
  /** PR/MR head SHA to stamp in the marker (for incremental review next time). */
  readonly headSha: string;
  /**
   * Prior-comment cleanup scope: undefined = every marked comment of this
   * reviewer, empty set = clean up nothing, otherwise only those paths.
   */
  readonly refreshPaths?: ReadonlySet<string>;
  /**
   * Paths that exist at head (the full PR/MR file list). A prior thread
   * anchored at any other path is stranded — its file was renamed or deleted —
   * and is swept regardless of scope.
   */
  readonly headPaths?: ReadonlySet<string>;
  /** Files in scope, for the stat line. */
  readonly fileCount: number;
  /** What to do with prior inline comments (default resolve). */
  readonly priorComments?: PriorComments;
  /** Run diagnostics for the summary; omitted = not rendered. */
  readonly diagnostics?: ReviewDiagnostics;
  /** Let a higher-level orchestrator publish one summary for all reviewers. */
  readonly deferSummary?: boolean;
};
