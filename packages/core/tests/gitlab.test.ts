import type { Logger } from "@loupe/logger";
import { describe, expect, it } from "vitest";

import { makeGitlabForge } from "../src/gitlab";
import type { ReviewOutput } from "../src/types";

/** Silent logger stub (child() must return another valid Logger). */
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

type Route = {
  method?: string;
  /** Substring of the request URL (already percent-encoded paths). */
  path: string;
  /** Extra URL predicate, e.g. to distinguish pagination pages. */
  when?: (url: string) => boolean;
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
};

/**
 * A tiny routed fake fetch: records every call, replies from `routes` (first
 * substring+predicate match wins), 404s otherwise. Replies carry headers so
 * tests can drive `x-next-page` pagination.
 */
function server(routes: readonly Route[]): {
  fetchImpl: typeof fetch;
  calls: { method: string; url: string; body?: unknown }[];
} {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const u =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: u, body });
    for (const r of routes) {
      if ((r.method ?? "GET").toUpperCase() !== method) continue;
      if (!u.includes(r.path)) continue;
      if (r.when && !r.when(u)) continue;
      const headers = new Headers(r.headers ?? {});
      if (r.json !== undefined) {
        return new Response(JSON.stringify(r.json), {
          status: r.status ?? 200,
          headers,
        });
      }
      return new Response(r.text ?? "", { status: r.status ?? 200, headers });
    }
    return new Response("no route", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const forge = (routes: readonly Route[]) => {
  const s = server(routes);
  return {
    ...s,
    api: makeGitlabForge({
      baseUrl: "https://gitlab.example.com",
      token: "tok",
      logger,
      fetchImpl: s.fetchImpl,
    }),
  };
};

const REF = { project: "group/proj", mrIid: 42 } as const;
const MR = {
  title: "Add flux capacitor",
  description: "It makes time travel possible",
  sha: "headsha0000000000000000000000000000",
  diff_refs: {
    base_sha: "base111",
    start_sha: "start111",
    head_sha: "head1111",
  },
};

const mrRoute: Route = {
  path: `/projects/group%2Fproj/merge_requests/42`,
  when: (u) => u.endsWith("/merge_requests/42"),
  json: MR,
};
/** GET /user — the identity "is this note mine" checks pair with the marker. */
const userRoute: Route = {
  path: "/user",
  json: { username: "loupe-bot" },
};
const BOT = "loupe-bot";

// The notes list (marker scan and cleanup) also hits /merge_requests/42 —
// disambiguate from the MR itself by requiring the /notes suffix.
const notesListRoute = (notes: unknown[]): Route => ({
  path: "/merge_requests/42/notes",
  when: (u) => !u.includes("/notes/"),
  json: notes,
});

describe("gitlab forge · fetchPullContext", () => {
  it("maps the MR and its changes onto PullContext", async () => {
    const { api } = forge([
      mrRoute,
      {
        path: "/merge_requests/42/changes",
        json: {
          changes: [{ new_path: "src/a.ts", diff: "@@ -1 +1 @@\n+x" }],
        },
      },
    ]);
    const pull = await api.fetchPullContext(REF);
    expect(pull.title).toBe("Add flux capacitor");
    expect(pull.description).toBe("It makes time travel possible");
    expect(pull.files).toEqual([
      { path: "src/a.ts", patch: "@@ -1 +1 @@\n+x" },
    ]);
    expect(pull.headSha).toBe("head1111"); // diff_refs.head_sha, not mr.sha
  });

  it("follows x-next-page pagination on the changes endpoint", async () => {
    const { api } = forge([
      mrRoute,
      {
        path: "/merge_requests/42/changes",
        when: (u) => !u.includes("page=2"),
        json: { changes: [{ new_path: "a.ts", diff: "@@ -1 +1 @@\n+a" }] },
        headers: { "x-next-page": "2" },
      },
      {
        path: "/merge_requests/42/changes",
        when: (u) => u.includes("page=2"),
        // array form some GitLab versions return
        json: [{ new_path: "b.ts", diff: "@@ -1 +1 @@\n+b" }],
      },
    ]);
    const pull = await api.fetchPullContext(REF);
    expect(pull.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("gitlab forge · incremental support", () => {
  it("reads the last reviewed sha from own summary note, else legacy marker", async () => {
    const { api } = forge([
      userRoute,
      notesListRoute([
        { id: 1, body: "unrelated discussion", author: { username: "te" } },
        {
          id: 2,
          author: { username: BOT },
          body: "review body\n<!-- loupe:summary:bugs sha=abc123def456 -->",
        },
        {
          id: 3,
          author: { username: BOT },
          body: "legacy\n<!-- loupe:bugs sha=fff000fff111 -->",
        },
      ]),
    ]);
    expect(await api.getLastReviewedSha(REF, "bugs")).toBe("abc123def456");
  });

  it("falls back to the legacy inline marker when no summary note exists", async () => {
    const { api } = forge([
      userRoute,
      notesListRoute([
        {
          id: 3,
          author: { username: BOT },
          body: "legacy\n<!-- loupe:bugs sha=fff000fff111 -->",
        },
      ]),
    ]);
    expect(await api.getLastReviewedSha(REF, "bugs")).toBe("fff000fff111");
  });

  it("ignores a human note quoting the marker (author guard)", async () => {
    const { api } = forge([
      userRoute,
      notesListRoute([
        {
          id: 1,
          author: { username: "te" }, // not loupe
          body: "quoting loupe:\n<!-- loupe:summary:bugs sha=abc123def456 -->",
        },
      ]),
    ]);
    expect(await api.getLastReviewedSha(REF, "bugs")).toBeUndefined();
  });

  it("returns undefined when this reviewer never posted", async () => {
    const { api } = forge([
      userRoute,
      notesListRoute([
        {
          id: 1,
          author: { username: BOT },
          body: "<!-- loupe:other sha=abc123def456 -->",
        },
      ]),
    ]);
    expect(await api.getLastReviewedSha(REF, "bugs")).toBeUndefined();
  });

  it("lists changed paths from the compare endpoint", async () => {
    const { api } = forge([
      {
        path: "/repository/compare?from=abc&to=def",
        json: { diffs: [{ new_path: "a.ts" }, { new_path: "b.ts" }] },
      },
    ]);
    expect(await api.changedFilesBetween(REF, "abc", "def")).toEqual(
      new Set(["a.ts", "b.ts"]),
    );
  });
});

describe("gitlab forge · fetchConventions", () => {
  it("fetches raw files at head and skips missing ones", async () => {
    const { api } = forge([
      mrRoute,
      {
        path: "/repository/files/AGENTS.md/raw?ref=head1111",
        text: "# Rules\nbe kind",
      },
      // CONVENTING.md has no route → 404 → skipped
    ]);
    const conventions = await api.fetchConventions(REF, [
      "AGENTS.md",
      "CONTRIBUTING.md",
    ]);
    expect(conventions.found).toEqual(["AGENTS.md"]);
    expect(conventions.text).toContain("# Rules\nbe kind");
  });
});

describe("gitlab forge · postReview", () => {
  const review: ReviewOutput = {
    summary: "Mostly fine.",
    findings: [],
    concerns: [
      {
        title: "No rollback",
        detail: "migration is one-way",
        severity: "blocker",
      },
    ],
    highlights: [],
  };

  it("cleans up own prior notes (author-guarded), posts inline + new summary", async () => {
    const { api, calls } = forge([
      userRoute,
      notesListRoute([
        {
          id: 55,
          author: { username: BOT },
          body: "old summary\n<!-- loupe:bugs sha=old -->",
        },
        {
          id: 66,
          author: { username: BOT },
          body: "old inline\n<!-- loupe:bugs sha=old -->",
          position: { new_path: "src/a.ts" },
        },
        {
          id: 77,
          author: { username: BOT },
          body: "kept — file untouched\n<!-- loupe:bugs sha=old -->",
          position: { new_path: "src/other.ts" },
        },
        {
          // human quoting loupe output on a refreshed file — author guard
          // must keep it even though the marker matches
          id: 88,
          author: { username: "te" },
          body: "quoting loupe\n<!-- loupe:bugs sha=old -->",
          position: { new_path: "src/a.ts" },
        },
      ]),
      { method: "DELETE", path: "/merge_requests/42/notes/55", json: {} },
      { method: "DELETE", path: "/merge_requests/42/notes/66", json: {} },
      mrRoute,
      { method: "POST", path: "/merge_requests/42/discussions", json: {} },
      {
        method: "POST",
        path: "/merge_requests/42/notes",
        when: (u) => !u.includes("/notes/"),
        json: {},
      },
    ]);

    await api.postReview(
      REF,
      review,
      [
        {
          path: "src/a.ts",
          line: 3,
          severity: "warning",
          body: "off-by-one",
        },
      ],
      [],
      {
        reviewerName: "bugs",
        headSha: "head1111",
        refreshPaths: new Set(["src/a.ts"]), // incremental: keep src/other.ts
        fileCount: 2,
      },
    );

    // cleanup kept the untouched file's note and the human's quote, dropped
    // the rest of ours
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes.map((c) => c.url)).toEqual([
      expect.stringContaining("/notes/55"),
      expect.stringContaining("/notes/66"),
    ]);

    // inline finding → one positioned discussion
    const discussion = calls.find((c) => c.url.includes("/discussions"));
    expect((discussion?.body as Record<string, unknown>)?.body).toEqual(
      expect.stringContaining("off-by-one"),
    );
    expect((discussion?.body as Record<string, unknown>)?.position).toEqual({
      base_sha: "base111",
      start_sha: "start111",
      head_sha: "head1111",
      position_type: "text",
      new_path: "src/a.ts",
      old_path: "src/a.ts",
      new_line: 3,
    });

    // no prior summary note → a new persistent summary is created, carrying
    // verdict, last-reviewed link, and the summary marker
    const note = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/notes"),
    );
    const body = String(
      (note?.body as { body?: string } | undefined)?.body ?? "",
    );
    expect(body).toContain("**Verdict:** ⚠️ request changes");
    expect(body).toContain("<!-- loupe:summary:bugs sha=head1111 -->");
    expect(body).toContain(
      "Last reviewed commit: [`head111`](https://gitlab.example.com/group/proj/-/commit/head1111)",
    );
    expect(body).toContain("No rollback");
  });

  it("updates the persistent summary in place when one exists", async () => {
    const { api, calls } = forge([
      userRoute,
      notesListRoute([
        {
          id: 90,
          author: { username: BOT },
          body: "prior summary\n<!-- loupe:summary:bugs sha=old -->",
        },
      ]),
      mrRoute,
      { method: "PUT", path: "/merge_requests/42/notes/90", json: {} },
    ]);

    await api.postReview(
      REF,
      { summary: "s", findings: [], concerns: [], highlights: [] },
      [],
      [],
      { reviewerName: "bugs", headSha: "head1111", fileCount: 1 },
    );

    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/notes/90");
    expect(
      String((put?.body as { body?: string } | undefined)?.body ?? ""),
    ).toContain("<!-- loupe:summary:bugs sha=head1111 -->");
    // and no new summary note was created
    expect(
      calls.some((c) => c.method === "POST" && c.url.endsWith("/notes")),
    ).toBe(false);
  });

  it("demotes a finding whose position GitLab rejects instead of failing", async () => {
    const { api, calls } = forge([
      userRoute,
      notesListRoute([]),
      mrRoute,
      {
        method: "POST",
        path: "/merge_requests/42/discussions",
        status: 400,
        json: { message: "position is invalid" },
      },
      {
        method: "POST",
        path: "/merge_requests/42/notes",
        when: (u) => !u.includes("/notes/"),
        json: {},
      },
    ]);

    await expect(
      api.postReview(
        REF,
        { summary: "s", findings: [], concerns: [], highlights: [] },
        [{ path: "src/a.ts", line: 3, severity: "nit", body: "stale anchor" }],
        [],
        { reviewerName: "bugs", headSha: "head1111", fileCount: 1 },
      ),
    ).resolves.toBeUndefined();

    // one retry, then give up on the position
    const discussions = calls.filter((c) => c.url.includes("/discussions"));
    expect(discussions).toHaveLength(2);

    const note = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/notes"),
    );
    const body = String(
      (note?.body as { body?: string } | undefined)?.body ?? "",
    );
    expect(body).toContain("Other notes (1)");
    expect(body).toContain("src/a.ts:3");
  });
});

describe("gitlab forge · misc", () => {
  it("sends the token as PRIVATE-TOKEN against the given base URL", async () => {
    const seen: { url: string; token: string | null }[] = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const u =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const req = new Request(u, init);
      seen.push({
        url: req.url,
        token: req.headers.get("PRIVATE-TOKEN"),
      });
      return new Response(JSON.stringify({ diffs: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const api = makeGitlabForge({
      baseUrl: "https://gitlab.example.com/",
      token: "tok",
      logger,
      fetchImpl,
    });
    await api.changedFilesBetween(REF, "a", "b");
    expect(seen[0]).toEqual({
      url: "https://gitlab.example.com/api/v4/projects/group%2Fproj/repository/compare?from=a&to=b",
      token: "tok",
    });
  });

  it("describes refs in GitLab shorthand", () => {
    const { api } = forge([]);
    expect(api.describeRef(REF)).toBe("group/proj!42");
  });
});
