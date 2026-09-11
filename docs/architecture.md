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

`runReview()` in `packages/core/src/index.ts` is the whole engine:

1. **Scope** — normalize `subdir`; prefix convention paths with it.
2. **Fetch** (parallel) — `forge.fetchPullContext` (PR/MR + changed files with
   patches) and `forge.fetchConventions` (repo docs at the head). Expected 404s
   (probing optional docs) are swallowed silently by the adapters.
3. **Filter** — keep files under `subdir` and matching `include`/`exclude`
   (`Bun.Glob`). No files in scope → return early (reviewer skipped).
4. **Prompt** — `agentic = req.agentic ?? true`. `buildSystemPrompt` layers
   guidance + reasoning note + tool directive (headless vs agentic) + output
   contract; `buildUserPrompt` is PR metadata + conventions + rendered diff.
5. **Run** — pick `harnessCwd` (subdir if it exists on disk, else workdir, else
   cwd; warn in agentic mode if absent). Call `harness.review(ctx)`.
6. **Parse** — `parseReviewOutput` extracts the last JSON object and validates
   each finding independently (one malformed finding is dropped, not fatal).
7. **Validate** — `validateFindings` splits findings into `inline` (their
   `path:line` is in the diff) and `dropped` (off-diff → summary notes). This is
   what prevents a hallucinated line from 422-ing the whole review.
8. **Post** — dry-run logs and returns; otherwise the forge deletes this
   reviewer's prior inline comments (author- and marker-guarded), posts the
   new inline findings, and creates or updates the reviewer's persistent
   summary. GitHub: an empty-body review (`REQUEST_CHANGES` on any blocker,
   else `COMMENT`) plus a summary issue comment updated in place; GitLab: one
   positioned discussion per finding plus a summary note updated in place
   (verdict stated in the body — no such event exists there).

### core files

- `types.ts` — `Finding` / severity Zod schema (with alias normalization) and
  the loose review-output schema.
- `diff.ts` — `commentableLines` parses hunk headers to the RIGHT-side line set
  the forges accept comments on; `renderDiff` formats the diff for the prompt.
- `prompt.ts` — default guidance, the three system-prompt layers, user prompt.
- `parse.ts` — brace-depth JSON extraction + per-finding `safeParse`.
- `validate.ts` — inline vs dropped split.
- `forge.ts` — the `Forge<R>` interface: everything the engine needs from a
  code host (fetch context/conventions, last-reviewed marker, compare, post).
- `github.ts` — GitHub adapter (Octokit): `makeGithubForge` plus the raw
  functions the GitHub-only chat path uses directly.
- `gitlab.ts` — GitLab adapter (v4 REST via plain fetch, base URL injected so
  self-hosted works and core stays env-free): `makeGitlabForge`.
- `render.ts` — forge-neutral review-body rendering + the dedup markers
  (`<!-- loupe:<name> sha=… -->`), shared by both adapters.

## Harness abstraction

`packages/harness/src/index.ts`:

- `Harness` = `{ name, credentialKeys, available(), review(ctx) }`.
- `HarnessContext` = `{ systemPrompt, userPrompt, model?, agentic?, workdir, env,
  logger }`.
- `review` runs the CLI to completion and returns its raw stdout (the review
  JSON); the core parses it. Adapters stay dumb.
- `runCli` (generic) pipes the prompt on stdin — used by `claude`
  (`--append-system-prompt`, `--model`) and `codex` (system prepended to stdin).
- `runWhipStreaming` runs `whip run --format json` and consumes the NDJSON event
  stream live: `reasoning`/`text` deltas become throttled `thinking` /
  `streaming reply` logs, `tool_start`/`tool_end` become `tool call` logs; it
  reassembles the assistant text from the stream. whip uses `-max-turns 40`
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
