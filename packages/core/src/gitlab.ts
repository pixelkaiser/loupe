import type { Logger } from "@loupe/logger";

import type {
  Conventions,
  Forge,
  LastReviewed,
  PostReviewOptions,
} from "./forge";
import {
  COMBINED_SUMMARY_MARKER,
  inlineFindingBody,
  isDegraded,
  makeMarker,
  makeSummaryMarker,
  markerPrefix,
  preserveSkippedSummarySections,
  renderReviewBody,
  shaFromMarker,
  statLine,
  summaryMarkerPrefix,
  type PriorComments,
} from "./render";
import type { Finding, Note, ReviewOutput } from "./types";

/**
 * The GitLab forge: v4 REST with plain fetch, no SDK. The base URL comes from
 * the entry layer (instance origin for self-hosted, else gitlab.com), so core
 * never reads the environment. `project` is a numeric id or a full
 * `group/project` path (nested groups allowed).
 */
export type MergeRequestRef = {
  readonly project: string;
  readonly mrIid: number;
};

export type GitlabForgeOptions = {
  /** Instance origin, e.g. "https://gitlab.example.com" (no /api/v4 suffix). */
  readonly baseUrl: string;
  readonly token: string;
  readonly logger: Logger;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
};

type DiffRefs = { base_sha: string; start_sha: string; head_sha: string };
type MrResponse = {
  readonly title: string;
  readonly description: string | null;
  readonly sha: string;
  readonly diff_refs: DiffRefs | null;
};
type MrChange = { readonly new_path: string; readonly diff: string | null };
type MrNote = {
  readonly id: number;
  readonly body: string;
  readonly author?: { readonly username?: string } | null;
  readonly position?: { readonly new_path?: string } | null;
  /** Diff-note threads are resolvable; plain notes are not. */
  readonly resolvable?: boolean;
};
type MrDiscussion = {
  readonly id: string;
  readonly notes: readonly MrNote[];
};

/** Prior loupe output selected for cleanup, captured before posting. */
type PriorSnapshot = {
  readonly noteIds: readonly number[];
  readonly discussionIds: readonly string[];
};

const EMPTY_SNAPSHOT: PriorSnapshot = { noteIds: [], discussionIds: [] };

/**
 * The cleanup scope for prior-comment snapshotting: `undefined` = every marked
 * note of this reviewer, otherwise only those paths — plus, always, any path
 * that no longer exists at head (stranded threads).
 */
function scopeFor(
  refreshPaths: ReadonlySet<string> | undefined,
  headPaths: ReadonlySet<string> | undefined,
): ((path: string) => boolean) | undefined {
  if (!refreshPaths) return undefined;
  if (refreshPaths.size === 0) return () => false;
  if (!headPaths) return (path) => refreshPaths.has(path);
  return (path) => refreshPaths.has(path) || !headPaths.has(path);
}

class GitlabApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`GitLab API ${status}: ${body.slice(0, 300)}`);
    this.name = "GitlabApiError";
  }
}

