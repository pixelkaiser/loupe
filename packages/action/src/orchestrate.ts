import type { ForgeBinding, ReviewResult } from "@loupe/core";
import type { Logger } from "@loupe/logger";

import type { Config } from "./config";
import { loadReviewers } from "./reviewers";
import {
  formatResult,
  reviewBound,
  wireBinding,
  type ReviewRunOptions,
} from "./run";
import {
  createTraceCollector,
  writeReviewsTraceToSummary,
  type ReviewerTrace,
} from "./trace";

/** Post through whichever forge the binding carries (the switch narrows the
 * forge/ref pair to matching concrete types). */
async function postTopLevelComment(
  binding: ForgeBinding,
  body: string,
): Promise<void> {
  switch (binding.kind) {
    case "github":
      return binding.forge.postIssueComment(binding.ref, body);
    case "gitlab":
      return binding.forge.postIssueComment(binding.ref, body);
  }
}

async function publishCombinedSummary(
  binding: ForgeBinding,
  body: string,
): Promise<void> {
  switch (binding.kind) {
    case "github":
      return binding.forge.upsertCombinedSummary(binding.ref, body);
    case "gitlab":
      return binding.forge.upsertCombinedSummary(binding.ref, body);
  }
}

/** What one reviewer did: its result, or the failure that was reported on the PR. */
export class CombinedSummaryPublicationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CombinedSummaryPublicationError";
    this.cause = cause;
  }
}

export type ReviewerOutcome =
  | { readonly name: string; readonly ok: true; readonly result: ReviewResult }
  | { readonly name: string; readonly ok: false; readonly error: string };

/**
 * Run one reviewer, reporting its own failure on the PR/MR so a broken
 * reviewer never reads as silence. The failure comment carries a bounded
 * reason and no marker or SHA, so it can never be mistaken for a review or
 * advance incremental state. `onTrace` receives the reviewer's normalized
 * harness events (if the caller wants to record them).
 */
async function runOne(
  binding: ForgeBinding,
  input: ReviewRunOptions,
  label: string,
  logger: Logger,
  onTrace?: (e: Parameters<NonNullable<ReviewRunOptions["trace"]>>[0]) => void,
): Promise<ReviewerOutcome> {
  try {
    const result = await reviewBound(binding, {
      ...input,
      trace: onTrace,
    });
    logger.info(`[${label}] ${formatResult(result)}`);
    return { name: label, ok: true, result };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(`[${label}] review failed`, { error: reason });
    try {
      await postTopLevelComment(
        binding,
        `⚠️ loupe · ${label} could not complete this review — ${reason.split("\n")[0]?.slice(0, 300)}\n\nSee the CI run logs for details.`,
      );
    } catch (postErr) {
      logger.warn(`[${label}] could not post the failure comment`, {
        error: postErr instanceof Error ? postErr.message : String(postErr),
      });
    }
    return { name: label, ok: false, error: reason };
  }
}

function renderCombinedSummary(outcomes: readonly ReviewerOutcome[]): string {
  const sections = outcomes.map((outcome) => {
    const start = `<!-- loupe:section:${outcome.name}:start -->`;
    const end = `<!-- loupe:section:${outcome.name}:end -->`;
    let content: string;
    if (!outcome.ok) {
      content = `## ${outcome.name}\n\n⚠️ Reviewer failed: ${outcome.error.split("\n")[0]?.slice(0, 300)}`;
    } else if (!outcome.result.summaryBody) {
      content = `## ${outcome.name}\n\n_Not run: ${outcome.result.summary}_`;
    } else {
      content = outcome.result.summaryBody.replace(
        /^### 🔍 [^\n]+\n\n/,
        `## ${outcome.name}\n\n`,
      );
    }
    return `${start}\n${content}\n${end}`;
  });
  return [
    "# 🔍 Loupe review",
    ...sections,
    "Use `@loupe fix` to address all open findings.",
  ].join("\n\n---\n\n");
}

