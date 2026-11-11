import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { runReview, type Forge } from "@loupe/core";
import { getHarness, envSecretValues, redactSecrets } from "@loupe/harness";
import type { HarnessContext } from "@loupe/harness";
import type { Logger } from "@loupe/logger";
import { z } from "zod";

import { builtinWhipPanel, DEFAULT_MODEL } from "./config";

const fixtureSchema = z.object({
  repo: z.string(),
  title: z.string(),
  description: z.string(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  reviewTime: z.string().datetime(),
  files: z.array(z.object({ path: z.string(), patch: z.string().optional() })),
  conventions: z.string().default(""),
  expected: z.object({ path: z.string(), pattern: z.string() }).optional(),
});

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    workdir: { type: "string" },
    output: { type: "string" },
    runs: { type: "string", default: "3" },
    mode: { type: "string", default: "both" },
    model: { type: "string", default: DEFAULT_MODEL },
    reasoning: { type: "string", default: "low" },
    verify: { type: "boolean", default: false },
  },
  strict: true,
});
if (!values.fixture || !values.workdir || !values.output) {
  throw new Error(
    "Required: --fixture <json> --workdir <frozen-checkout> --output <new-directory>",
  );
}
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 20)
  throw new Error("--runs must be 1..20");
const reasoning = z.enum(["low", "medium", "high"]).parse(values.reasoning);
const mode = z.enum(["both", "baseline", "evidence"]).parse(values.mode);
const fixture = fixtureSchema.parse(
  JSON.parse(readFileSync(values.fixture, "utf8")),
);
const workdir = resolve(values.workdir);
const output = resolve(values.output);
const git = (...args: string[]) => {
  const result = spawnSync("git", ["-C", workdir, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error("Frozen fixture requires a Git checkout: " + result.stderr);
  return result.stdout.trim();
};
if (
  git("rev-parse", "HEAD") !== fixture.headSha ||
  git("status", "--porcelain")
) {
  throw new Error("Fixture checkout must be clean and match headSha");
}
if (!lstatSync(join(workdir, ".git")).isDirectory()) {
  throw new Error(
    "Use a standalone clone: copying a linked worktree would share its Git metadata",
  );
}
// A new directory prevents silently overwriting previous experiment evidence.
mkdirSync(output);
writeFileSync(join(output, "fixture.json"), JSON.stringify(fixture, null, 2), {
  mode: 0o600,
});
const secrets = envSecretValues(process.env);
const save = (name: string, value: unknown) =>
  writeFileSync(
    join(output, name),
    redactSecrets(JSON.stringify(value, null, 2), secrets),
    { mode: 0o600 },
  );
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => logger,
};
const forbidden = async (): Promise<never> => {
  throw new Error(
    "Benchmark attempted a forge operation; all forge writes/history access are forbidden",
  );
};
const forge: Forge<null> = {
  checkPublishable: forbidden,
  checkOpen: forbidden,
  name: "frozen-fixture",
  describeRef: () => fixture.repo,
  repoRef: () => fixture.repo,
  fetchPullContext: async () => ({
    ...fixture,
    files: fixture.files.map(({ path, patch }) => ({ path, patch })),
    headPaths: new Set(fixture.files.map((f) => f.path)),
  }),
  fetchConventions: async () => ({ text: fixture.conventions, found: [] }),
  getLastReviewed: forbidden,
  changedFilesBetween: forbidden,
  cleanupStrandedThreads: forbidden,
  postIssueComment: forbidden,
  upsertCombinedSummary: forbidden,
  postReview: forbidden,
};
const harness = getHarness("whip");
if (!(await harness.available()))
  throw new Error("Install the pinned Whip CLI on PATH before benchmarking");
const version = spawnSync("whip", ["--version"], {
  encoding: "utf8",
}).stdout.trim();
const sourcePaths = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    encoding: "utf8",
  },
)
  .stdout.split("\0")
  .filter((path) => /\.(?:ts|json)$|^bun\.lock$/.test(path))
  .sort();