export function makeGitlabForge(
  opts: GitlabForgeOptions,
): Forge<MergeRequestRef> {
  const { baseUrl, token, logger } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const root = baseUrl.replace(/\/+$/, "");

  async function api(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("PRIVATE-TOKEN", token);
    if (init?.body) headers.set("Content-Type", "application/json");
    const res = await doFetch(`${root}/api/v4${path}`, { ...init, headers });
    if (!res.ok) throw new GitlabApiError(res.status, await res.text());
    return res;
  }

  async function getJson<T>(path: string): Promise<T> {
    return (await api(path)).json() as Promise<T>;
  }

  /** GitLab tokens (PAT or project token) answer GET /user; cache it. Marker
   * text alone is not proof of authorship — a human quoting loupe output
   * carries the marker too — so "is this mine" checks pair the marker with
   * this username. If lookup fails, fall back to marker-only matching. */
  let selfUsername: Promise<string | undefined> | undefined;
  function getSelfUsername(): Promise<string | undefined> {
    selfUsername ??= getJson<{ username?: string }>("/user")
      .then((u) => u.username)
      .catch(() => undefined);
    return selfUsername;
  }

  const pid = (ref: MergeRequestRef): string =>
    encodeURIComponent(ref.project.trim().replace(/^\/+|\/+$/g, ""));

  async function getMr(ref: MergeRequestRef): Promise<MrResponse> {
    return getJson<MrResponse>(
      `/projects/${pid(ref)}/merge_requests/${ref.mrIid}`,
    );
  }

  async function listDiscussions(
    ref: MergeRequestRef,
  ): Promise<MrDiscussion[]> {
    const out: MrDiscussion[] = [];
    let page = 1;
    for (;;) {
      const res = await api(
        `/projects/${pid(ref)}/merge_requests/${ref.mrIid}/discussions` +
          `?order_by=created_at&sort=desc&page=${page}&per_page=100`,
      );
      out.push(...((await res.json()) as MrDiscussion[]));
      const next = Number(res.headers.get("x-next-page") ?? "");
      if (!Number.isInteger(next) || next <= page) break;
      page = next;
    }
    return out;
  }

  async function listNotes(ref: MergeRequestRef): Promise<MrNote[]> {
    const out: MrNote[] = [];
    let page = 1;
    for (;;) {
      const res = await api(
        `/projects/${pid(ref)}/merge_requests/${ref.mrIid}/notes` +
          `?order_by=created_at&sort=desc&page=${page}&per_page=100`,
      );
      out.push(...((await res.json()) as MrNote[]));
      const next = Number(res.headers.get("x-next-page") ?? "");
      if (!Number.isInteger(next) || next <= page) break;
      page = next;
    }
    return out;
  }

  return {
    name: "gitlab",
    describeRef: (ref) => `${ref.project}!${ref.mrIid}`,
    repoRef: (ref) => ref.project,

    fetchPullContext: async (ref) => {
      const mr = await getMr(ref);
      // The changes endpoint returns an array or { changes: [...] }; paginate
      // via x-next-page like any list endpoint (single pass when unpaginated).
      const rows: MrChange[] = [];
      let page = 1;
      for (;;) {
        const res = await api(
          `/projects/${pid(ref)}/merge_requests/${ref.mrIid}/changes` +
            `?page=${page}&per_page=100`,
        );
        const payload = (await res.json()) as
          | MrChange[]
          | { changes?: MrChange[] };
        rows.push(
          ...(Array.isArray(payload) ? payload : (payload.changes ?? [])),
        );
        const next = Number(res.headers.get("x-next-page") ?? "");
        if (!Number.isInteger(next) || next <= page) break;
        page = next;
      }
      return {
        title: mr.title,
        description: mr.description ?? "",
        files: rows.map((c) => ({
          path: c.new_path,
          patch: c.diff ?? undefined,
        })),
        headSha: mr.diff_refs?.head_sha ?? mr.sha,
        headPaths: new Set(rows.map((c) => c.new_path)),
      };
    },

    fetchConventions: async (ref, paths) => {
      const mr = await getMr(ref);
      const sha = mr.diff_refs?.head_sha ?? mr.sha;
      const parts: string[] = [];
      const found: string[] = [];
      for (const path of paths) {
        try {
          const res = await api(
            `/projects/${pid(ref)}/repository/files/${encodeURIComponent(path)}` +
              `/raw?ref=${encodeURIComponent(sha)}`,
          );
          parts.push(`# ${path}\n\n${await res.text()}`);
          found.push(path);
        } catch {
          // file not present at head — skip
        }
      }
      return { text: parts.join("\n\n---\n\n"), found } satisfies Conventions;
    },

    getLastReviewed: async (ref, reviewerName): Promise<LastReviewed> => {
      try {
        const self = await getSelfUsername();
        for (const note of await listNotes(ref)) {
          if (self && note.author?.username !== self) continue;
          const sha =
            shaFromMarker(note.body, summaryMarkerPrefix(reviewerName)) ??
            shaFromMarker(note.body, markerPrefix(reviewerName));
          if (sha) return { unknown: false, sha };
        }
      } catch (err) {
        return {
          unknown: true,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      return { unknown: false };
    },

    changedFilesBetween: async (ref, base, head) => {
      const data = await getJson<{ diffs?: { new_path: string }[] }>(
        `/projects/${pid(ref)}/repository/compare` +
          `?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`,
      );
      return new Set((data.diffs ?? []).map((d) => d.new_path));
    },

    cleanupStrandedThreads: async (ref, headPaths, options) => {
      const policy = options?.priorComments ?? "resolve";
      if (policy === "keep") return;
      const snapshot = await snapshotPriorNotes(
        ref,
        options?.reviewerName,
        policy,
        (path) => !headPaths.has(path),
      );
      await cleanupPriorNotes(ref, snapshot, policy);
    },

    postIssueComment: async (ref, body) => {
      await api(`/projects/${pid(ref)}/merge_requests/${ref.mrIid}/notes`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },

    upsertCombinedSummary: async (ref, body) => {
      await upsertCombinedNote(ref, body);
    },

    postReview: async (ref, review, inline, dropped, postOpts) => {
      // Snapshot first, post second, clean up last: a failed post must never
      // leave the MR with its old comments gone and no replacement. An empty
      // refresh set means "clean up nothing" (unknown history) — skip the
      // lookup entirely. Fail-open like GitHub: a failed lookup keeps priors.
      const policy = postOpts.priorComments ?? "resolve";
      const prior =
        policy === "keep" || postOpts.refreshPaths?.size === 0
          ? EMPTY_SNAPSHOT
          : await snapshotPriorNotes(
              ref,
              postOpts.reviewerName,
              policy,
              scopeFor(postOpts.refreshPaths, postOpts.headPaths),
            );
      const summaryBody = await postNotes(
        ref,
        review,
        inline,
        dropped,
        postOpts,
      );
      await cleanupPriorNotes(ref, prior, policy);
      return summaryBody;
    },
  };

  /**
   * Snapshot this reviewer's prior inline diff notes, in cleanup scope,
   * captured before the new review posts. Resolve policy records resolvable
   * discussion ids; delete policy records note ids. Only notes posted under
   * loupe's own user qualify; a human note quoting the marker is left alone.
   * Fail-open: a failed lookup keeps everything in place.
   */
  async function snapshotPriorNotes(
    ref: MergeRequestRef,
    reviewerName: string | undefined,
    policy: PriorComments,
    scope?: (path: string) => boolean,
  ): Promise<PriorSnapshot> {
    const prefix = markerPrefix(reviewerName);
    try {
      const self = await getSelfUsername();
      // Delete policy sweeps note ids from the notes list; resolve policy needs
      // discussion ids, which only the discussions endpoint carries.
      if (policy === "delete") {
        const mine = (await listNotes(ref)).filter(
          (n) =>
            (!self || n.author?.username === self) &&
            n.body.includes(prefix) &&
            (n.position == null ||
              !scope ||
              (n.position.new_path && scope(n.position.new_path))),
        );
        return { noteIds: mine.map((n) => n.id), discussionIds: [] };
      }
      const discussionIds = new Set<string>();
      for (const d of await listDiscussions(ref)) {
        for (const n of d.notes) {
          if (self && n.author?.username !== self) continue;
          if (!n.body.includes(prefix)) continue;
          if (scope && n.position?.new_path && !scope(n.position.new_path)) {
            continue;
          }
          // Diff notes live in resolvable discussions (sweep by resolving);
          // anything else cannot be resolved and is left to a delete sweep.
          if (n.position != null && n.resolvable !== false) {
            discussionIds.add(d.id);
          }
        }
      }
      return { noteIds: [], discussionIds: [...discussionIds] };
    } catch (err) {
      logger.warn(
        "Could not look up prior loupe notes; leaving them in place",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return EMPTY_SNAPSHOT;
    }
  }

  /**
   * Apply the cleanup policy to a snapshot taken before posting. Each
   * resolution or deletion fails independently; a failure never blocks the
   * others and never touches anything outside the snapshot.
   */
  async function cleanupPriorNotes(
    ref: MergeRequestRef,
    snapshot: PriorSnapshot,
    policy: PriorComments,
  ): Promise<void> {
    if (policy === "resolve") {
      for (const id of snapshot.discussionIds) {
        try {
          await api(
            `/projects/${pid(ref)}/merge_requests/${ref.mrIid}/discussions/${id}`,
            { method: "PUT", body: JSON.stringify({ resolved: true }) },
          );
        } catch (err) {
          logger.warn("Could not resolve a prior loupe discussion", {
            discussion: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else {
      for (const id of snapshot.noteIds) {
        try {
          await api(
            `/projects/${pid(ref)}/merge_requests/${ref.mrIid}/notes/${id}`,
            { method: "DELETE" },
          );
        } catch (err) {
          logger.warn("Could not delete a prior loupe note", {
            note: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    const n = snapshot.noteIds.length + snapshot.discussionIds.length;
    if (n > 0) logger.debug("Cleaned up prior loupe notes", { count: n });
  }

  /**
   * Post the review: one positioned discussion per inline finding, then one
   * summary note. GitLab has no createReview analog and no REQUEST_CHANGES
   * event, so the verdict is stated in the note body and loupe never approves.
   * A finding whose position GitLab rejects (line moved between diff versions)
   * is demoted into the summary's "Other notes" section — a bad anchor
   * degrades, it never fails the whole review.
   */
  async function postNotes(
    ref: MergeRequestRef,
    review: ReviewOutput,
    inline: readonly Finding[],
    dropped: readonly Note[],
    opts: PostReviewOptions,
  ): Promise<string> {
    const mr = await getMr(ref);
    const refs = mr.diff_refs;
    const tag = makeMarker(opts.reviewerName, opts.headSha);
    const posted: Finding[] = [];
    const demoted: Finding[] = [];

    if (refs) {
      for (const f of inline) {
        const body = inlineFindingBody(f, tag);
        const position = {
          base_sha: refs.base_sha,
          start_sha: refs.start_sha,
          head_sha: refs.head_sha,
          position_type: "text",
          new_path: f.path,
          old_path: f.path,
          new_line: f.line,
        };
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try {
            await api(
              `/projects/${pid(ref)}/merge_requests/${ref.mrIid}/discussions`,
              { method: "POST", body: JSON.stringify({ body, position }) },
            );
            ok = true;
          } catch {
            // retry once, then demote below
          }
        }
        if (ok) posted.push(f);
        else {
          demoted.push(f);
          logger.warn(
            "GitLab rejected an inline position; demoted to summary",
            {
              path: f.path,
              line: f.line,
            },
          );
        }
      }
    } else {
      // No diff_refs available — everything goes in the summary body.
      demoted.push(...inline);
    }

    const hasBlocker = [...inline, ...review.concerns].some(
      (f) => f.severity === "blocker",
    );
    const title = opts.reviewerName
      ? `loupe · ${opts.reviewerName}`
      : "loupe review";
    const summaryTag = makeSummaryMarker(opts.reviewerName, opts.headSha);
    const lastReviewed = `Last reviewed commit: [\`${opts.headSha.slice(0, 7)}\`](${root}/${ref.project}/-/commit/${opts.headSha})`;
    const degraded = opts.diagnostics ? isDegraded(opts.diagnostics) : false;
    const stats = statLine(inline, review, opts.fileCount, degraded);
    const verdict = hasBlocker ? "⚠️ request changes" : "💬 comment";
    const body = `**Verdict:** ${verdict}\n\n${renderReviewBody(
      title,
      stats,
      review,
      posted,
      [...dropped, ...demoted],
      opts.diagnostics,
      `${lastReviewed}\n\n${summaryTag}`,
    )}`;

    // Deferred: the orchestrator publishes one combined summary for every
    // reviewer; this run only posts the inline notes and hands the body back.
    if (opts.deferSummary) return body;

    // Create or update this reviewer's persistent summary note (updated in
    // place so the MR thread list doesn't grow on every re-review).
    const self = await getSelfUsername();
    const prior = (await listNotes(ref)).find(
      (n) =>
        (!self || n.author?.username === self) &&
        n.body.includes(summaryMarkerPrefix(opts.reviewerName)) &&
        !n.body.includes(COMBINED_SUMMARY_MARKER) &&
        !n.body.includes("<!-- loupe:summary:stale -->"),
    );
    if (prior) {
      await api(
        `/projects/${pid(ref)}/merge_requests/${ref.mrIid}/notes/${prior.id}`,
        { method: "PUT", body: JSON.stringify({ body }) },
      );
    } else {
      await api(`/projects/${pid(ref)}/merge_requests/${ref.mrIid}/notes`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    }
    return body;
  }

  /**
   * Create or update the single summary note that aggregates all reviewers,
   * superseding the per-reviewer persistent summaries. Skipped reviewers keep
   * their last real section; reviewers not running at all keep their SHA
   * markers (incremental state) appended to the note. Legacy per-reviewer
   * summary notes are tagged stale once the combined note is live.
   */
  async function upsertCombinedNote(
    ref: MergeRequestRef,
    body: string,
  ): Promise<void> {
    const self = await getSelfUsername();
    const mine = (await listNotes(ref)).filter(
      (n) => !self || n.author?.username === self,
    );
    const prior = mine.find((n) => n.body.includes(COMBINED_SUMMARY_MARKER));
    const mergedBody = preserveSkippedSummarySections(body, prior?.body);
    const currentReviewers = new Set(
      [
        ...mergedBody.matchAll(
          /<!-- loupe:summary:([^\s]+) sha=[0-9a-f]{7,40} -->/g,
        ),
      ].map((match) => match[1]),
    );
    const retainedMarkers = mine
      .flatMap((n) => [
        ...(n.body.matchAll(
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
      await api(
        `/projects/${pid(ref)}/merge_requests/${ref.mrIid}/notes/${prior.id}`,
        { method: "PUT", body: JSON.stringify({ body: markedBody }) },
      );
    } else {
      await api(`/projects/${pid(ref)}/merge_requests/${ref.mrIid}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: markedBody }),
      });
    }

    // Preserve legacy per-reviewer notes for history, but tag them stale only
    // after the replacement exists. Best-effort, never fails the review.
    for (const n of mine) {
      if (
        n.id !== prior?.id &&
        n.body.includes("<!-- loupe:summary:") &&
        !n.body.includes(COMBINED_SUMMARY_MARKER) &&
        !n.body.includes("<!-- loupe:summary:stale -->")
      ) {
        try {
          await api(
            `/projects/${pid(ref)}/merge_requests/${ref.mrIid}/notes/${n.id}`,
            {
              method: "PUT",
              body: JSON.stringify({
                body: `${n.body.trim()}\n\n> ℹ️ This legacy reviewer summary is stale. Loupe now publishes a single combined summary.\n\n<!-- loupe:summary:stale -->`,
              }),
            },
          );
        } catch {
          // The combined summary is already live; a legacy-tagging failure
          // must not turn a completed review into a failed one.
        }
      }
    }
  }
}