/**
 * Run the configured review(s) for a PR/MR — either the reviewer profiles from
 * `.loupe.json`, or a single default review. Shared by the pull_request entry
 * (main) and the `@loupe review` chat command. `overrideFull` forces a whole-PR
 * review regardless of config. Reviewer failures are reported on the PR here
 * and returned as outcomes. Only setup errors (bad config) reject.
 */
export async function runReviews(
  config: Config,
  logger: Logger,
  overrideFull?: boolean,
): Promise<ReviewerOutcome[]> {
  const full = overrideFull ?? config.full;
  const binding = wireBinding(config.target, config.token, logger);
  const base = {
    harnessName: config.harnessName,
    workdir: config.workdir,
    conventionPaths: config.conventionPaths,
    providers: config.providers,
    dirs: config.dirs,
    verify: config.verify,
    whipConfig: config.whipConfig,
    maxTurns: config.maxTurns,
    priorComments: config.priorComments,
    procedure: config.procedure,
    full,
  };

  const reviewersDone: {
    readonly run: Promise<ReviewerOutcome>;
    readonly readTrace: () => ReviewerTrace;
  }[] = [];

  if (config.configPath) {
    let reviewers = loadReviewers(config.configPath);
    if (config.reviewerFilter) {
      reviewers = reviewers.filter((r) => r.name === config.reviewerFilter);
    }
    logger.info("Running reviewers", {
      reviewers: reviewers.map((r) => r.name),
    });
    for (const r of reviewers) {
      const collector = createTraceCollector(r.name, config.harnessName);
      reviewersDone.push({
        run: runOne(
          binding,
          {
            ...base,
            reviewerName: r.name,
            guidance: r.guidance,
            include: r.include,
            exclude: r.exclude,
            agentic: r.agentic,
            model: r.model ?? config.model,
            reasoning: r.reasoning ?? config.reasoning,
            profile: r.profile ?? config.profile,
            verify: r.verify ?? config.verify,
            pathInstructions: r.pathInstructions,
            ensembleModels:
              r.ensemble ??
              (config.ensembleModels.length
                ? config.ensembleModels
                : undefined),
            skills: [...new Set([...(r.skills ?? []), ...config.skills])],
            timezone: config.timezone,
            maxTurns: r.maxTurns ?? config.maxTurns,
            priorComments: r.priorComments ?? config.priorComments,
            procedure: r.procedure ?? config.procedure,
            dirs: r.dirs ?? config.dirs,
            deferSummary: true,
            logger,
          },
          r.name,
          logger,
          collector.emit,
        ),
        readTrace: collector.read,
      });
    }
  } else {
    const collector = createTraceCollector("default", config.harnessName);
    reviewersDone.push({
      run: runOne(
        binding,
        {
          ...base,
          model: config.model,
          reasoning: config.reasoning,
          profile: config.profile,
          guidance: config.guidance,
          ensembleModels: config.ensembleModels.length
            ? config.ensembleModels
            : undefined,
          skills: config.skills.length ? config.skills : undefined,
          timezone: config.timezone,
          deferSummary: true,
          logger,
        },
        "default",
        logger,
        collector.emit,
      ),
      readTrace: collector.read,
    });
  }

  // All reviewers run concurrently. Each writes only into its own collector
  // array, so there is no shared mutable buffer to race on. Wait for every
  // outcome (success or failure) before touching the summary: the trace must
  // reflect the whole run, including reviewers that errored mid-stream.
  const outcomes = await Promise.all(reviewersDone.map((r) => r.run));
  const traces = reviewersDone.map((r) => r.readTrace());

  // Offline, no model calls: append the captured transcripts to the step
  // summary after outcomes have completed. No-op unless GITHUB_STEP_SUMMARY is
  // set (e.g. local runs can point it at a scratch file).
  try {
    writeReviewsTraceToSummary(traces);
  } catch (err) {
    logger.warn("Could not write the review traces to the step summary", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await publishCombinedSummary(binding, renderCombinedSummary(outcomes));
  } catch (err) {
    throw new CombinedSummaryPublicationError(err);
  }
  return outcomes;
}
