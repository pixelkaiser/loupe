# AGENTS.md

loupe is a harness- and model-agnostic AI pull-request reviewer: focused
reviewer profiles run from the CLI, a GitHub Action, or GitLab CI
(self-hosted included) and post real reviews with inline, line-anchored
comments. This file is the **agent entry point** —
a map, not an encyclopedia. Follow a link only when the task needs the detail;
everything deep lives in `docs/` and is catalogued in the knowledge map.

## Start here

| Need | Read |
| --- | --- |
| Every doc, spec, and skill, with verification status | [docs/knowledge-map.md](docs/knowledge-map.md) |
| Doc index | [docs/README.md](docs/README.md) |
| Packages, review pipeline, how to extend | [docs/architecture.md](docs/architecture.md) |
| ExecPlan convention for non-trivial work | [docs/plans/README.md](docs/plans/README.md) |
| Known technical debt | [docs/plans/debt.md](docs/plans/debt.md) |
| Reviewer configuration (`.loupe.json`) | [docs/configuration.md](docs/configuration.md) |
| GitLab / self-hosted setup | [docs/gitlab.md](docs/gitlab.md) |

## Commands

```bash
bun install                    # first time
task check                     # format + lint + tsc + test + verify:knowledge
task fix                       # oxfmt --write + oxlint --fix
task verify:knowledge          # just the knowledge-base checks
./node_modules/.bin/vitest run packages/core   # one package's tests
```

`task check` is the definition of green — run it before declaring any task
done. It needs Bun 1.3.14 ([bun.sh](https://bun.sh)).

Dogfood: preview a review of a PR of this repo without posting
(`bun run packages/action/src/cli.ts review context-labs/loupe#<n> --dry-run`).
loupe's default convention paths include this file, so reviews of loupe
enforce it.

## Repo layout

```
packages/core          review engine: scope → fetch → prompt → run → parse →
                       validate → post via the Forge interface (github /
                       gitlab adapters); no CLI/env/.loupe.json knowledge
packages/harness       agent-CLI abstraction: whip / claude / codex adapters
packages/action        CLI + GitHub Action / GitLab CI entry: config, reviewer
                       profiles
packages/credentials   provider chain: env → dotenv → infisical → custom
packages/logger        winston structured logging + opt-in OTLP
docs/                  user + maintainer docs (indexed in the knowledge map)
docs/plans/            ExecPlans: active/ · completed/ · debt.md
examples/              sample .loupe.json + reviewer prompt skills + CI specs
scripts/               verify-knowledge.ts — the knowledge-base verifier
action.yml             composite GitHub Action
```

## Conventions

- **Plans** — non-trivial work gets an ExecPlan in `docs/plans/active/`
  (copy `TEMPLATE.md`, number sequentially). Keep its progress and decision
  logs current as you work; on completion move it to `completed/`. Small
  changes need no plan. See [docs/plans/README.md](docs/plans/README.md).
- **Knowledge map** — adding, removing, or meaningfully changing a doc?
  Update [docs/knowledge-map.md](docs/knowledge-map.md) in the same PR and
  bump its **Last verified** date.
- **Docs** — wrap at ~80 columns, link relatively, one source of truth per
  fact; no vendored copies.
- **Code** — strict `tsc`, oxlint `correctness: error`; `@loupe/core` stays
  free of CLI/env/config knowledge; harness adapters stay dumb (subprocess
  in, raw stdout out).
- **Commits** — conventional style (`feat:`, `fix:`, `docs:`, `chore:`).

## Mechanical verification

CI (`.github/workflows/ci.yml`) runs `task check` on every PR, which
includes `scripts/verify-knowledge.ts`. It fails the build on:

- `AGENTS.md` missing, over 120 lines, or missing its required pointers;
- any relative markdown link that doesn't resolve;
- a doc, example, or ExecPlan missing from the knowledge map;
- a catalogue entry without a fresh (≤ 120 days) **Last verified** date;
- an ExecPlan violating the format (naming, frontmatter, status vs
  location, required headings, unchecked steps in a completed plan).

Every violation prints a `fix:` line — apply it, don't improvise around it.

## Golden principles

1. `@loupe/core` knows nothing about env vars, the CLI, or `.loupe.json`.
2. Adapters are dumb: run the CLI, return stdout. Parsing is core's job.
3. A bad `path:line` degrades — snap it or demote to a summary note — it
   never 422s the whole review.
4. Local and CI are the same engine. "Works in CI only" is a bug.
5. If it isn't checked into the repo, it doesn't exist: plans, decisions,
   and debt live in `docs/plans/`.
6. Any doc claim a command can check, a command should check.

## Definition of done

- `task check` green (all of it).
- ExecPlan, if any, updated and moved; knowledge map row updated.
- New doc claims carry a mechanical backstop or say `none (prose)`.
