import { Octokit } from "@octokit/rest";

import type { Logger } from "@loupe/logger";

import type {
  Conventions,
  Forge,
  PostReviewOptions,
  PullContext,
} from "./forge";
import {
  makeMarker,
  makeSummaryMarker,
  markerPrefix,
  renderReviewBody,
  SEV_EMOJI,
  shaFromMarker,
  statLine,
  summaryMarkerPrefix,
} from "./render";
import type { Finding, ReviewOutput } from "./types";

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
  const octokit = makeOctokit(token, logger);
  return {
    name: "github",
    describeRef: (ref) => `${ref.owner}/${ref.repo}#${ref.pull_number}`,
    repoRef: (ref) => `${ref.owner}/${ref.repo}`,
    fetchPullContext: (ref) => fetchPullContext(octokit, ref),
    fetchConventions: (ref, paths) => fetchConventions(octokit, ref, paths),
    getLastReviewedSha: (ref, reviewerName) =>
      getLastReviewedSha(octokit, ref, reviewerName),
    changedFilesBetween: (ref, base, head) =>
      changedFilesBetween(octokit, ref, base, head),
    postIssueComment: (ref, body) => postIssueComment(octokit, ref, body),
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
 * The head SHA this reviewer last reviewed, read from its persistent summary
 * comment. Legacy review-body markers remain a fallback for existing PRs.
 */
export async function getLastReviewedSha(
  octokit: Octokit,
  ref: PullRef,
  reviewerName: string | undefined,
): Promise<string | undefined> {
  try {
    const self = await getSelfLogin(octokit);
    const comments = await listIssueComments(octokit, ref);
    for (const comment of comments.reverse()) {
      if (comment.user?.login !== self) continue;
      const sha = shaFromMarker(
        comment.body,
        summaryMarkerPrefix(reviewerName),
      );
      if (sha) return sha;
    }

    const reviews = await octokit.paginate(octokit.pulls.listReviews, {
      ...ref,
      per_page: 100,
    });
    for (const review of reviews.reverse()) {
      if (review.user?.login !== self) continue;
      const sha = shaFromMarker(review.body, markerPrefix(reviewerName));
      if (sha) return sha;
    }
  } catch {
    // Treat lookup failures as no prior review; posting can still proceed.
  }
  return undefined;
}

/** Post a top-level PR comment (used for chat replies). */
export async function postIssueComment(
  octokit: Octokit,
  ref: PullRef,
  body: string,
): Promise<void> {
  await octokit.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pull_number,
    body,
  });
}

/** Files changed between two commits (the incremental-review delta). */
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
  return new Set((data.files ?? []).map((f) => f.filename));
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

/**
 * Delete this reviewer's inline comments from a previous run so re-reviews
 * replace rather than duplicate. Only comments posted under loupe's own login
 * qualify; a human comment that quotes the marker is left alone. When
 * `refreshPaths` is given (incremental review), only comments on those files
 * are removed — comments on files unchanged since the last review are kept.
 * Best-effort: never blocks posting.
 */
async function deletePriorComments(
  octokit: Octokit,
  ref: PullRef,
  reviewerName: string | undefined,
  logger: Logger,
  refreshPaths?: ReadonlySet<string>,
): Promise<void> {
  const prefix = markerPrefix(reviewerName);
  try {
    const self = await getSelfLogin(octokit);
    const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      per_page: 100,
    });
    const mine = comments.filter(
      (c) =>
        c.user?.login === self &&
        c.body.includes(prefix) &&
        (!refreshPaths || refreshPaths.has(c.path)),
    );
    for (const c of mine) {
      await octokit.pulls.deleteReviewComment({
        owner: ref.owner,
        repo: ref.repo,
        comment_id: c.id,
      });
    }
    if (mine.length > 0) {
      logger.debug("Removed prior loupe comments", { count: mine.length });
    }
  } catch (err) {
    logger.warn("Could not clean up prior loupe comments", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Post inline findings as an empty-body review and create or update this
 * reviewer's persistent issue-comment summary. Uses REQUEST_CHANGES when any
 * finding is a blocker, otherwise COMMENT — never APPROVE (a bot shouldn't be a
 * required approver). Prior inline comments are cleared before replacements are
 * posted; off-diff findings remain in the summary.
 */
export async function postReview(
  octokit: Octokit,
  ref: PullRef,
  review: ReviewOutput,
  inline: readonly Finding[],
  dropped: readonly Finding[],
  logger: Logger,
  opts: PostReviewOptions,
): Promise<void> {
  await deletePriorComments(
    octokit,
    ref,
    opts.reviewerName,
    logger,
    opts.refreshPaths,
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
  const stats = statLine(inline, review, opts.fileCount);
  const summaryBody = renderReviewBody(
    title,
    stats,
    review,
    inline,
    dropped,
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
        body: `${SEV_EMOJI[f.severity]} **${f.severity}** ${f.body}\n\n${tag}`,
      })),
    });
  }

  const self = await getSelfLogin(octokit);
  const comments = await listIssueComments(octokit, ref);
  const prior = comments
    .reverse()
    .find(
      (comment) =>
        comment.user?.login === self &&
        comment.body?.includes(summaryMarkerPrefix(opts.reviewerName)),
    );
  if (prior) {
    await octokit.issues.updateComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: prior.id,
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
