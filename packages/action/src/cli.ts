#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import type { Profile, ReasoningEffort } from "@loupe/core";
import { createRootLogger, shutdownLogger } from "@loupe/logger";
import { Command } from "commander";

import { resolveProviders, type ForgeTarget } from "./config";
import { loadReviewers, loadSettings } from "./reviewers";
import { formatResult, renderReview, reviewBound, wireBinding } from "./run";

const REASONING: readonly ReasoningEffort[] = ["low", "medium", "high"];

function parseReasoning(raw: string): ReasoningEffort {
  if ((REASONING as readonly string[]).includes(raw))
    return raw as ReasoningEffort;
  throw new Error(`Invalid --reasoning "${raw}". Use: ${REASONING.join(", ")}`);
}

const PROFILES: readonly Profile[] = ["quiet", "chill", "assertive"];

function parseProfile(raw: string): Profile {
  if ((PROFILES as readonly string[]).includes(raw)) return raw as Profile;
  throw new Error(`Invalid --profile "${raw}". Use: ${PROFILES.join(", ")}`);
}

/**
 * Parse a review target: a GitHub PR URL or `owner/repo#N`, or a GitLab MR
 * URL (any host — the host drives the API base for self-hosted instances) or
 * `group/project!N` shorthand. Returns the config-shaped target plus the
 * GitLab host when it was known from the URL (used for `glab auth`).
 */
