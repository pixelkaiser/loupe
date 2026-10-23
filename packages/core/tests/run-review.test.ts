import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Harness,
  HarnessContext,
  HarnessTraceEvent,
} from "@loupe/harness";
import { describe, expect, it, vi } from "vitest";

import { githubForgeFor, runReview, type ReviewRequest } from "../src/index";
import type { PullRef } from "../src/github";

const ref: PullRef = { owner: "acme", repo: "app", pull_number: 7 };
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};
logger.child.mockReturnValue(logger);

const patchA =
  "@@ -1,2 +1,3 @@\n line\n+export async function selectThing() {}\n line2";
const patchB = "@@ -10,2 +10,3 @@\n line\n+changed in B\n line2";
const prFiles = [
  { filename: "svc/a.ts", patch: patchA },
  { filename: "svc/b.ts", patch: patchB },
];
const marker = `<!-- loupe:code sha=${SHA_A} -->`;

/** A checkout with the `svc` subdir so the review runs in tree mode. */
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "loupe-e2e-"));
  mkdirSync(join(dir, "svc", "cmd"), { recursive: true });
  writeFileSync(join(dir, "svc", "package.json"), "{}");
  writeFileSync(
    join(dir, "svc", "cmd", "run.ts"),
    "await withProgress(() => selectThing());\n",
  );
  return dir;
}

type FakeGitHub = {
  /** Summary comment carrying the last-reviewed marker, if any. */
  priorSummarySha?: string;
  /** Files GitHub reports changed between prior and head. */
  compare?: string[] | Error;
  /** Review threads on the PR, one per path, rooted by loupe with the marker. */
  threads?: string[];
  /** Makes the FIRST issue-comment listing throw (the history lookup). */
  listCommentsError?: Error;
};

function fakeOctokit(gh: FakeGitHub) {
  const calls: string[] = [];
  const graphql = vi.fn(
    async (query: string, vars?: Record<string, unknown>) => {
      if (query.includes("resolveReviewThread")) {
        calls.push(`resolve:${String(vars?.["threadId"])}`);
        return {};
      }
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: (gh.threads ?? []).map((path) => ({
                id: `thread:${path}`,
                path,
                isResolved: false,
                viewerCanResolve: true,
                comments: {
                  nodes: [
                    {
                      body: `old ${marker}`,
                      author: { login: "bot" },
                      replyTo: null,
                    },
                  ],
                },
              })),
            },
          },
        },
      };
    },
  );
  const api = {
    graphql,
    users: {
      getAuthenticated: vi.fn(async () => ({ data: { login: "bot" } })),
    },
    pulls: {
      get: vi.fn(async () => ({
        data: { title: "Change A and B", body: "desc", head: { sha: SHA_B } },
      })),
      listFiles: vi.fn(),
      listReviews: vi.fn(),
      listReviewComments: vi.fn(),
      createReview: vi.fn(async () => {
        calls.push("createReview");
        return {};
      }),
      deleteReviewComment: vi.fn(),
    },
    issues: {
      listComments: vi.fn(),
      createComment: vi.fn(async (_input: { body: string }) => {
        calls.push("createComment");
        return {};
      }),
      updateComment: vi.fn(async (_input: { body: string }) => {
        calls.push("updateComment");
        return {};
      }),
    },
    repos: {
      getContent: vi.fn(async () => {
        throw new Error("404");
      }),
      compareCommits: vi.fn(async () => {
        if (gh.compare instanceof Error) throw gh.compare;
        return {
          data: { files: (gh.compare ?? []).map((filename) => ({ filename })) },
        };
      }),
    },
    paginate: vi.fn(async (method: unknown) => {
      if (method === api.pulls.listFiles) return prFiles;
      if (method === api.issues.listComments) {
        if (gh.listCommentsError) {
          const err = gh.listCommentsError;
          gh.listCommentsError = undefined;
          throw err;
        }
        return gh.priorSummarySha
          ? [
              {
                id: 1,
                user: { login: "bot" },
                body: `### summary\n\n<!-- loupe:summary:code sha=${gh.priorSummarySha} -->`,
              },
            ]
          : [];
      }
      return [];
    }),
    calls,
  };
  return api;
}

/**
 * A harness that records every prompt and answers from a script keyed by
 * prompt kind: the agentic review, the headless retry, and the verify pass.
 */
