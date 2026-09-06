---
id: 0002
title: Add self-hosted GitLab support
status: active
created: 2026-09-01
updated: 2026-09-01
owner: agent
---

# Add self-hosted GitLab support

## Context

loupe is GitHub-only today: every forge API call lives in
[packages/core/src/github.ts](../../../packages/core/src/github.ts), the Action
entry layer speaks GitHub env vars and event payloads, and the CLI parses
GitHub PR URLs. A self-hosted GitLab instance wants the same reviews on merge
requests. Survey finding: the coupling is concentrated — diff parsing,
prompts, parse/validate, harness adapters, credentials, and `.loupe.json`
are all forge-neutral, so the port is an adapter + entry-layer change, not
an engine change. See [docs/knowledge-map.md](../../knowledge-map.md) for the
doc landscape this touches.

## Goals

- Review GitLab merge requests (incl. nested groups, self-hosted instances)
  with the same inline, line-anchored comments as GitHub.
- Two entry points: a GitLab CI job (merge_request_event pipelines) and the
  local CLI (`loupe review` against a GitLab MR URL or `group/project!N`).
- Incremental review, marker-based dedup, and conventions fetching work on
  GitLab exactly as on GitHub.
- GitHub behavior unchanged — the refactor to a `Forge` interface is
  mechanical.

## Non-goals

- `@loupe` chat commands / `fix` on GitLab (GitLab CI has no native
  comment-triggered pipelines; needs a webhook receiver — deferred).
- A published container image or GitLab CI `include:` component (the docs
  ship a copy-paste job that clones loupe; packaging is a later iteration).
- GitLab approvals integration (loupe never approves on either forge).

## Plan

- [x] ExecPlan opened and indexed in the knowledge map — verify:
  `bun run verify:knowledge`
- [x] Core: extract `Forge` interface (`forge.ts`) and forge-neutral
  rendering (`render.ts`); refactor `github.ts` behind
  `makeGithubForge`; `runReview` goes through the interface — verify:
  `bun run tsc && ./node_modules/.bin/vitest run packages/core` (existing
  tests green, unchanged)
- [x] Core: `gitlab.ts` adapter (v4 REST, plain fetch, injected for tests):
  fetch MR + changes, conventions at head, marker scan over notes, compare
  for the incremental delta, positioned discussions for inline findings with
  degrade-to-summary on a rejected position, delete-then-post with the same
  marker scheme — verify: new `packages/core/tests/gitlab.test.ts` green
- [x] Action layer: forge auto-detection in `config.ts` (`GITLAB_CI` →
  GitLab vars, `GITHUB_ACTIONS` → today's path), `main.ts` skips non-MR
  pipelines cleanly, `cli.ts` parses GitLab MR URLs + `group/project!N`
  with `glab auth token` fallback, chat paths guarded GitHub-only — verify:
  `bun run tsc` + manual `--dry-run` parse checks
- [x] `examples/gitlab-ci.yml` + `docs/gitlab.md` (setup, token scopes,
  version requirements, known differences); README/AGENTS/architecture/
  guide/configuration claims updated — verify: `bun run verify:knowledge`
- [x] Full gate — verify: `bun run check` green end to end

## Decision log

Append-only. Record the decision when made, with the why and the rejected
alternative — this is the part future readers (and agents) need most.

| Date | Decision | Why / alternative rejected |
| --- | --- | --- |
| 2026-09-01 | GitLab inline comments via per-finding `POST /discussions` with a text position, not one bulk review call | GitLab has no `pulls.createReview` analog; the MR `diff_refs` position payload is the only line-anchored mechanism. A rejected position degrades into the summary body (golden principle 3) instead of failing the run |
| 2026-09-01 | No REQUEST_CHANGES equivalent: verdict lives in the note body | GitLab has no "request changes" review event; spoofing one via approvals was rejected because loupe must never be an approver. The body carries an explicit verdict line |
| 2026-09-01 | Marker/dedup scheme (`<!-- loupe:<name> sha=… -->`) reused verbatim on GitLab notes | GitLab Markdown renders HTML comments (invisible) like GitHub, so delete-then-repost and incremental sha scan port unchanged |
| 2026-09-01 | Forge token is a project access token / PAT with `api` scope (`GITLAB_TOKEN`) | `CI_JOB_TOKEN` can read MRs but cannot reliably create positioned discussions across self-hosted versions; rejected as the primary credential, docs mention it |
| 2026-09-01 | API base URL passed in by the entry layer (from `CI_API_V4_URL` or the MR URL host), never read from env in core | Keeps golden principle 1 (core knows no env); self-hosted works by construction |

| 2026-09-01 | Config carries a `ForgeTarget` (kind + ref + apiUrl), not a live forge; `wireBinding` in run.ts builds the adapter | Forge factories need a logger, which config loading doesn't have; rejected a lazy/getter hack in Config as too clever |
| 2026-09-01 | GitLab summary notes are always deleted on re-review (GitHub keeps review history as review objects) | GitLab notes accumulate flat — without deletion, stale loupe summaries would pile up; inline notes still respect `refreshPaths` |

## Verification

How to prove this plan is done — commands and their expected results.

    bun run check    # expected: green, including verify:knowledge
    ./node_modules/.bin/vitest run packages/core   # gitlab adapter tests green

Manual, once a real instance is available: dry-run against a real MR
(`bun run packages/action/src/cli.ts review
https://<host>/group/project/-/merge_requests/<n> --dry-run`) and a
pre-flight `POST /discussions` position check on that instance.

## Progress log

Append-only, dated. One line per meaningful change of state is plenty.

- 2026-09-01 — opened.
- 2026-09-01 — core: `forge.ts` + `render.ts` extracted, `github.ts` behind
  `makeGithubForge`, `runReview` generic over the ref; existing tests green
  unchanged.
- 2026-09-01 — core: `gitlab.ts` adapter + `tests/gitlab.test.ts` (10 tests:
  fetch/pagination, marker scan, conventions, compare, postReview cleanup +
  positions + verdict, rejected-position degrade, auth header).
- 2026-09-01 — action: `config.ts` forge auto-detect + `ForgeTarget`,
  `run.ts` `wireBinding`/`reviewBound`, `cli.ts` GitLab refs + `glab`
  token chain + `--api`, `main.ts` non-MR skip, `respond.ts` GitHub-only
  guard. CLI parse smoke-tested for URL/shorthand both forges.
- 2026-09-01 — docs + example: `docs/gitlab.md`, `examples/gitlab-ci.yml`,
  README/AGENTS/architecture/guide/configuration/knowledge-map updated.
  `bun run check` green (90 tests, 0 lint/tsc/format errors, knowledge
  verified). Remaining: the real-instance manual verification above.
