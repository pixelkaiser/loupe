import { Octokit } from "@octokit/rest";

import type { Logger } from "@loupe/logger";

import type {
  Conventions,
  Forge,
  LastReviewed,
  PostReviewOptions,
  PullContext,
} from "./forge";
import {
  COMBINED_SUMMARY_MARKER,
  inlineFindingBody,
  isDegraded,
  makeMarker,
  makeSummaryMarker,
  markerPrefix,
  parseFindingMarker,
  preserveSkippedSummarySections,
  renderReviewBody,
  shaFromMarker,
  statLine,
  summaryMarkerPrefix,
  type PriorComments,
} from "./render";
import type { Finding, Note, ReviewOutput } from "./types";

export type PullRef = {
  readonly owner: string;
  readonly repo: string;
  readonly pull_number: number;
};

/**
 * Octokit's default logger prints request warnings (like the expected 404s from
 * probing for optional convention docs) straight to the console. Route them all
 * through our logger at debug so they don't clutter info-level output.
 */
export function makeOctokit(token: string, logger: Logger): Octokit {
  return new Octokit({
    auth: token,
    log: {
      debug: (m) => logger.debug(m),
      info: (m) => logger.debug(m),
      warn: (m) => logger.debug(m),
      error: (m) => logger.debug(m),
    },
  });
}

/**
 * The GitHub forge: the octokit-backed functions below wrapped in the
 * `Forge<PullRef>` interface `runReview` consumes. The chat/fix path
 * (`packages/action/src/respond.ts`) still calls the functions directly —
 * it is GitHub-only until GitLab chat exists.
 */
export function makeGithubForge(token: string, logger: Logger): Forge<PullRef> {
  return githubForgeFor(makeOctokit(token, logger), logger);
}

/** The forge built around an existing client — the seam tests inject fakes at. */
export function githubForgeFor(
  octokit: Octokit,
  logger: Logger,
): Forge<PullRef> {
  return {
    name: "github",
    describeRef: (ref) => `${ref.owner}/${ref.repo}#${ref.pull_number}`,
    repoRef: (ref) => `${ref.owner}/${ref.repo}`,
    fetchPullContext: (ref) => fetchPullContext(octokit, ref),
    fetchConventions: (ref, paths) => fetchConventions(octokit, ref, paths),
    getLastReviewed: (ref, reviewerName) =>
      getLastReviewed(octokit, ref, reviewerName),
    changedFilesBetween: (ref, base, head) =>
      changedFilesBetween(octokit, ref, base, head),
    cleanupStrandedThreads: (ref, headPaths, options) =>
      cleanupStrandedThreads(octokit, ref, headPaths, logger, options),
    postIssueComment: async (ref, body) => {
      await postIssueComment(octokit, ref, body);
    },
    upsertCombinedSummary: (ref, body) =>
      upsertCombinedSummary(octokit, ref, body),
    postReview: (ref, review, inline, dropped, opts) =>
      postReview(octokit, ref, review, inline, dropped, logger, opts),
  };
}

/** Fetch PR metadata and the changed files (with patches) in one place. */
export async function fetchPullContext(
  octokit: Octokit,
  ref: PullRef,
): Promise<PullContext> {
  const { data: pr } = await octokit.pulls.get(ref);
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    ...ref,
    per_page: 100,
  });
  return {
    title: pr.title,
    description: pr.body ?? "",
    files: files.map((f) => ({ path: f.filename, patch: f.patch })),
    headSha: pr.head.sha,
    headPaths: new Set(files.map((f) => f.filename)),
  };
}

/** Login the workflow token posts as when `GET /user` is unavailable to it. */
const ACTIONS_BOT_LOGIN = "github-actions[bot]";
const selfLogins = new WeakMap<Octokit, Promise<string>>();

/**
 * The login loupe's own comments and reviews carry. A PAT or app user token
 * answers `GET /user`; the default Actions token cannot, and posts as
 * github-actions[bot]. Marker text alone is not proof of authorship: a human
 * quoting loupe output carries the marker too, so every "is this mine" check
 * pairs the marker with this login.
 */
export function getSelfLogin(octokit: Octokit): Promise<string> {
  let cached = selfLogins.get(octokit);
  if (!cached) {
    cached = octokit.users
      .getAuthenticated()
      .then((r) => r.data.login)
      .catch(() => ACTIONS_BOT_LOGIN);
    selfLogins.set(octokit, cached);
  }
  return cached;
}

/**
 * What we know about this reviewer's previous review of the PR. `unknown`
 * means the lookup itself failed, which is different from "no prior review":
 * the caller must then do a full review without touching prior comments.
 */
