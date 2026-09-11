# Knowledge map

The catalogue of everything an agent needs in this repo: every doc, spec,
example, and reviewer skill — what covers what, and **what mechanically
verifies it**. `scripts/verify-knowledge.ts` (run by `task
verify:knowledge`, `task check`, and CI) keeps this page honest:

- every doc, example, and ExecPlan must be indexed here;
- every relative link on this page must resolve;
- every catalogue row must carry a **Verified by** backstop and a
  **Last verified** date no older than 120 days.

If knowledge isn't checked into the repo, it doesn't exist — the repo is the
system of record. If a claim has no mechanical backstop, say so with
`none (prose)` rather than implying one.

Legend — **Verified by** values:

- `task check` — the code the doc describes compiles, lints, and passes
  tests.
- `verify-knowledge` — this page's own checks (links, coverage, freshness).
- a file path — that source/test file pins the behavior the doc documents.
- `none (prose)` — nothing mechanical; re-verify by reading before relying.

<!-- verifier: catalogue-start -->
| Doc | Audience | Covers | Verified by | Last verified |
| --- | --- | --- | --- | --- |
| [README.md](../README.md) | users · agents | pitch, quickstart, CLI flags, `.loupe.json` overview | verify-knowledge (links) · `task check` | 2026-09-01 |
| [AGENTS.md](../AGENTS.md) | agents | agent entry point: map, commands, conventions, golden principles | verify-knowledge (size, pointers) | 2026-09-01 |
| [docs/README.md](README.md) | all | doc index | verify-knowledge (coverage) | 2026-09-01 |
| [docs/guide.md](guide.md) | users | what loupe does, install, running a review, CLI flag table, logging | verify-knowledge (links) | 2026-09-01 |
| [docs/configuration.md](configuration.md) | users | `.loupe.json` reviewer fields, prompt layering, agentic mode, skills, signal-to-noise | zod schema in [packages/action/src/reviewers.ts](../packages/action/src/reviewers.ts) · DEBT-003 | 2026-09-01 |
| [docs/credentials.md](credentials.md) | users | provider chain, per-harness keys, CI secrets | [packages/credentials/src/index.ts](../packages/credentials/src/index.ts) | 2026-09-01 |
| [docs/github-action.md](github-action.md) | users | workflow wiring, `@loupe` chat commands, inputs and env vars | [action.yml](../action.yml) | 2026-09-01 |
| [docs/gitlab.md](gitlab.md) | users | GitLab/self-hosted setup: token, CI job, registry image, CLI refs, GitHub differences | [examples/gitlab-ci.yml](../examples/gitlab-ci.yml) · [packages/core/tests/gitlab.test.ts](../packages/core/tests/gitlab.test.ts) · [Dockerfile](../Dockerfile) · [.gitlab-ci.yml](../.gitlab-ci.yml) | 2026-09-11 |
| [docs/releases.md](releases.md) | users | version pinning (`@v0` vs tag vs SHA), release process | [.github/workflows/release.yml](../.github/workflows/release.yml) | 2026-09-01 |
| [docs/architecture.md](architecture.md) | maintainers | package layering, review pipeline, key files, extending, tests | `task check` · verify-knowledge (links) | 2026-09-01 |
| docs/knowledge-map.md | agents | this page | verify-knowledge | 2026-09-01 |
<!-- verifier: catalogue-end -->

## Examples, specs, and reviewer skills

loupe's reusable review "skills" are reviewer guidance prompts plus the
`SKILL.md` docs a consuming repo supplies (mechanism:
[configuration.md § Skills](configuration.md#skills)). This repo ships:

| Artifact | Kind | Covers |
| --- | --- | --- |
| [examples/reviewers/bugs.md](../examples/reviewers/bugs.md) | reviewer prompt (skill) | bug-hunting persona: logic, async, error handling, trust boundaries |
| [examples/reviewers/migrations.md](../examples/reviewers/migrations.md) | reviewer prompt (skill) | migration risk: backfills, locking, rolling-deploy compatibility |
| [examples/loupe-prompt.md](../examples/loupe-prompt.md) | example custom prompt | what a `--prompt-file` may and may not replace (persona only, never the JSON contract) |
| [examples/.loupe.json](../examples/.loupe.json) | config spec | full whip provider/model panel plus the bugs and migrations reviewer pair |
| [examples/gitlab-ci.yml](../examples/gitlab-ci.yml) | CI spec | GitLab CI job: merge-request rule, token, harness env |
| [examples/review.example.yml](../examples/review.example.yml) | workflow spec | CI variants: whip, claude, custom prompt, config-driven |

## Source of truth by package

| Package | Role | Key files | Tests |
| --- | --- | --- | --- |
| [@loupe/core](../packages/core/src/index.ts) | review engine: scope → fetch → prompt → run → parse → validate → post, forge-agnostic via `Forge` | `src/index.ts` (`runReview`), `diff.ts`, `prompt.ts`, `parse.ts`, `validate.ts`, `types.ts`, `forge.ts`, `github.ts`, `gitlab.ts`, `render.ts` | [tests/diff.test.ts](../packages/core/tests/diff.test.ts) — hunk parsing, off-diff rejection, JSON extraction, severity normalization · [tests/gitlab.test.ts](../packages/core/tests/gitlab.test.ts) — GitLab adapter: fetch, marker scan, pagination, positions, degrade |
| [@loupe/harness](../packages/harness/src/index.ts) | agent-CLI abstraction and adapters | `src/index.ts` — `registry`, `runCli`, `runWhipStreaming` | [tests/whip-config.test.ts](../packages/harness/tests/whip-config.test.ts) |
| [@loupe/action](../packages/action/src/main.ts) | CLI and GitHub Action / GitLab CI entry | `cli.ts`, `main.ts`, `config.ts` (forge auto-detect), `run.ts` (`wireBinding`), `reviewers.ts`, `respond.ts`, `orchestrate.ts` | none — [debt.md](plans/debt.md) DEBT-001 |
| [@loupe/credentials](../packages/credentials/src/index.ts) | provider chain: env → dotenv → infisical | `src/index.ts` | none — DEBT-002 |
| [@loupe/logger](../packages/logger/src/index.ts) | winston structured logging, opt-in OTLP | `src/index.ts` | none — DEBT-002 |

## ExecPlans

Plans for non-trivial work, versioned with the code. Convention:
[plans/README.md](plans/README.md). The verifier requires every plan file to
be indexed here.

**Active**

_none_

**Completed**

| Plan | What it did |
| --- | --- |
| [docs/plans/completed/0001-harness-engineering-playbook.md](plans/completed/0001-harness-engineering-playbook.md) | adopted the agent-legibility playbook: AGENTS.md, ExecPlans, this map, verifier + CI |
| [docs/plans/completed/0002-gitlab-support.md](plans/completed/0002-gitlab-support.md) | GitLab support: `Forge` interface, GitLab adapter, CI/CLI entries, docs; verified live on a self-hosted instance (MR review with inline positioned discussions) |

**Debt** — [plans/debt.md](plans/debt.md) (DEBT-001 action tests,
DEBT-002 credentials and logger tests, DEBT-003 config-doc drift).

## Keeping this page honest

- Add, remove, or rename a doc/example/plan → update this page in the same
  change (the verifier fails coverage otherwise).
- Rely on a doc → re-run its **Verified by** backstop and bump
  **Last verified**; the catalogue gate is 120 days.
- New doc claims should name a mechanical backstop, or say `none (prose)`.