function fakeHarness(script: {
  agentic: string | Error;
  headless?: string;
  verify?: string | Error;
}) {
  const contexts: HarnessContext[] = [];
  const harness: Harness = {
    name: "fake",
    credentialKeys: [],
    available: async () => true,
    review: async (ctx) => {
      contexts.push(ctx);
      const verifying = ctx.systemPrompt.startsWith(
        "You are a strict reviewer verifying",
      );
      ctx.trace?.({
        type: "reasoning",
        delta: verifying ? "verify evidence" : "inspect change",
        model: ctx.model,
        phase: ctx.phase,
      });
      if (verifying) {
        const output = script.verify ?? "";
        if (output instanceof Error) throw output;
        ctx.trace?.({
          type: "done",
          text: output,
          model: ctx.model,
          phase: ctx.phase,
        });
        return output;
      }
      if (ctx.agentic && script.agentic instanceof Error) {
        ctx.trace?.({
          type: "error",
          error: script.agentic.message,
          model: ctx.model,
          phase: ctx.phase,
        });
        throw script.agentic;
      }
      const output = ctx.agentic
        ? (script.agentic as string)
        : (script.headless ?? "");
      ctx.trace?.({
        type: "done",
        text: output,
        model: ctx.model,
        phase: ctx.phase,
      });
      return output;
    },
  };
  return { harness, contexts };
}

function request(
  api: ReturnType<typeof fakeOctokit>,
  harness: Harness,
  workdir: string,
  extra: Partial<ReviewRequest<PullRef>> = {},
): ReviewRequest<PullRef> {
  return {
    forge: githubForgeFor(api as never, logger),
    ref,
    harness,
    workdir,
    harnessEnv: {},
    conventionPaths: ["AGENTS.md"],
    dirs: ["svc"],
    reviewerName: "code",
    logger,
    ...extra,
  };
}

const reviewJson = (findings: object[]) =>
  JSON.stringify({
    summary: "reviewed",
    findings,
    concerns: [],
    highlights: [],
  });
const verifyAll = (n: number) =>
  JSON.stringify({
    verdicts: Array.from({ length: n }, (_, i) => ({ index: i, real: true })),
  });