/**
 * The head SHA this reviewer last reviewed, read from its persistent summary
 * comment. Legacy review-body markers remain a fallback for existing PRs.
 */
export async function getLastReviewed(
  octokit: Octokit,
  ref: PullRef,
  reviewerName: string | undefined,
): Promise<LastReviewed> {
  try {
    const self = await getSelfLogin(octokit);
    const comments = await listIssueComments(octokit, ref);
    for (const comment of comments.reverse()) {
      if (comment.user?.login !== self) continue;
      const sha = shaFromMarker(
        comment.body,
        summaryMarkerPrefix(reviewerName),
      );
      if (sha) return { unknown: false, sha };
    }

    const reviews = await octokit.paginate(octokit.pulls.listReviews, {
      ...ref,
      per_page: 100,
    });
    for (const review of reviews.reverse()) {
      if (review.user?.login !== self) continue;
      const sha = shaFromMarker(review.body, markerPrefix(reviewerName));
      if (sha) return { unknown: false, sha };
    }
  } catch (err) {
    return {
      unknown: true,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { unknown: false };
}

/** Post a top-level PR comment (used for chat replies). Returns the comment id. */
export async function postIssueComment(
  octokit: Octokit,
  ref: PullRef,
  body: string,
): Promise<number> {
  const { data } = await octokit.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pull_number,
    body,
  });
  return data.id;
}

/** Replace the body of a top-level PR comment (e.g. turn an "On it" ack into its result). */
export async function updateIssueComment(
  octokit: Octokit,
  ref: PullRef,
  commentId: number,
  body: string,
): Promise<void> {
  await octokit.issues.updateComment({
    owner: ref.owner,
    repo: ref.repo,
    comment_id: commentId,
    body,
  });
}

/** GitHub's compare endpoint lists at most this many files; at the cap the list may be incomplete. */
const COMPARE_FILE_CAP = 300;

/**
 * Files changed between two commits (the incremental-review delta). Throws
 * when the response hits GitHub's file cap, because a silently truncated delta
 * would drop files from the review and then advance the reviewed SHA past them.
 *
 * Renamed files need no special handling here: threads stranded at a vanished
 * old path are swept by `snapshotPriorComments` (via `headPaths`), which covers
 * renames, delete+add rewrites, deletions, and full reviews alike.
 */
export async function changedFilesBetween(
  octokit: Octokit,
  ref: PullRef,
  base: string,
  head: string,
): Promise<Set<string>> {
  const { data } = await octokit.repos.compareCommits({
    owner: ref.owner,
    repo: ref.repo,
    base,
    head,
  });
  const files = data.files ?? [];
  if (files.length >= COMPARE_FILE_CAP) {
    throw new Error(
      `compare ${base.slice(0, 7)}..${head.slice(0, 7)} returned ${files.length} files (GitHub cap); delta may be incomplete`,
    );
  }
  return new Set(files.map((f) => f.filename));
}

/**
 * Fetch the target repo's own convention docs at the PR head, in priority
 * order. Concatenated so the reviewer enforces the repo's actual rules rather
 * than a vendored copy. Missing files are skipped silently.
 */
export async function fetchConventions(
  octokit: Octokit,
  ref: PullRef,
  paths: readonly string[],
): Promise<Conventions> {
  const { data: pr } = await octokit.pulls.get(ref);
  const sha = pr.head.sha;
  const parts: string[] = [];
  const found: string[] = [];
  for (const path of paths) {
    try {
      const { data } = await octokit.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path,
        ref: sha,
      });
      if ("content" in data && data.type === "file") {
        const text = Buffer.from(data.content, "base64").toString("utf8");
        parts.push(`# ${path}\n\n${text}`);
        found.push(path);
      }
    } catch {
      // file not present at head — skip
    }
  }
  return { text: parts.join("\n\n---\n\n"), found };
}

async function listIssueComments(octokit: Octokit, ref: PullRef) {
  return octokit.paginate(octokit.issues.listComments, {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pull_number,
    per_page: 100,
  });
}

/** Prior loupe comments selected for cleanup, captured before the new review posts. */
type PriorSnapshot = {
  readonly commentIds: readonly number[];
  readonly threadIds: readonly string[];
};

const EMPTY_SNAPSHOT: PriorSnapshot = { commentIds: [], threadIds: [] };

export type OpenLoupeFinding = {
  readonly reviewer: string;
  readonly path: string;
  readonly line?: number;
  readonly body: string;
  readonly sha: string;
  readonly url?: string;
};