function parseTarget(
  input: string,
  apiFlag?: string,
): { target: ForgeTarget; host?: string } {
  // GitHub PR URL
  let m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(input);
  if (m?.[1] && m[2] && m[3]) {
    return {
      target: {
        kind: "github",
        ref: { owner: m[1], repo: m[2], pull_number: Number(m[3]) },
      },
    };
  }
  // GitLab MR URL — https://<host>/<group…>/<project>/-/merge_requests/N
  m = /^(?:https?:\/\/)?([^/\s]+)\/(.+?)\/-\/merge_requests\/(\d+)\/?$/.exec(
    input,
  );
  if (m?.[1] && m[2] && m[3]) {
    const host = m[1];
    return {
      target: {
        kind: "gitlab",
        ref: { project: m[2], mrIid: Number(m[3]) },
        apiUrl: apiFlag ?? `https://${host}`,
      },
      host,
    };
  }
  // GitLab shorthand — group/project!N (nested groups allowed)
  m = /^([^\s!?#]+)!(\d+)$/.exec(input);
  if (m?.[1] && m[2]) {
    return {
      target: {
        kind: "gitlab",
        ref: { project: m[1], mrIid: Number(m[2]) },
        apiUrl: apiFlag ?? "https://gitlab.com",
      },
    };
  }
  // GitHub shorthand — owner/repo#N
  m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(input);
  if (m?.[1] && m[2] && m[3]) {
    return {
      target: {
        kind: "github",
        ref: { owner: m[1], repo: m[2], pull_number: Number(m[3]) },
      },
    };
  }
  throw new Error(
    `Could not parse target "${input}". Use a GitHub PR URL or owner/repo#N, ` +
      "or a GitLab MR URL or group/project!N.",
  );
}

/** GITHUB_TOKEN env, else the gh CLI's token. */
function resolveGithubToken(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const res = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  const token = res.status === 0 ? res.stdout.trim() : "";
  if (!token) {
    throw new Error(
      "No token: set GITHUB_TOKEN, pass --token, or run `gh auth login`.",
    );
  }
  return token;
}

/** GITLAB_TOKEN env, else the glab CLI's token (scoped to the MR's host). */
function resolveGitlabToken(explicit?: string, host?: string): string {
  if (explicit) return explicit;
  if (process.env.GITLAB_TOKEN) return process.env.GITLAB_TOKEN;
  const env =
    host && host !== "gitlab.com"
      ? { ...process.env, GITLAB_HOST: `https://${host}` }
      : process.env;
  const res = spawnSync("glab", ["auth", "token"], { encoding: "utf8", env });
  const token = res.status === 0 ? res.stdout.trim() : "";
  if (!token) {
    throw new Error(
      "No token: set GITLAB_TOKEN, pass --token, or run `glab auth login`.",
    );
  }
  return token;
}

const program = new Command();

program
  .name("loupe")
  .description("AI PR/MR reviewer that posts inline comments (GitHub, GitLab)")
  .version("0.1.0");

program
  .command("review")
  .description("Review a pull/merge request and post inline comments")
  .argument(
    "<pr>",
    "GitHub PR URL or owner/repo#N · GitLab MR URL or group/project!N",
  )
  .option("-H, --harness <name>", "agent CLI to review with (default whip)")
  .option("-m, --model <name>", "model id for the harness (default kimi-k3)")
  .option(
    "-r, --reasoning <level>",
    "reasoning effort: low|medium|high (default low)",
  )
  .option(
    "--prompt-file <path>",
    "custom reviewer guidance replacing the default (output contract still enforced)",
  )
  .option("-p, --providers <spec>", "credential provider chain", "env,dotenv")
  .option(
    "-t, --token <token>",
    "forge API token (else GITHUB_TOKEN/GITLAB_TOKEN or gh/glab)",
  )
  .option(
    "--api <url>",
    "GitLab instance origin for shorthand refs (default https://gitlab.com)",
  )
  .option(
    "-w, --workdir <dir>",
    "repo checkout the harness may read",
    process.cwd(),
  )
  .option(
    "-c, --conventions <paths>",
    "convention docs to enforce",
    "CLAUDE.md,AGENTS.md,.loupe.md,CONTRIBUTING.md",
  )
  .option(
    "-d, --dir <subdir>",
    "restrict review to a repo subdirectory (e.g. inference)",
  )
  .option(
    "--config <path>",
    "reviewer-profiles config (.loupe.json) — runs each matching reviewer",
  )
  .option("--reviewer <name>", "run only this named reviewer from --config")
  .option(
    "--no-agentic",
    "review one-shot from the diff only, instead of exploring the checkout with tools",
  )
  .option(
    "--profile <name>",
    "noise profile: quiet|chill|assertive (default chill)",
  )
  .option("--timezone <tz>", "timezone label for the review environment line")
  .option(
    "--ensemble <models>",
    "comma-separated models to ensemble; keep findings a majority agree on",
  )
  .option(
    "--skills <paths>",
    "comma-separated skill paths (SKILL.md or skill dir) to fold into the reviewer",
  )
  .option("--max-turns <n>", "cap the agentic tool loop (default 10)", (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0)
      throw new Error(`Invalid --max-turns "${v}". Use a positive integer.`);
    return n;
  })
  .option("--no-verify", "skip the second-opinion verification pass")
  .option(
    "--full",
    "review the whole PR instead of the incremental delta",
    false,
  )
  .option("--dry-run", "compute and log the review without posting it", false)
  .option("--infisical-env <env>", "Infisical environment slug")
  .option("--infisical-project <id>", "Infisical project id")
  .action(
    async (
      pr: string,
      opts: {
        harness?: string;
        model?: string;
        reasoning?: string;
        promptFile?: string;
        providers: string;
        token?: string;
        api?: string;
        workdir: string;
        conventions: string;
        dir?: string;
        config?: string;
        reviewer?: string;
        agentic: boolean;
        profile?: string;
        timezone?: string;
        maxTurns?: number;
        ensemble?: string;
        skills?: string;
        verify: boolean;
        full: boolean;
        dryRun: boolean;
        infisicalEnv?: string;
        infisicalProject?: string;
      },
    ) => {
      const logger = createRootLogger("loupe-cli");
      try {
        const { target, host } = parseTarget(pr, opts.api);
        const token =
          target.kind === "github"
            ? resolveGithubToken(opts.token)
            : resolveGitlabToken(opts.token, host);
        const binding = wireBinding(target, token, logger);
        // Top-level review defaults from .loupe.json; a flag overrides the file,
        // the file overrides loupe's built-in default.
        const settings = opts.config ? loadSettings(opts.config) : {};
        const harnessName = opts.harness ?? settings.harness ?? "whip";
        const model = opts.model ?? settings.model ?? "kimi-k3";
        const reasoning = parseReasoning(
          opts.reasoning ?? settings.reasoning ?? "low",
        );
        const profile = parseProfile(
          opts.profile ?? settings.profile ?? "chill",
        );
        const timezone = opts.timezone ?? settings.timezone ?? "UTC";
        const subdir = opts.dir ?? settings.dir;
        const maxTurns = opts.maxTurns ?? settings.maxTurns;
        const ensembleModels = opts.ensemble
          ? opts.ensemble
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean)
          : undefined;
        const skills = opts.skills
          ? opts.skills
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean)
          : undefined;
        const base = {
          harnessName,
          workdir: opts.workdir,
          conventionPaths: opts.conventions
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean),
          providers: resolveProviders(opts.providers, {
            env: opts.infisicalEnv,
            projectId: opts.infisicalProject,
          }),
          subdir,
          dryRun: opts.dryRun,
          verify: opts.verify,
          full: opts.full,
          ensembleModels,
          skills,
          timezone,
          maxTurns,
          whipConfig: settings.whip,
        };

        if (opts.config) {
          let reviewers = loadReviewers(opts.config);
          if (opts.reviewer) {
            reviewers = reviewers.filter((r) => r.name === opts.reviewer);
            if (reviewers.length === 0) {
              throw new Error(`No reviewer named "${opts.reviewer}" in config`);
            }
          }
          logger.info("Running reviewers", {
            reviewers: reviewers.map((r) => r.name),
          });
          // Sequential: harnesses are heavy and may share rate limits.
          for (const r of reviewers) {
            const result = await reviewBound(binding, {
              ...base,
              reviewerName: r.name,
              guidance: r.guidance,
              include: r.include,
              exclude: r.exclude,
              agentic: r.agentic ?? opts.agentic,
              model: r.model ?? model,
              reasoning: r.reasoning ? parseReasoning(r.reasoning) : reasoning,
              profile: r.profile ?? profile,
              verify: r.verify ?? opts.verify,
              pathInstructions: r.pathInstructions,
              ensembleModels: r.ensemble ?? ensembleModels,
              skills: r.skills ?? skills,
              maxTurns: r.maxTurns ?? maxTurns,
              logger,
            });
            logger.info(`[${r.name}] ${formatResult(result)}`);
            if (opts.dryRun) console.log(renderReview(result));
          }
          return;
        }

        const result = await reviewBound(binding, {
          ...base,
          agentic: opts.agentic,
          model,
          reasoning,
          profile,
          guidance: opts.promptFile
            ? readFileSync(opts.promptFile, "utf8")
            : undefined,
          logger,
        });
        logger.info(formatResult(result));
        if (opts.dryRun) console.log(renderReview(result));
      } finally {
        await shutdownLogger();
      }
    },
  );

program.parseAsync().catch((err: unknown) => {
  console.error("loupe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
