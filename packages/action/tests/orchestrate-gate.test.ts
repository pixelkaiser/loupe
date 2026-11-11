import { describe, expect, it, vi } from "vitest";

import type { ReviewResult } from "@loupe/core";
import type { Logger } from "@loupe/logger";

// vi.mock factories are hoisted above all top-level code, so any values they
// close over must be created with vi.hoisted (which runs at hoist time). These
// are the levers the tests flip, plus the spy for the write we gate.
const { upsertCombinedSummary, postIssueComment, pullsGet, state } = vi.hoisted(
  () => ({
    upsertCombinedSummary: vi.fn(async () => undefined),
    postIssueComment: vi.fn(async () => undefined),
    pullsGet: vi.fn(async () => ({
      data: { merged: false, state: "open", head: { sha: "h".repeat(40) } },
    })),
    // Mutable PR state the tests set before each call; the mock reads it live.
    state: {
      open: true,
      reason: "merged" as "merged" | "closed",
      throws: false,
    },
  }),
);

// pullsGet returns whatever `state` says right now, so each test drives the gate
// by mutating state before calling runReviews.
pullsGet.mockImplementation(async () => {
  if (state.throws) throw new Error("boom");
  return {
    data: {
      merged: !state.open && state.reason === "merged",
      state: state.open ? "open" : "closed",
      head: { sha: "h".repeat(40) },
    },
  };
});

vi.mock("@loupe/core", () => ({
  makeGitlabForge: () => ({
    postIssueComment,
    upsertCombinedSummary,
    checkOpen: async () => {
      const { data: pr } = await pullsGet();
      return pr.merged ? { open: false, reason: "merged" } : { open: true };
    },
    checkPublishable: async () => {
      const { data: pr } = await pullsGet();
      return pr.merged
        ? { publishable: false, reason: "merged" }
        : { publishable: true };
    },
  }),
  makeGithubForge: () => ({
    postIssueComment,
    upsertCombinedSummary,
    checkOpen: async () => {
      const { data: pr } = await pullsGet();
      return pr.merged
        ? { open: false, reason: "merged" }
        : pr.state === "closed"
          ? { open: false, reason: "closed" }
          : { open: true };
    },
    checkPublishable: async () => {
      const { data: pr } = await pullsGet();
      return pr.merged
        ? { publishable: false, reason: "merged" }
        : pr.state === "closed"
          ? { publishable: false, reason: "closed" }
          : { publishable: true };
    },
  }),
  makeOctokit: () => ({ pulls: { get: pullsGet } }),
  // Mirror checkPrOpen's real merged-then-closed ordering via the shared pullsGet.
  checkPrOpen: async () => {
    const pr = await pullsGet();
    if (pr.data.merged) return { open: false, reason: "merged" as const };
    if (pr.data.state === "closed")
      return { open: false, reason: "closed" as const };
    return { open: true };
  },
  // Mirror checkPublishable: same pullsGet, same merged/closed/head-moved order.
  checkPublishable: async () => {
    const pr = await pullsGet();
    if (pr.data.merged)
      return { publishable: false, reason: "merged" as const };
    if (pr.data.state === "closed")
      return { publishable: false, reason: "closed" as const };
    if (pr.data.head.sha !== "h".repeat(40))
      return { publishable: false, reason: "head-moved" as const };
    return { publishable: true };
  },
  dedupeFindings: vi.fn(
    (perReviewer: readonly { reviewer: string; findings: unknown[] }[]) =>
      perReviewer.map((r) => ({
        reviewer: r.reviewer,
        inline: r.findings,
        suppressed: 0,
      })),
  ),
  upsertCombinedSummary,
  postIssueComment,
}));

