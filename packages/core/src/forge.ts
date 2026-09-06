import type { DiffFile } from "./diff";
import type { Finding, ReviewOutput } from "./types";

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
   * its most recent review's marker. Undefined if it never reviewed.
   */
  getLastReviewedSha(
    ref: R,
    reviewerName: string | undefined,
  ): Promise<string | undefined>;
  /** Files changed between two commits (the incremental-review delta). */
  changedFilesBetween(ref: R, base: string, head: string): Promise<Set<string>>;
  /** Post a top-level PR/MR comment (used for chat replies). */
  postIssueComment(ref: R, body: string): Promise<void>;
  /**
   * Post one review with inline comments. First clears this reviewer's
   * comments from the previous run so re-reviews replace rather than
   * accumulate.
   */
  postReview(
    ref: R,
    review: ReviewOutput,
    inline: readonly Finding[],
    dropped: readonly Finding[],
    opts: PostReviewOptions,
  ): Promise<void>;
};

export type PullContext = {
  readonly title: string;
  readonly description: string;
  readonly files: readonly DiffFile[];
  /** The PR/MR head commit SHA (what this review is of). */
  readonly headSha: string;
};

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
  /** Incremental review: only replace prior comments on these files. */
  readonly refreshPaths?: ReadonlySet<string>;
  /** Files in scope, for the stat line. */
  readonly fileCount: number;
};
