import {
  makeGithubForge,
  makeGitlabForge,
  runReview,
  type Forge,
  type ForgeBinding,
  type Profile,
  type ReasoningEffort,
  type ReviewResult,
} from "@loupe/core";
import {
  resolveCredentials,
  type CredentialProvider,
} from "@loupe/credentials";
import { getHarness, type WhipConfig } from "@loupe/harness";
import type { Logger } from "@loupe/logger";

import type { ForgeTarget } from "./config";

/** Everything a review needs except the forge and its ref. */
export type ReviewRunOptions = {
  readonly harnessName: string;
  readonly workdir: string;
  readonly conventionPaths: readonly string[];
  readonly providers: readonly CredentialProvider[];
  readonly subdir?: string;
  readonly dryRun?: boolean;
  readonly model?: string;
  readonly reasoning: ReasoningEffort;
  readonly guidance?: string;
  readonly reviewerName?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly agentic?: boolean;
  readonly profile?: Profile;
  readonly verify?: boolean;
  readonly full?: boolean;
  readonly pathInstructions?: readonly { glob: string; instruction: string }[];
  readonly ensembleModels?: readonly string[];
  readonly skills?: readonly string[];
  readonly timezone?: string;
  readonly whipConfig?: WhipConfig;
  readonly maxTurns?: number;
  readonly logger: Logger;
};

export type RunInput<R> = ReviewRunOptions & {
  readonly forge: Forge<R>;
  readonly ref: R;
};

/** Resolve the harness + its credentials, then review. Shared by Action and CLI. */
export async function reviewPullRequest<R>(
  input: RunInput<R>,
): Promise<ReviewResult> {
  const { logger } = input;
  const harness = getHarness(input.harnessName);

  if (!(await harness.available())) {
    throw new Error(`Harness "${harness.name}" CLI is not installed.`);
  }

  // Best-effort: forward whatever credential keys the providers can supply.
  // We don't hard-fail on a missing key — harnesses often self-authenticate
  // from a local login (whip via ~/.whip, claude via its own login). If a key
  // is genuinely required and absent, the harness surfaces its own auth error.
  const harnessEnv = await resolveCredentials(
    harness.credentialKeys,
    input.providers,
  );
  const missing = harness.credentialKeys.filter((k) => !(k in harnessEnv));
  logger.debug("Harness ready", {
    harness: harness.name,
    forwardedKeys: Object.keys(harnessEnv),
    missingKeys: missing,
    providers: input.providers.map((p) => p.name),
  });

  return runReview({
    forge: input.forge,
    ref: input.ref,
    harness,
    workdir: input.workdir,
    harnessEnv,
    whipConfig: input.whipConfig,
    conventionPaths: input.conventionPaths,
    subdir: input.subdir,
    dryRun: input.dryRun,
    model: input.model,
    reasoning: input.reasoning,
    guidance: input.guidance,
    reviewerName: input.reviewerName,
    include: input.include,
    exclude: input.exclude,
    agentic: input.agentic,
    profile: input.profile,
    verify: input.verify,
    full: input.full,
    pathInstructions: input.pathInstructions,
    ensembleModels: input.ensembleModels,
    skills: input.skills,
    timezone: input.timezone,
    maxTurns: input.maxTurns,
    logger,
  });
}

/** Build the live forge adapter for a config/CLI target. The entry layer calls
 * this because forge factories need a logger, which config loading doesn't. */
export function wireBinding(
  target: ForgeTarget,
  token: string,
  logger: Logger,
): ForgeBinding {
  switch (target.kind) {
    case "github":
      return {
        kind: "github",
        forge: makeGithubForge(token, logger),
        ref: target.ref,
      };
    case "gitlab":
      return {
        kind: "gitlab",
        forge: makeGitlabForge({
          baseUrl: target.apiUrl,
          token,
          logger,
        }),
        ref: target.ref,
      };
  }
}

/** Review through a `ForgeBinding` — the two branches only exist so the
 * forge/ref pair narrows to matching concrete types for `runReview<R>`. */
export function reviewBound(
  binding: ForgeBinding,
  options: ReviewRunOptions,
): Promise<ReviewResult> {
  switch (binding.kind) {
    case "github":
      return reviewPullRequest({
        ...options,
        forge: binding.forge,
        ref: binding.ref,
      });
    case "gitlab":
      return reviewPullRequest({
        ...options,
        forge: binding.forge,
        ref: binding.ref,
      });
  }
}

export function formatResult(result: ReviewResult): string {
  return (
    `loupe: ${result.inlineCount} inline comment(s)` +
    (result.droppedCount > 0
      ? `, ${result.droppedCount} off-diff note(s)`
      : "") +
    (result.requestedChanges ? " — requested changes" : "")
  );
}

const SEVERITY_MARK: Record<string, string> = {
  blocker: "🔴",
  warning: "🟡",
  nit: "🔵",
};

/** Human-readable rendering of a dry-run review for the terminal. */
export function renderReview(result: ReviewResult): string {
  const lines = [`\nSummary: ${result.summary}\n`];
  for (const f of [...result.inline, ...result.dropped]) {
    lines.push(`${SEVERITY_MARK[f.severity] ?? "•"} ${f.path}:${f.line}`);
    lines.push(`   ${f.body}\n`);
  }
  return lines.join("\n");
}