type ReviewThreadsPage = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ReadonlyArray<{
          id: string;
          path: string;
          line: number | null;
          isResolved: boolean;
          viewerCanResolve: boolean;
          comments: {
            nodes: ReadonlyArray<{
              body: string;
              url: string;
              author: { login: string } | null;
              replyTo: { id: string } | null;
            } | null>;
          };
        } | null>;
      };
    };
  };
};

const REVIEW_THREADS_QUERY = `
query LoupeReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          path
          line
          isResolved
          viewerCanResolve
          comments(first: 1) {
            nodes { body url author { login } replyTo { id } }
          }
        }
      }
    }
  }
}`;

/** List unresolved findings across configured reviewers, including findings
 * retained by incremental reviews from an earlier head. */
export async function listOpenLoupeFindings(
  octokit: Octokit,
  ref: PullRef,
  _headSha: string,
  reviewers?: ReadonlySet<string>,
): Promise<OpenLoupeFinding[]> {
  const self = await getSelfLogin(octokit);
  const findings: OpenLoupeFinding[] = [];
  let after: string | null = null;
  do {
    const page: ReviewThreadsPage = await octokit.graphql(
      REVIEW_THREADS_QUERY,
      {
        owner: ref.owner,
        repo: ref.repo,
        number: ref.pull_number,
        after,
      },
    );
    const conn = page.repository.pullRequest.reviewThreads;
    for (const thread of conn.nodes) {
      if (!thread || thread.isResolved) continue;
      const root = thread.comments.nodes[0];
      const rootAuthor = root?.author?.login;
      const authoredBySelf =
        rootAuthor === self ||
        (self === "github-actions[bot]" && rootAuthor === "github-actions");
      if (!root || root.replyTo || !authoredBySelf) continue;
      const marker = parseFindingMarker(root.body);
      if (!marker) continue;
      if (reviewers && !reviewers.has(marker.reviewer)) continue;
      const body = root.body
        .replace(
          /\n\n<!-- loupe:(?!summary:)[^\s]+ sha=[0-9a-f]{7,40} -->\s*$/,
          "",
        )
        .trim();
      findings.push({
        reviewer: marker.reviewer,
        path: thread.path,
        ...(thread.line === null ? {} : { line: thread.line }),
        body,
        sha: marker.sha,
        ...(root.url ? { url: root.url } : {}),
      });
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return findings.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.reviewer.localeCompare(b.reviewer),
  );
}

const RESOLVE_THREAD_MUTATION = `
mutation LoupeResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

/**
 * Take a point-in-time snapshot of this reviewer's prior comments eligible for
 * cleanup, so re-reviews replace rather than duplicate. Only comments posted
 * under loupe's own login with this reviewer's marker qualify; a human quoting
 * the marker is left alone. `scope` selects which paths are eligible:
 * `undefined` = every such comment, otherwise only those paths. Runs BEFORE
 * the new review posts so the snapshot can never include the replacements.
 * Best-effort: a failed lookup selects nothing and warns.
 */
async function snapshotPriorComments(
  octokit: Octokit,
  ref: PullRef,
  reviewerName: string | undefined,
  policy: PriorComments,
  logger: Logger,
  scope?: (path: string) => boolean,
): Promise<PriorSnapshot> {
  if (policy === "keep") return EMPTY_SNAPSHOT;
  const prefix = markerPrefix(reviewerName);
  try {
    const self = await getSelfLogin(octokit);
    if (policy === "delete") {
      const comments = await octokit.paginate(
        octokit.pulls.listReviewComments,
        {
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.pull_number,
          per_page: 100,
        },
      );
      return {
        commentIds: comments
          .filter(
            (c) =>
              c.user?.login === self &&
              c.body.includes(prefix) &&
              (!scope || (c.path !== undefined && scope(c.path))),
          )
          .map((c) => c.id),
        threadIds: [],
      };
    }
    const threadIds: string[] = [];
    let after: string | null = null;
    do {
      const page: ReviewThreadsPage = await octokit.graphql(
        REVIEW_THREADS_QUERY,
        {
          owner: ref.owner,
          repo: ref.repo,
          number: ref.pull_number,
          after,
        },
      );
      const conn = page.repository.pullRequest.reviewThreads;
      for (const t of conn.nodes) {
        if (!t || t.isResolved || (scope && !scope(t.path))) continue;
        const root = t.comments.nodes[0];
        if (!root || root.replyTo || root.author?.login !== self) continue;
        if (!root.body.includes(prefix)) continue;
        if (!t.viewerCanResolve) {
          logger.warn("Cannot resolve a prior loupe thread; leaving it open", {
            thread: t.id,
            path: t.path,
          });
          continue;
        }
        threadIds.push(t.id);
      }
      after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (after);
    return { commentIds: [], threadIds };
  } catch (err) {
    logger.warn(
      "Could not look up prior loupe comments; leaving them in place",
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return EMPTY_SNAPSHOT;
  }
}

/**
 * Apply the cleanup policy to a snapshot taken before posting. Each deletion
 * or resolution fails independently; a failure never blocks the others and
 * never touches anything outside the snapshot.
 */
async function cleanupPriorComments(
  octokit: Octokit,
  ref: PullRef,
  snapshot: PriorSnapshot,
  logger: Logger,
): Promise<void> {
  for (const id of snapshot.commentIds) {
    try {
      await octokit.pulls.deleteReviewComment({
        owner: ref.owner,
        repo: ref.repo,
        comment_id: id,
      });
    } catch (err) {
      logger.warn("Could not delete a prior loupe comment", {
        comment: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  for (const threadId of snapshot.threadIds) {
    try {
      await octokit.graphql(RESOLVE_THREAD_MUTATION, { threadId });
    } catch (err) {
      logger.warn("Could not resolve a prior loupe thread", {
        thread: threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const n = snapshot.commentIds.length + snapshot.threadIds.length;
  if (n > 0) logger.debug("Cleaned up prior loupe comments", { count: n });
}

/**
 * The cleanup scope for prior-comment snapshotting: `undefined` = every marked
 * comment of this reviewer, otherwise only those paths — plus, always, any path
 * that no longer exists at head. A thread anchored at a vanished path (renamed
 * or deleted since it was posted) can never be superseded by a scoped refresh,
 * so it is swept regardless of scope rather than stranded forever. Threads on
 * paths that still exist stay bound to the scope filter.
 */
function scopeFor(
  refreshPaths: ReadonlySet<string> | undefined,
  headPaths: ReadonlySet<string> | undefined,
): ((path: string) => boolean) | undefined {
  // An empty refresh set means "clean up nothing"; keep that strictness.
  if (!refreshPaths) return undefined;
  if (refreshPaths.size === 0) return () => false;
  if (!headPaths) return (path) => refreshPaths.has(path);
  return (path) => refreshPaths.has(path) || !headPaths.has(path);
}

/**
 * Resolve or delete this reviewer's prior loupe comments anchored at paths that
 * no longer exist at head — stranded by a rename or deletion, where no scoped
 * refresh can ever reach them. Best-effort: failures leave threads in place.
 */
export async function cleanupStrandedThreads(
  octokit: Octokit,
  ref: PullRef,
  headPaths: ReadonlySet<string>,
  logger: Logger,
  options?: { reviewerName?: string; priorComments?: PriorComments },
): Promise<void> {
  const policy = options?.priorComments ?? "resolve";
  if (policy === "keep") return;
  const snapshot = await snapshotPriorComments(
    octokit,
    ref,
    options?.reviewerName,
    policy,
    logger,
    (path) => !headPaths.has(path),
  );
  await cleanupPriorComments(octokit, ref, snapshot, logger);
}

/**
 * Post inline findings as an empty-body review and create or update this
 * reviewer's persistent issue-comment summary. Uses REQUEST_CHANGES when any
 * finding is a blocker, otherwise COMMENT — never APPROVE (a bot shouldn't be a
 * required approver). Prior inline comments are cleared before replacements are
 * posted; off-diff findings remain in the summary.
 */
/** Create or update the single summary assembled after parallel reviewers finish. */
export async function upsertCombinedSummary(
  octokit: Octokit,
  ref: PullRef,
  body: string,
): Promise<void> {
  const self = await getSelfLogin(octokit);
  const comments = await listIssueComments(octokit, ref);
  const prior = comments
    .reverse()
    .find(
      (comment) =>
        comment.user?.login === self &&
        comment.body?.includes(COMBINED_SUMMARY_MARKER),
    );
  const mergedBody = preserveSkippedSummarySections(body, prior?.body);
  const currentReviewers = new Set(
    [
      ...mergedBody.matchAll(
        /<!-- loupe:summary:([^\s]+) sha=[0-9a-f]{7,40} -->/g,
      ),
    ].map((match) => match[1]),
  );
  const retainedMarkers = comments
    .filter((comment) => comment.user?.login === self)
    .flatMap((comment) => [
      ...(comment.body?.matchAll(
        /<!-- loupe:summary:([^\s]+) sha=[0-9a-f]{7,40} -->/g,
      ) ?? []),
    ])
    .filter((match) => match[1] && !currentReviewers.has(match[1]))
    .map((match) => match[0]);
  const markedBody = [
    mergedBody.trim(),
    ...new Set(retainedMarkers),
    COMBINED_SUMMARY_MARKER,
  ].join("\n\n");
  if (prior) {
    await octokit.issues.updateComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: prior.id,
      body: markedBody,
    });
  } else {
    await octokit.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.pull_number,
      body: markedBody,
    });
  }

  // Preserve legacy comments for history, but tag them as stale only after the
  // replacement exists. Updating is best-effort and never invalidates a review.
  for (const comment of comments) {
    if (
      comment.id !== prior?.id &&
      comment.user?.login === self &&
      comment.body?.includes("<!-- loupe:summary:") &&
      !comment.body.includes(COMBINED_SUMMARY_MARKER) &&
      !comment.body.includes("<!-- loupe:summary:stale -->")
    ) {
      try {
        await octokit.issues.updateComment({
          owner: ref.owner,
          repo: ref.repo,
          comment_id: comment.id,
          body: `${comment.body.trim()}\n\n> ℹ️ This legacy reviewer summary is stale. Loupe now publishes a single combined summary.\n\n<!-- loupe:summary:stale -->`,
        });
      } catch {
        // The combined summary is already live; a legacy-tagging failure must
        // not turn a completed review into a failed one.
      }
    }
  }
}

export async function postReview(
  octokit: Octokit,
  ref: PullRef,
  review: ReviewOutput,
  inline: readonly Finding[],
  dropped: readonly Note[],
  logger: Logger,
  opts: PostReviewOptions,
): Promise<string> {
  // Snapshot first, post second, clean up last: a failed post must never leave
  // the PR with its old comments gone and no replacement.
  // Snapshot first, post second, clean up last: a failed post must never leave
  // the PR with its old comments gone and no replacement. An empty refresh set
  // means "clean up nothing" (unknown history) — skip the lookup entirely.
  const prior =
    opts.refreshPaths?.size === 0
      ? EMPTY_SNAPSHOT
      : await snapshotPriorComments(
          octokit,
          ref,
          opts.reviewerName,
          opts.priorComments ?? "resolve",
          logger,
          scopeFor(opts.refreshPaths, opts.headPaths),
        );

  const hasBlocker = [...inline, ...review.concerns].some(
    (f) => f.severity === "blocker",
  );
  const title = opts.reviewerName
    ? `loupe · ${opts.reviewerName}`
    : "loupe review";
  const tag = makeMarker(opts.reviewerName, opts.headSha);
  const summaryTag = makeSummaryMarker(opts.reviewerName, opts.headSha);
  const shortSha = opts.headSha.slice(0, 7);
  const lastReviewed = `Last reviewed commit: [\`${shortSha}\`](https://github.com/${ref.owner}/${ref.repo}/commit/${opts.headSha})`;
  const degraded = opts.diagnostics ? isDegraded(opts.diagnostics) : false;
  const stats = statLine(inline, review, opts.fileCount, degraded);
  const summaryBody = renderReviewBody(
    title,
    stats,
    review,
    inline,
    dropped,
    opts.diagnostics,
    `${lastReviewed}\n\n${summaryTag}`,
  );

  if (inline.length > 0 || hasBlocker) {
    await octokit.pulls.createReview({
      ...ref,
      event: hasBlocker ? "REQUEST_CHANGES" : "COMMENT",
      // GitHub requires content when a review has no inline comments. Keep that
      // body visually empty while preserving PR-level blocker verdicts.
      body: inline.length > 0 ? "" : tag,
      comments: inline.map((f) => ({
        path: f.path,
        line: f.line,
        body: inlineFindingBody(f, tag),
      })),
    });
  }

  if (!opts.deferSummary) {
    const self = await getSelfLogin(octokit);
    const comments = await listIssueComments(octokit, ref);
    const priorSummary = comments
      .reverse()
      .find(
        (comment) =>
          comment.user?.login === self &&
          comment.body?.includes(summaryMarkerPrefix(opts.reviewerName)) &&
          !comment.body.includes(COMBINED_SUMMARY_MARKER) &&
          !comment.body.includes("<!-- loupe:summary:stale -->"),
      );
    if (priorSummary) {
      await octokit.issues.updateComment({
        owner: ref.owner,
        repo: ref.repo,
        comment_id: priorSummary.id,
        body: summaryBody,
      });
    } else {
      await octokit.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.pull_number,
        body: summaryBody,
      });
    }
  }

  await cleanupPriorComments(octokit, ref, prior, logger);
  return summaryBody;
}
