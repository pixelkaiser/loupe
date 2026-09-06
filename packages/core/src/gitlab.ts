import type { Logger } from "@loupe/logger";

import type { Conventions, Forge, PostReviewOptions } from "./forge";
import {
  makeMarker,
  markerPrefix,
  renderReviewBody,
  SEV_EMOJI,
  shaFromMarker,
  statLine,
} from "./render";
import type { Finding, ReviewOutput } from "./types";

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
  readonly position?: { readonly new_path?: string } | null;
};

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

  const pid = (ref: MergeRequestRef): string =>
    encodeURIComponent(ref.project.trim().replace(/^\/+|\/+$/g, ""));

  async function getMr(ref: MergeRequestRef): Promise<MrResponse> {
    return getJson<MrResponse>(
      `/projects/${pid(ref)}/merge_requests/${ref.mrIid}`,
    );
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

    getLastReviewedSha: async (ref, reviewerName) => {
      const prefix = markerPrefix(reviewerName);
      try {
        for (const note of await listNotes(ref)) {
          if (note.body.includes(prefix)) {
            const sha = shaFromMarker(note.body);
            if (sha) return sha;
          }
        }
      } catch {
        // treat as no prior review
      }
      return undefined;
    },

    changedFilesBetween: async (ref, base, head) => {
      const data = await getJson<{ diffs?: { new_path: string }[] }>(
        `/projects/${pid(ref)}/repository/compare` +
          `?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`,
      );
      return new Set((data.diffs ?? []).map((d) => d.new_path));
    },

    postIssueComment: async (ref, body) => {
      await api(`/projects/${pid(ref)}/merge_requests/${ref.mrIid}/notes`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },

    postReview: async (ref, review, inline, dropped, postOpts) => {
      await deletePriorNotes(ref, postOpts);
      await postNotes(ref, review, inline, dropped, postOpts);
    },
  };

  /**
   * Delete this forge's notes from a previous run — summary notes always
   * (GitLab notes accumulate; there is no review object to supersede them),
   * inline diff notes only on `refreshPaths` files when set, so incremental
   * runs keep comments on untouched files. Best-effort: never blocks posting.
   */
  async function deletePriorNotes(
    ref: MergeRequestRef,
    opts: PostReviewOptions,
  ): Promise<void> {
    const prefix = markerPrefix(opts.reviewerName);
    try {
      const mine = (await listNotes(ref)).filter(
        (n) =>
          n.body.includes(prefix) &&
          (n.position == null ||
            !opts.refreshPaths ||
            opts.refreshPaths.has(n.position.new_path ?? "")),
      );
      for (const n of mine) {
        await api(
          `/projects/${pid(ref)}/merge_requests/${ref.mrIid}/notes/${n.id}`,
          { method: "DELETE" },
        );
      }
      if (mine.length > 0) {
        logger.debug("Removed prior loupe notes", { count: mine.length });
      }
    } catch (err) {
      logger.warn("Could not clean up prior loupe notes", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
    dropped: readonly Finding[],
    opts: PostReviewOptions,
  ): Promise<void> {
    const mr = await getMr(ref);
    const refs = mr.diff_refs;
    const tag = makeMarker(opts.reviewerName, opts.headSha);
    const posted: Finding[] = [];
    const demoted: Finding[] = [];

    if (refs) {
      for (const f of inline) {
        const body = `${SEV_EMOJI[f.severity]} **${f.severity}** ${f.body}\n\n${tag}`;
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
    const stats = statLine(inline, review, opts.fileCount);
    const verdict = hasBlocker ? "⚠️ request changes" : "💬 comment";
    const body = `**Verdict:** ${verdict}\n\n${renderReviewBody(
      title,
      stats,
      review,
      posted,
      [...dropped, ...demoted],
      tag,
    )}`;
    await api(`/projects/${pid(ref)}/merge_requests/${ref.mrIid}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }
}