const diagnostics = {
  mode: "agentic" as const,
  verify: "skipped" as const,
  incremental: "full" as const,
  malformedDropped: { findings: 0, concerns: 0 },
  outOfScopeDropped: 0,
  profileDropped: 0,
  verifyDropped: 0,
  offDiff: 0,
  salvagedFindings: 0,
  crossReviewerDropped: 0,
  cappedDropped: 0,
  degradedLegs: [] as string[],
};
const produced = {
  reviewerName: "default",
  review: {
    summary: "Looks fine.",
    findings: [],
    concerns: [],
    highlights: [],
  },
  inline: [],
  uncertain: [],
  overflow: [],
  dropped: [],
  diagnostics,
  headSha: "h".repeat(40),
  refreshPaths: new Set<string>(),
  headPaths: new Set<string>(),
  fileCount: 0,
};
const result: ReviewResult = {
  inlineCount: 0,
  droppedCount: 0,
  requestedChanges: false,
  summary: "Looks fine.",
  inline: [],
  overflow: [],
  dropped: [],
  diagnostics,
};
vi.mock("../src/run", async (importOriginal) => ({
  ...(await importOriginal<typeof RunModule>()),
  produceReviewPullRequest: vi.fn(async () => produced),
  publishReviewPullRequest: vi.fn(async () => "summary body"),
  resultFromProduced: () => result,
  formatResult: () => "loupe: 0 inline comment(s)",
}));

import { runReviews } from "../src/orchestrate";
import type * as RunModule from "../src/run";

import type { Config } from "../src/config";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    token: "t",
    target: {
      kind: "github",
      ref: { owner: "acme", repo: "app", pull_number: 7 },
    },
    harnessName: "fake",
    workdir: ".",
    conventionPaths: ["AGENTS.md"],
    providers: [],
    model: "m",
    profile: "chill",
    verify: false,
    full: false,
    ensembleModels: [],
    skills: [],
    timezone: "UTC",
    ...overrides,
  } as Config;
}

describe("runReviews combined-summary freshness gate", () => {
  it("writes the combined summary when the PR is still open", async () => {
    state.open = true;
    state.throws = false;
    upsertCombinedSummary.mockClear();
    await runReviews(baseConfig(), logger);
    expect(upsertCombinedSummary).toHaveBeenCalledTimes(1);
  });

  it("skips the combined summary when the PR merged mid-run", async () => {
    state.open = false;
    state.reason = "merged";
    state.throws = false;
    upsertCombinedSummary.mockClear();
    const outcomes = await runReviews(baseConfig(), logger);
    expect(upsertCombinedSummary).not.toHaveBeenCalled();
    // The reviewer outcome still surfaces (ok: true) — only the summary post was skipped.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(true);
  });

  it("skips the combined summary when the PR was closed mid-run", async () => {
    state.open = false;
    state.reason = "closed";
    state.throws = false;
    upsertCombinedSummary.mockClear();
    await runReviews(baseConfig(), logger);
    expect(upsertCombinedSummary).not.toHaveBeenCalled();
  });

  it("fails open: a transient checkPrOpen error still writes the summary", async () => {
    state.open = true;
    state.throws = true;
    upsertCombinedSummary.mockClear();
    await runReviews(baseConfig(), logger);
    expect(upsertCombinedSummary).toHaveBeenCalledTimes(1);
    state.throws = false;
  });
});

describe("GitLab orchestration freshness", () => {
  for (const open of [true, false]) {
    it(`uses the GitLab binding when MR open=${open}`, async () => {
      state.open = open;
      state.reason = "merged";
      state.throws = false;
      upsertCombinedSummary.mockClear();
      const ref = { project: "admetrics/example", mrIid: 5 };
      const outcomes = await runReviews(
        baseConfig({
          target: { kind: "gitlab", ref, apiUrl: "https://gitlab.example.com" },
        }),
        logger,
      );
      expect(outcomes).toHaveLength(1);
      if (open)
        expect(upsertCombinedSummary).toHaveBeenCalledWith(
          ref,
          expect.any(String),
        );
      else expect(upsertCombinedSummary).not.toHaveBeenCalled();
    });
  }
});