describe("runReview end to end", () => {
  it("lets an explicit false opt out of evidence collection", async () => {
    const api = fakeOctokit({});
    const { harness, contexts } = fakeHarness({ agentic: reviewJson([]) });
    await runReview(
      request(api, harness, checkout(), {
        evidence: false,
        dryRun: true,
        full: true,
      }),
    );
    const prompt = contexts[0]!.userPrompt;
    const path = prompt
      .split(String.fromCharCode(96))
      .find((part) => part.endsWith("/pr.diff"));
    expect(path && existsSync(path)).toBe(true);
    expect(prompt).not.toContain("Source evidence collected before review");
    expect(contexts[0]!.systemPrompt).not.toContain("pre-collected source");
  });

  it("does not promise source evidence for headless reviews or missing checkouts", async () => {
    for (const agentic of [false, true]) {
      const api = fakeOctokit({});
      const { harness, contexts } = fakeHarness({
        agentic: reviewJson([]),
        headless: reviewJson([]),
      });
      await runReview(
        request(api, harness, join(checkout(), "missing"), {
          agentic,
          evidence: true,
          dryRun: true,
          full: true,
        }),
      );
      expect(contexts[0]!.userPrompt).not.toContain(
        "Source evidence collected before review",
      );
      expect(contexts[0]!.systemPrompt).not.toContain("pre-collected source");
    }
  });

  it("enables evidence by default with stable prompts across checkout paths and minutes", async () => {
    const prompts: string[] = [];
    for (const [minute, evidence] of [
      [1, undefined],
      [59, true],
    ] as const) {
      const workdir = checkout();
      writeFileSync(
        join(workdir, "svc/a.ts"),
        "export async function selectThing() {\n return 1;\n}\n",
      );
      const api = fakeOctokit({});
      const { harness, contexts } = fakeHarness({ agentic: reviewJson([]) });
      await runReview(
        request(api, harness, workdir, {
          evidence,
          full: true,
          dryRun: true,
          now: new Date(Date.UTC(2026, 9, 20, 10, minute)),
        }),
      );
      const context = contexts[0]!;
      expect(context.userPrompt).toContain("Diff under review:");
      expect(context.userPrompt).toContain(
        "Source evidence collected before review",
      );
      expect(context.userPrompt).toContain("2|  return 1;");
      expect(context.userPrompt).toContain("Environment: current date is");
      expect(context.userPrompt).not.toContain(workdir);
      expect(context.userPrompt).not.toContain("/pr.diff");
      expect(context.systemPrompt).toContain("pre-collected source");
      expect(context.agentic).toBe(true);
      expect(api.calls).toEqual([]);
      prompts.push(context.systemPrompt + "\n" + context.userPrompt);
    }
    expect(prompts[0]).toBe(prompts[1]);
  });

  it("keeps the full diff accessible when evidence mode's inline diff cap is exceeded", async () => {
    const workdir = checkout();
    const api = fakeOctokit({});
    api.paginate.mockImplementation(async (method: unknown) => {
      if (method === api.pulls.listFiles) {
        return [
          {
            filename: "svc/a.ts",
            patch: "@@ -1 +1 @@\n+" + "x".repeat(25_000),
          },
        ];
      }
      return [];
    });
    const { harness, contexts } = fakeHarness({ agentic: reviewJson([]) });
    await runReview(
      request(api, harness, workdir, {
        evidence: true,
        full: true,
        dryRun: true,
      }),
    );
    const path = contexts[0]!.userPrompt
      .split(String.fromCharCode(96))
      .find((s) => s.endsWith("/pr.diff"));
    expect(path && readFileSync(path, "utf8")).toContain("x".repeat(25_000));
    expect(contexts[0]!.systemPrompt).toContain("read the remaining hunks");
  });

  it("incremental run: whole in-scope diff on disk, only B reassessed, A findings dropped, cleanup scoped to B after posting", async () => {
    const api = fakeOctokit({
      priorSummarySha: SHA_A,
      compare: ["svc/b.ts"],
      threads: ["svc/a.ts", "svc/b.ts"],
    });
    const { harness, contexts } = fakeHarness({
      agentic: reviewJson([
        { path: "svc/b.ts", line: 11, severity: "warning", body: "B is wrong" },
        { path: "svc/a.ts", line: 2, severity: "warning", body: "A is wrong" },
      ]),
      verify: verifyAll(1),
    });
    const workdir = checkout();

    const result = await runReview(request(api, harness, workdir));

    // The agent saw the full in-scope diff inline, source evidence, a focus
    // list naming only B, and the subdir cwd mapping.
    const agenticCtx = contexts[0]!;
    expect(agenticCtx.agentic).toBe(true);
    expect(agenticCtx.workdir).toBe(join(workdir, "svc"));
    expect(agenticCtx.userPrompt).toContain("### svc/a.ts");
    expect(agenticCtx.userPrompt).toContain("### svc/b.ts");
    expect(agenticCtx.userPrompt).toContain(
      "Source evidence collected before review",
    );
    const focus = /Files to reassess[^]*?\n\n/.exec(agenticCtx.userPrompt)![0];
    expect(focus).toContain("- svc/b.ts");
    expect(focus).not.toContain("- svc/a.ts");
    expect(agenticCtx.userPrompt).toContain(
      "+export async function selectThing",
    );
    expect(agenticCtx.userPrompt).toContain("Your working directory is `svc/`");
    // Callers of the changed export were located mechanically and rendered
    // with repo-relative paths.
    expect(agenticCtx.userPrompt).toContain("Call sites of changed exports");
    expect(agenticCtx.userPrompt).toContain(
      "- svc/cmd/run.ts:1  await withProgress(() => selectThing());",
    );
    expect(agenticCtx.userPrompt).toContain(
      "`selectThing` (changed in this diff) is called from:",
    );
    expect(agenticCtx.systemPrompt).toContain("Procedure — do these before");

    // The verify pass ran headless over the one in-scope finding.
    expect(contexts[1]!.agentic).toBe(false);
    expect(contexts[1]!.userPrompt).toContain("#0 [warning] svc/b.ts:11");
    expect(contexts[1]!.userPrompt).not.toContain("A is wrong");

    // Only B's finding posted; A's was dropped as out of scope.
    expect(result.inline.map((f) => `${f.path}:${f.line}`)).toEqual([
      "svc/b.ts:11",
    ]);
    expect(result.diagnostics).toEqual({
      mode: "agentic",
      verify: "passed",
      incremental: "delta",
      malformedDropped: { findings: 0, concerns: 0 },
      outOfScopeDropped: 1,
      profileDropped: 0,
      verifyDropped: 0,
      offDiff: 0,
      salvagedFindings: 0,
    });

    // Only B's prior thread resolved, and only after review + summary posted.
    expect(api.calls).toEqual([
      "createReview",
      "updateComment",
      "resolve:thread:svc/b.ts",
    ]);
    expect(api.pulls.deleteReviewComment).not.toHaveBeenCalled();
    const summary = api.issues.updateComment.mock.calls[0]![0]!.body;
    expect(summary).toContain(`<!-- loupe:summary:code sha=${SHA_B} -->`);
    expect(summary).toContain("<summary>Run details</summary>");
    expect(summary).not.toContain("⚠️ degraded run");
  });

  it("history lookup failure: full review, prior threads untouched, run marked degraded", async () => {
    const api = fakeOctokit({
      listCommentsError: new Error("rate limited"),
      threads: ["svc/a.ts"],
    });
    const { harness, contexts } = fakeHarness({ agentic: reviewJson([]) });

    const result = await runReview(request(api, harness, checkout()));

    expect(contexts[0]!.userPrompt).not.toContain("Files to reassess");
    expect(result.diagnostics.incremental).toBe("unknown");
    expect(api.graphql).not.toHaveBeenCalled();
    expect(api.calls).toEqual(["createComment"]);
    expect(api.issues.createComment.mock.calls[0]![0]!.body).toContain(
      "⚠️ degraded run",
    );
  });

  it("agentic output that is not a review falls back to one headless retry", async () => {
    const api = fakeOctokit({});
    const { harness, contexts } = fakeHarness({
      agentic: "I looked around but here is prose, no JSON.",
      headless: reviewJson([
        { path: "svc/a.ts", line: 2, severity: "blocker", body: "boom" },
      ]),
      verify: verifyAll(1),
    });

    const result = await runReview(request(api, harness, checkout()));

    expect(contexts.map((c) => c.agentic)).toEqual([true, false, false]);
    expect(contexts[1]!.userPrompt).toContain("Diff under review:");
    expect(contexts[1]!.userPrompt).toContain(
      "+export async function selectThing",
    );
    expect(result.diagnostics.mode).toBe("fallback");
    expect(result.requestedChanges).toBe(true);
    expect(api.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "REQUEST_CHANGES" }),
    );
    expect(api.issues.createComment.mock.calls[0]![0]!.body).toContain(
      "headless fallback",
    );
  });

  it("keeps an agentic review with a null diagram instead of retrying headless", async () => {
    const api = fakeOctokit({});
    const { harness, contexts } = fakeHarness({
      agentic: JSON.stringify({
        summary: "reviewed",
        findings: [],
        diagram: null,
      }),
    });

    const result = await runReview(request(api, harness, checkout()));

    expect(contexts).toHaveLength(1);
    expect(result.diagnostics.mode).toBe("agentic");
    expect(result.summary).toBe("reviewed");
  });

  it("preserves the full diff and source evidence in an incremental fallback while only reassessing B", async () => {
    const api = fakeOctokit({ priorSummarySha: SHA_A, compare: ["svc/b.ts"] });
    const workdir = checkout();
    writeFileSync(
      join(workdir, "svc/a.ts"),
      "export async function selectThing() {\n return 123;\n}\n",
    );
    const { harness, contexts } = fakeHarness({
      agentic: new Error("harness failed"),
      headless: reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "old A issue" },
        {
          path: "svc/b.ts",
          line: 11,
          severity: "warning",
          body: "new B issue",
        },
      ]),
      verify: verifyAll(1),
    });

    const result = await runReview(request(api, harness, workdir));

    const fallback = contexts[1]!;
    expect(fallback.agentic).toBe(false);
    expect(fallback.userPrompt).toContain("### svc/a.ts");
    expect(fallback.userPrompt).toContain("### svc/b.ts");
    expect(fallback.userPrompt).toContain(
      "Source evidence collected before review",
    );
    expect(fallback.userPrompt).toContain("return 123;");
    const focus = /Files to reassess[^]*?\n\n/.exec(fallback.userPrompt)![0];
    expect(focus).toContain("- svc/b.ts");
    expect(focus).not.toContain("- svc/a.ts");
    expect(fallback.systemPrompt).not.toContain("NO repository access");
    expect(fallback.systemPrompt).toMatch(/Do NOT call\s+tools/);
    expect(result.inline.map((finding) => finding.path)).toEqual(["svc/b.ts"]);
    expect(result.diagnostics.outOfScopeDropped).toBe(1);
    expect(contexts[2]!.userPrompt).toContain("### svc/a.ts");
    expect(contexts[2]!.userPrompt).toContain("return 123;");
  });

  it("verifies a standalone PR-wide concern against the full diff before requesting changes", async () => {
    const api = fakeOctokit({ priorSummarySha: SHA_A, compare: ["svc/b.ts"] });
    const { harness, contexts } = fakeHarness({
      agentic: JSON.stringify({
        summary: "reviewed",
        findings: [],
        concerns: [
          {
            title: "Missing implementation",
            detail: "A does not exist",
            severity: "blocker",
          },
        ],
      }),
      verify: JSON.stringify({
        verdicts: [{ index: 0, real: false, reason: "A is in the full diff" }],
      }),
    });

    const result = await runReview(request(api, harness, checkout()));

    expect(contexts).toHaveLength(2);
    expect(contexts[1]!.userPrompt).toContain("### svc/a.ts");
    expect(contexts[1]!.userPrompt).toContain(
      "#0 [blocker] PR-wide concern: Missing implementation",
    );
    expect(result.requestedChanges).toBe(false);
    expect(result.diagnostics.verify).toBe("passed");
    expect(result.diagnostics.verifyDropped).toBe(1);
    expect(api.issues.updateComment.mock.calls[0]![0]!.body).not.toContain(
      "Missing implementation",
    );
  });

  it("maps mixed verification verdicts to their inline findings and PR-wide concerns", async () => {
    const api = fakeOctokit({});
    const { harness, contexts } = fakeHarness({
      agentic: JSON.stringify({
        summary: "reviewed",
        findings: [
          {
            path: "svc/a.ts",
            line: 2,
            severity: "blocker",
            body: "False inline",
          },
        ],
        concerns: [
          {
            title: "Real concern",
            detail: "Supported by source",
            severity: "blocker",
          },
        ],
      }),
      verify: JSON.stringify({
        verdicts: [
          { index: 0, real: false },
          { index: 1, real: true },
        ],
      }),
    });

    const result = await runReview(request(api, harness, checkout()));

    expect(contexts[1]!.userPrompt).toContain("#0 [blocker] svc/a.ts:2");
    expect(contexts[1]!.userPrompt).toContain(
      "#1 [blocker] PR-wide concern: Real concern",
    );
    expect(result.inline).toEqual([]);
    expect(result.requestedChanges).toBe(true);
    expect(result.diagnostics.verify).toBe("passed");
    expect(result.diagnostics.verifyDropped).toBe(1);
    expect(api.issues.createComment.mock.calls[0]![0]!.body).toContain(
      "Real concern",
    );
  });

  it.each(["", JSON.stringify({ verdicts: [{ index: 0, real: false }] })])(
    "keeps findings and concerns when verification is incomplete: %s",
    async (verify) => {
      const api = fakeOctokit({});
      const { harness } = fakeHarness({
        agentic: JSON.stringify({
          summary: "reviewed",
          findings: [
            {
              path: "svc/a.ts",
              line: 2,
              severity: "warning",
              body: "Inline issue",
            },
          ],
          concerns: [
            { title: "Concern", detail: "Needs review", severity: "blocker" },
          ],
        }),
        verify,
      });

      const result = await runReview(request(api, harness, checkout()));

      expect(result.inline).toHaveLength(1);
      expect(result.requestedChanges).toBe(true);
      expect(result.diagnostics.verify).toBe("invalid");
      expect(result.diagnostics.verifyDropped).toBe(0);
      expect(api.issues.createComment.mock.calls[0]![0]!.body).toContain(
        "Concern",
      );
    },
  );

  it("keeps a PR-wide concern if verification fails and skips verification when disabled", async () => {
    for (const verify of [true, false]) {
      const api = fakeOctokit({});
      const { harness, contexts } = fakeHarness({
        agentic: JSON.stringify({
          summary: "reviewed",
          concerns: [
            { title: "Concern", detail: "Needs review", severity: "blocker" },
          ],
        }),
        verify: new Error("verification unavailable"),
      });

      const result = await runReview(
        request(api, harness, checkout(), { verify }),
      );

      expect(contexts).toHaveLength(verify ? 2 : 1);
      expect(result.requestedChanges).toBe(true);
      expect(result.diagnostics.verify).toBe(verify ? "failed" : "skipped");
      expect(api.issues.createComment.mock.calls[0]![0]!.body).toContain(
        "Concern",
      );
    }
  });

  it("tags primary and verification trace events", async () => {
    const api = fakeOctokit({});
    const { harness } = fakeHarness({
      agentic: reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "check me" },
      ]),
      verify: verifyAll(1),
    });
    const events: HarnessTraceEvent[] = [];

    await runReview(
      request(api, harness, checkout(), {
        model: "trace-model",
        trace: (event) => events.push(event),
      }),
    );

    expect(events.map((event) => `${event.phase}:${event.type}`)).toEqual([
      "primary:trace-model:reasoning",
      "primary:trace-model:done",
      "verify:trace-model:reasoning",
      "verify:trace-model:done",
    ]);
  });

  it("retains the failed primary trace before a successful fallback", async () => {
    const api = fakeOctokit({});
    const { harness } = fakeHarness({
      agentic: new Error("primary exploded"),
      headless: reviewJson([]),
    });
    const events: HarnessTraceEvent[] = [];

    const result = await runReview(
      request(api, harness, checkout(), {
        model: "trace-model",
        trace: (event) => events.push(event),
      }),
    );

    expect(result.diagnostics.mode).toBe("fallback");
    expect(events.map((event) => `${event.phase}:${event.type}`)).toEqual([
      "primary:trace-model:reasoning",
      "primary:trace-model:error",
      "fallback:trace-model:reasoning",
      "fallback:trace-model:done",
    ]);
    expect(
      events.find(
        (event) => event.type === "error" && event.phase?.startsWith("primary"),
      ),
    ).toEqual(expect.objectContaining({ error: "primary exploded" }));
  });

  it("tags every ensemble model independently and skips verification", async () => {
    const api = fakeOctokit({});
    const { harness } = fakeHarness({ agentic: reviewJson([]) });
    const events: HarnessTraceEvent[] = [];

    await runReview(
      request(api, harness, checkout(), {
        ensembleModels: ["model-a", "model-b"],
        trace: (event) => events.push(event),
      }),
    );

    expect(events.map((event) => `${event.phase}:${event.type}`)).toEqual([
      "ensemble:model-a:reasoning",
      "ensemble:model-a:done",
      "ensemble:model-b:reasoning",
      "ensemble:model-b:done",
    ]);
    expect(events.some((event) => event.phase?.startsWith("verify"))).toBe(
      false,
    );
  });

  it("compare at GitHub's 300-file cap is treated as unknown history", async () => {
    const api = fakeOctokit({
      priorSummarySha: SHA_A,
      compare: Array.from({ length: 300 }, (_, i) => `x/${i}.ts`),
      threads: ["svc/a.ts"],
    });
    const { harness } = fakeHarness({ agentic: reviewJson([]) });
    const result = await runReview(request(api, harness, checkout()));
    expect(result.diagnostics.incremental).toBe("unknown");
    expect(api.graphql).not.toHaveBeenCalled();
    expect(api.calls).toEqual(["updateComment"]);
  });

  it("dry run computes everything and writes nothing", async () => {
    const api = fakeOctokit({ threads: ["svc/a.ts"] });
    const { harness } = fakeHarness({
      agentic: reviewJson([
        { path: "svc/a.ts", line: 2, severity: "warning", body: "x" },
      ]),
      verify: verifyAll(1),
    });
    const result = await runReview(
      request(api, harness, checkout(), { dryRun: true }),
    );
    expect(result.inlineCount).toBe(1);
    expect(api.calls).toEqual([]);
    expect(api.graphql).not.toHaveBeenCalled();
  });
});
