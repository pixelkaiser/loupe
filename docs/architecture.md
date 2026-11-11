# Architecture (maintainers)

Bun monorepo, `workspace:*` packages. Tooling: oxlint (type-aware), oxfmt,
`typescript-7` (`tsc --build`), vitest. Run everything with `task check`.

## Packages

```
packages/
├─ credentials/  provider chain (env → dotenv → infisical → custom)
├─ harness/      the agent CLI abstraction + adapters (whip, claude, codex)
├─ logger/       winston structured logging + opt-in OTLP export
├─ core/         the review engine (no CLI/Action concerns)
└─ action/       CLI + GitHub Action / GitLab CI entry, config, profiles
```

Dependency direction: `action` → `core` → (`harness`, `logger`); `harness` →
`logger`; `credentials` and `logger` are leaves. `core` knows nothing about the
CLI, env vars, or `.loupe.json` — those live in `action`. `core` does know the
**forges** (GitHub, GitLab) through the `Forge` interface; everything
forge-shaped hangs off `forge.ts` adapters, and the entry layer picks which one.

## The review pipeline

`runReview()` in `packages/core/src/index.ts` runs one review end to end.
The multi-reviewer orchestrator calls `produceReview()` for every profile,
deduplicates the combined findings, then calls `publishReview()`.

1. **Scope and fetch** — normalize directories and read the PR/MR context and
   convention docs through `Forge`. Filter by each reviewer's include/exclude
   patterns; an empty scope preserves prior comments.
2. **Prepare context** — determine incremental focus, collect bounded source
   evidence by default, and retain the full in-scope diff for fallback and
   verification. Build the reviewer prompt and locate relevant callers.
3. **Run and parse** — run the harness, parse each finding independently, and
   normalize severities. Quota/rate-limit errors fail immediately; other agentic
   failures may fall back to one-shot review with the same repository context.
4. **Validate and verify** — anchor inline findings to the diff and apply the
   severity profile. Verify both inline findings and PR-wide concerns after
   ensemble merging. Verification can inspect the checkout when available.
5. **Deduplicate and cap** — remove duplicate findings across reviewers, then
   rank inline findings by severity. Overflow remains visible in the summary
   and contributes to the verdict.
6. **Publish** — check the current head and open state through the forge before
   writing. GitHub publishes reviews and summary comments; GitLab publishes
   positioned discussions and summary notes. Both preserve prior output when
   a run is skipped. A separate open-state check gates the combined summary.

### core files

- `types.ts` — `Finding` / severity Zod schema (with alias normalization) and
  the loose review-output schema. Findings may carry an optional `suggestion`
  (replacement code for the anchored line); the schema strips model-added code
  fences so every consumer gets bare code.
- `diff.ts` — `commentableLines` parses hunk headers to the RIGHT-side line set
  the forges accept comments on; `renderDiff` formats the diff for the prompt.
- `evidence.ts` — default bounded source excerpts, related helpers and tests;
  stable ordering before agentic exploration.
- `prompt.ts` — default guidance, the three system-prompt layers, user prompt.
- `parse.ts` — brace-depth JSON extraction + per-finding `safeParse`.
- `validate.ts` — inline vs dropped split.
- `forge.ts` — the `Forge<R>` interface: everything the engine needs from a
  code host (fetch context/conventions, last-reviewed marker, compare, post).
- `github.ts` — GitHub adapter (Octokit): `makeGithubForge` plus the raw
  functions the GitHub-only chat path uses directly.
- `gitlab.ts` — GitLab adapter (v4 REST via plain fetch, base URL injected so
  self-hosted works and core stays env-free): `makeGitlabForge`.
- `render.ts` — forge-neutral review-body rendering (including the inline
  comment body with its optional applyable suggestion block) + the dedup
  markers (`<!-- loupe:<name> sha=… -->`), shared by both adapters.

## Harness abstraction

`packages/harness/src/index.ts`:

- `Harness` = `{ name, credentialKeys, available(), review(ctx) }`.
- `HarnessContext` = `{ systemPrompt, userPrompt, model?, agentic?, workdir, env,
  logger }`.
- `review` runs the CLI to completion and returns its scrubbed stdout (the review
  JSON); the core parses it. Adapters stay dumb.
- `runCli` (generic) pipes the prompt on stdin — used by `claude`
  (`--append-system-prompt`, `--model`) and `codex` (system prepended to stdin).
- `runWhipStreaming` runs `whip run --format json` and consumes the NDJSON event
  stream live: `reasoning`/`text` deltas become throttled `thinking` /
  `streaming reply` logs, `tool_start`/`tool_end` become `tool call` logs; it
  reassembles the assistant text from the stream. whip uses `-max-turns 10`
  agentic / `10` one-shot as a safety cap, `-system`, and `-m <model>`.
- `registry()` maps name → harness; `getHarness(name)` throws with the known set.

## action files

- `config.ts` — the only place that reads `process.env`; parses with Zod,
  auto-detects the forge (`GITLAB_CI` → GitLab vars like `CI_API_V4_URL`,
  anything else → GitHub vars), and resolves `LOUPE_CONFIG`/`LOUPE_PROMPT_FILE`
  against the CI checkout.
- `run.ts` — `wireBinding` (target + token → live forge), `reviewPullRequest`:
  resolve harness, best-effort forward creds (never hard-fail on a missing
  key), call `runReview`. Plus `formatResult` / `renderReview`.
- `reviewers.ts` — loads/validates `.loupe.json` into resolved `Reviewer[]`
  (reads `promptFile` relative to the config).
- `cli.ts` — commander CLI (single-reviewer or `--config` loop); parses GitHub
  PR and GitLab MR refs (URL or shorthand) and picks the matching token chain.
- `benchmark.ts` — frozen local fixture, independent baseline/evidence model
  calls, saved findings and prompt hashes; forge writes are disabled.
- `main.ts` — Action/CI entry: same single/loop logic driven by env; skips
  GitLab non-MR pipelines cleanly.
- `respond.ts` / `orchestrate.ts` — `@loupe` chat commands (GitHub-only,
  guarded) and the shared review loop.

## Extending

- **New harness** — implement `Harness`, add it to `registry()`. Map
  `systemPrompt`/`userPrompt`/`model`/`agentic` onto its CLI; reuse `runCli` or
  write a streamer like whip's. Set `credentialKeys` to what it needs forwarded.
- **New credential provider** — implement `CredentialProvider`, add a case to
  `resolveProviders` in `action/src/config.ts`.
- **New forge** (code host) — implement `Forge<R>` in core (`gitlab.ts` is the
  reference for a non-Octokit one; reuse `render.ts` for the body + markers so
  dedup semantics stay identical), then teach `config.ts`/`cli.ts` to detect
  and parse its refs and add a branch to `wireBinding` in `run.ts`.
- **New reviewer** — edit `.loupe.json`. No code change.

## Tests

Vitest, beside the code (`packages/core/tests`). The load-bearing logic covered:
hunk→commentable-line parsing, off-diff finding rejection, JSON extraction,
empty-output error, severity normalization, and the GitLab adapter (fetch,
marker scan, pagination, positioned discussions, rejected-position degrade)
against a fake fetch. Run `task test` (or `task check`).
