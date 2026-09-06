import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  MergeRequestRef,
  Profile,
  PullRef,
  ReasoningEffort,
} from "@loupe/core";
import {
  dotenvProvider,
  envProvider,
  infisicalProvider,
  type CredentialProvider,
} from "@loupe/credentials";
import type { WhipConfig } from "@loupe/harness";
import { z } from "zod";

import { loadSettings, type LoupeSettings } from "./reviewers";

/** An empty string from an unset Action input counts as "not provided". */
const optionalInput = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

/**
 * All environment reading happens here, parsed with Zod, then passed inward as
 * typed values. Nothing downstream touches process.env. The forge is
 * auto-detected: GitLab CI sets GITLAB_CI; anything else is GitHub (the
 * original host, and the one GitHub Actions runs on).
 */

// Movable defaults: an unset input yields "" → undefined here, so a value in
// .loupe.json can win. Precedence (input → file → builtin) resolves below.
const loupeEnvSchema = z.object({
  LOUPE_HARNESS: optionalInput,
  LOUPE_MODEL: optionalInput,
  LOUPE_REASONING: optionalInput,
  LOUPE_PROMPT_FILE: z.string().optional(),
  LOUPE_CONVENTION_PATHS: z
    .string()
    .default("CLAUDE.md,AGENTS.md,.loupe.md,CONTRIBUTING.md"),
  LOUPE_CREDENTIAL_PROVIDERS: z.string().default("env"),
  LOUPE_INFISICAL_ENV: z.string().optional(),
  LOUPE_INFISICAL_PROJECT_ID: z.string().optional(),
  LOUPE_DIR: optionalInput,
  LOUPE_CONFIG: z.string().optional(),
  LOUPE_REVIEWER: z.string().optional(),
  LOUPE_PROFILE: optionalInput,
  LOUPE_VERIFY: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  LOUPE_FULL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOUPE_ENSEMBLE: z.string().default(""),
  LOUPE_SKILLS: z.string().default(""),
  LOUPE_TIMEZONE: optionalInput,
  LOUPE_MAX_TURNS: optionalInput,
});

const githubEnvSchema = loupeEnvSchema.extend({
  GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required"),
  GITHUB_REPOSITORY: z.string().regex(/^[^/]+\/[^/]+$/, "expected owner/repo"),
  GITHUB_EVENT_PATH: z.string().optional(),
  GITHUB_EVENT_NAME: z.string().optional(),
  GITHUB_WORKSPACE: z.string().optional(),
  LOUPE_PR_NUMBER: z.coerce.number().int().positive().optional(),
});

const gitlabEnvSchema = loupeEnvSchema.extend({
  GITLAB_TOKEN: z
    .string()
    .min(1, "GITLAB_TOKEN is required (project access token with api scope)"),
  CI_PROJECT_PATH: z.string().optional(),
  CI_PROJECT_ID: z.string().optional(),
  CI_MERGE_REQUEST_IID: z.coerce.number().int().positive(),
  CI_API_V4_URL: z.string().optional(),
  CI_PROJECT_DIR: z.string().optional(),
});