const sourceHash = createHash("sha256");
for (const path of sourcePaths)
  sourceHash.update(path + "\0").update(readFileSync(path));
const settings = {
  bunVersion: Bun.version,
  loupeSourceHash: sourceHash.digest("hex"),
  model: values.model,
  reasoning,
  verify: values.verify,
  maxTurns: 10,
  harnessVersion: version,
  loupeRevision: spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim(),
  loupeDiffHash: hash(
    spawnSync("git", ["diff", "HEAD"], { encoding: "utf8" }).stdout,
  ),
};
save("settings.json", settings);
const records: {
  mode: string;
  run: number;
  milliseconds: number;
  primaryPromptHash?: string;
  expectedFound?: boolean;
  toolCalls: number;
  error?: string;
}[] = [];
const expected = fixture.expected && new RegExp(fixture.expected.pattern, "i");

for (let run = 1; run <= runs; run++) {
  const modes =
    mode === "both"
      ? run % 2
        ? ["baseline", "evidence"]
        : ["evidence", "baseline"]
      : [mode];
  for (const current of modes) {
    const sample = current + "-" + run;
    console.log("Starting " + sample);
    const temporary = mkdtempSync(join(tmpdir(), "loupe-benchmark-"));
    const checkout = join(temporary, "checkout");
    // Each sample gets the same source and Git history; tools cannot modify
    // the original fixture or contaminate the next sample's source.
    cpSync(workdir, checkout, { recursive: true });
    const contexts: {
      systemPrompt: string;
      userPrompt: string;
      phase?: string;
      promptHash: string;
    }[] = [];
    const replies: { phase?: string; text: string }[] = [];
    let toolCalls = 0;
    const started = Date.now();
    try {
      const result = await runReview({
        forge,
        ref: null,
        harness: {
          ...harness,
          async review(context: HarnessContext) {
            contexts.push({
              systemPrompt: context.systemPrompt,
              userPrompt: context.userPrompt,
              phase: context.phase,
              promptHash: hash(
                context.systemPrompt + "\0" + context.userPrompt,
              ),
            });
            const text = await harness.review(context);
            replies.push({ phase: context.phase, text });
            return text;
          },
        },
        workdir: checkout,
        harnessEnv: {},
        whipConfig: builtinWhipPanel(values.model),
        conventionPaths: [],
        model: values.model,
        reasoning,
        maxTurns: settings.maxTurns,
        agentic: true,
        evidence: current === "evidence",
        now: new Date(fixture.reviewTime),
        full: true,
        dryRun: true,
        verify: values.verify,
        trace: (event) => {
          if (event.type === "tool_start") toolCalls++;
        },
        logger,
      });
      const found = [...result.inline, ...result.dropped].some(
        (finding) =>
          finding.path === fixture.expected?.path &&
          expected?.test(finding.body),
      );
      records.push({
        mode: current,
        run,
        milliseconds: Date.now() - started,
        primaryPromptHash: contexts[0]?.promptHash,
        expectedFound: expected ? found : undefined,
        toolCalls,
      });
      save(sample + ".json", { ...records.at(-1), result, contexts, replies });
      console.log(
        sample +
          ": " +
          result.inlineCount +
          " inline, expected=" +
          (expected ? found : "unset") +
          ", tools=" +
          toolCalls,
      );
    } catch (error) {
      records.push({
        mode: current,
        run,
        milliseconds: Date.now() - started,
        primaryPromptHash: contexts[0]?.promptHash,
        toolCalls,
        error: error instanceof Error ? error.message : String(error),
      });
      save(sample + ".json", { ...records.at(-1), contexts, replies });
      console.log(sample + ": failed; see saved sample");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    save("results.json", { settings, records });
  }
}
console.log(JSON.stringify(records, null, 2));
if (records.some((record) => record.error)) process.exitCode = 1;