function asMaxTurns(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid max-turns "${v}". Use a positive integer.`);
  }
  return n;
}

const REASONING = ["low", "medium", "high"] as const;
const PROFILES = ["quiet", "chill", "assertive"] as const;

function asReasoning(v: string | undefined): ReasoningEffort | undefined {
  if (v === undefined) return undefined;
  if ((REASONING as readonly string[]).includes(v)) return v as ReasoningEffort;
  throw new Error(`Invalid reasoning "${v}". Use: ${REASONING.join(", ")}`);
}

function asProfile(v: string | undefined): Profile | undefined {
  if (v === undefined) return undefined;
  if ((PROFILES as readonly string[]).includes(v)) return v as Profile;
  throw new Error(`Invalid profile "${v}". Use: ${PROFILES.join(", ")}`);
}

/**
 * Which forge a run targets, minus the API client (that needs a logger, so
 * `wireBinding` in run.ts builds the live `ForgeBinding` at the entry).
 */
export type ForgeTarget =
  | { readonly kind: "github"; readonly ref: PullRef }
  | {
      readonly kind: "gitlab";
      readonly ref: MergeRequestRef;
      /** Instance origin, e.g. "https://gitlab.example.com". */
      readonly apiUrl: string;
    };

export type Config = {
  readonly target: ForgeTarget;
  /** The forge API token (the GitHub chat/fix path also uses it to push). */
  readonly token: string;
  readonly harnessName: string;
  readonly workdir: string;
  readonly conventionPaths: readonly string[];
  readonly providers: readonly CredentialProvider[];
  readonly subdir?: string;
  readonly model: string;
  readonly reasoning: ReasoningEffort;
  readonly guidance?: string;
  readonly configPath?: string;
  readonly reviewerFilter?: string;
  readonly profile: Profile;
  readonly verify: boolean;
  readonly full: boolean;
  readonly ensembleModels: readonly string[];
  readonly skills: readonly string[];
  readonly timezone: string;
  readonly whipConfig?: WhipConfig;
  readonly maxTurns?: number;
  readonly eventName?: string;
  readonly eventPath?: string;
};

/**
 * True under GitLab CI outside a merge-request pipeline (branch/tag/push):
 * loupe has nothing to review there, so the entry should exit cleanly.
 */
export function isGitlabNonMrPipeline(): boolean {
  return process.env.GITLAB_CI === "true" && !process.env.CI_MERGE_REQUEST_IID;
}

export function loadConfig(): Config {
  // GitLab CI sets GITLAB_CI; anything else is GitHub (the original host, and
  // the one GitHub Actions runs on).
  if (process.env.GITLAB_CI === "true") {
    const env = gitlabEnvSchema.parse(process.env);
    const project = env.CI_PROJECT_PATH ?? env.CI_PROJECT_ID;
    if (!project) {
      throw new Error(
        "GitLab mode needs CI_PROJECT_PATH or CI_PROJECT_ID to identify the project",
      );
    }
    // CI_API_V4_URL is "https://host/api/v4"; the forge wants the origin.
    const apiUrl = (env.CI_API_V4_URL ?? "https://gitlab.com/api/v4").replace(
      /\/api\/v4\/?$/,
      "",
    );
    return {
      ...sharedConfig(env, env.CI_PROJECT_DIR ?? process.cwd()),
      target: {
        kind: "gitlab",
        ref: { project, mrIid: env.CI_MERGE_REQUEST_IID },
        apiUrl,
      },
      token: env.GITLAB_TOKEN,
    };
  }

  const env = githubEnvSchema.parse(process.env);
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/") as [string, string];
  return {
    ...sharedConfig(env, env.GITHUB_WORKSPACE ?? process.cwd()),
    target: {
      kind: "github",
      ref: {
        owner,
        repo,
        pull_number: resolvePullNumber(
          env.LOUPE_PR_NUMBER,
          env.GITHUB_EVENT_PATH,
        ),
      },
    },
    token: env.GITHUB_TOKEN,
    eventName: env.GITHUB_EVENT_NAME,
    eventPath: env.GITHUB_EVENT_PATH,
  };
}

/** The forge-independent half of Config: .loupe.json defaults and the LOUPE_*
 * inputs, resolved against the CI checkout. */
function sharedConfig(
  env: z.infer<typeof loupeEnvSchema>,
  workdir: string,
): Omit<Config, "target" | "token" | "eventName" | "eventPath"> {
  // Config/prompt paths are relative to the checked-out repo, not the action's
  // own cwd (the composite action runs from its own directory).
  const inWorkspace = (p: string): string => resolve(workdir, p);

  const configPath = env.LOUPE_CONFIG
    ? inWorkspace(env.LOUPE_CONFIG)
    : undefined;
  // Top-level review defaults from .loupe.json. Precedence for the movable
  // settings: Action input (explicit) → file → loupe's built-in default.
  const file: LoupeSettings = configPath ? loadSettings(configPath) : {};

  return {
    harnessName: env.LOUPE_HARNESS ?? file.harness ?? "whip",
    workdir,
    conventionPaths: env.LOUPE_CONVENTION_PATHS.split(",")
      .map((p) => p.trim())
      .filter(Boolean),
    providers: buildProviders(env),
    subdir: env.LOUPE_DIR ?? file.dir,
    model: env.LOUPE_MODEL ?? file.model ?? "kimi-k3",
    reasoning: asReasoning(env.LOUPE_REASONING) ?? file.reasoning ?? "low",
    guidance: env.LOUPE_PROMPT_FILE
      ? readFileSync(inWorkspace(env.LOUPE_PROMPT_FILE), "utf8")
      : undefined,
    configPath,
    reviewerFilter: env.LOUPE_REVIEWER,
    profile: asProfile(env.LOUPE_PROFILE) ?? file.profile ?? "chill",
    verify: env.LOUPE_VERIFY,
    full: env.LOUPE_FULL,
    ensembleModels: env.LOUPE_ENSEMBLE.split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    skills: env.LOUPE_SKILLS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    timezone: env.LOUPE_TIMEZONE ?? file.timezone ?? "UTC",
    maxTurns: asMaxTurns(env.LOUPE_MAX_TURNS) ?? file.maxTurns,
    whipConfig: file.whip,
  };
}

function resolvePullNumber(
  explicit: number | undefined,
  eventPath: string | undefined,
): number {
  if (explicit) return explicit;
  if (eventPath) {
    const event: unknown = JSON.parse(readFileSync(eventPath, "utf8"));
    // pull_request events carry pull_request.number; issue_comment on a PR
    // carries issue.number; pull_request_review_comment carries pull_request.
    const parsed = z
      .object({
        pull_request: z.object({ number: z.number() }).optional(),
        issue: z.object({ number: z.number() }).optional(),
      })
      .safeParse(event);
    const n = parsed.success
      ? (parsed.data.pull_request?.number ?? parsed.data.issue?.number)
      : undefined;
    if (n) return n;
  }
  throw new Error(
    "Could not determine PR number: set LOUPE_PR_NUMBER or run on a pull_request/comment event",
  );
}

/** Build a provider chain from a comma-separated spec like "env,dotenv,infisical". */
export function resolveProviders(
  spec: string,
  infisical: { env?: string; projectId?: string } = {},
): readonly CredentialProvider[] {
  return spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((name) => {
      switch (name) {
        case "env":
          return envProvider();
        case "dotenv":
          return dotenvProvider();
        case "infisical":
          return infisicalProvider(infisical);
        default:
          throw new Error(`Unknown credential provider "${name}"`);
      }
    });
}

function buildProviders(
  env: z.infer<typeof loupeEnvSchema>,
): readonly CredentialProvider[] {
  return resolveProviders(env.LOUPE_CREDENTIAL_PROVIDERS, {
    env: env.LOUPE_INFISICAL_ENV,
    projectId: env.LOUPE_INFISICAL_PROJECT_ID,
  });
}
