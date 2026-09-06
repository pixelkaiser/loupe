---
id: 0001
title: Adopt the harness-engineering playbook for agent legibility
status: completed
created: 2026-09-01
updated: 2026-09-01
owner: PXLKSR
---

# Adopt the harness-engineering playbook for agent legibility

## Context

The maintainers want this repo to follow the playbook from OpenAI's "Harness
engineering" post (openai.com/index/harness-engineering): an agent-first repo
where knowledge is legible to agents and enforced by machinery, not by review
vigilance. loupe enforces other repos' conventions, but had no AGENTS.md, no
plan convention, no catalogue of its own knowledge — and no CI at all.
Everything this plan produced is indexed in
[docs/knowledge-map.md](../../knowledge-map.md).

## Goals

- An AGENTS.md entry point that is a table of contents, not an encyclopedia.
- A checked-in ExecPlan convention with progress and decision logs.
- A knowledge map over docs, specs, and skills with verification status.
- Mechanical enforcement of all three in `task check` and CI.

## Non-goals

- Rewriting user docs — they were already accurate.
- Changing any runtime behavior of loupe itself.

## Plan

- [x] Read the playbook post and audit the repo's existing knowledge —
      verify: Context above matches the audit.
- [x] Create AGENTS.md (map, commands, conventions, principles; ≤ 120 lines)
      — verify: `task verify:knowledge` line-budget and pointer checks.
- [x] Add the ExecPlan convention (docs/plans/: README, TEMPLATE, active/,
      completed/, debt.md) — verify: verifier plan-format checks.
- [x] Create docs/knowledge-map.md cataloguing docs, examples (reviewer
      skills), packages, and plans, with Verified-by and Last-verified —
      verify: verifier coverage and freshness checks.
- [x] Add scripts/verify-knowledge.ts with `fix:`-prefixed remediation
      messages, unit-test its pure helpers — verify: `task test`.
- [x] Wire verification into `task check`, `bun run check`, and a new CI
      workflow (.github/workflows/check.yml) — verify: `task check` green.

## Decision log

| Date | Decision | Why / alternative rejected |
| --- | --- | --- |
| 2026-09-01 | AGENTS.md is a ≤ 120-line table of contents with required pointers | Playbook: it is injected into every session, so it must stay a map; the budget is enforced by the verifier, not aspirational. Rejected: one long convention file — progressive disclosure beats a giant prompt. |
| 2026-09-01 | Plans live in docs/plans/ with active/ and completed/ plus a co-located debt.md ledger | Playbook: active plans, completed plans, and known debt are versioned next to the code. Rejected: tracking work only in issues — anything not in the repo doesn't exist for an agent. |
| 2026-09-01 | The knowledge map carries Verified-by and a Last-verified date (≤ 120 days), gated by verifier markers around the catalogue | Playbook: docs are catalogued with verification status and staleness is detected mechanically. Rejected: freshness by convention only — it rots silently. |
| 2026-09-01 | The verifier is a bun script whose errors print `fix:` lines, run in `task check` and CI | Playbook: custom linters inject remediation instructions into agent context. Rejected: extending oxlint — repo-shape checks don't belong in the JS linter. |
| 2026-09-01 | Added .github/workflows/check.yml (the repo previously had no CI) | Mechanical verification needs to run on every PR. Rejected: reusing the example review workflow — it would conflate loupe-the-product with loupe-the-repo. |

## Verification

    task check    # green: format, lint, tsc, test, verify:knowledge

CI runs the same on every push and PR via `.github/workflows/check.yml`.

## Progress log

- 2026-09-01 — opened; audited docs/, examples/, packages/, workflows.
- 2026-09-01 — wrote AGENTS.md, docs/plans/*, docs/knowledge-map.md,
  scripts/verify-knowledge.ts with tests, CI wiring, and doc pointers.
- 2026-09-01 — `task check` green; closed and moved to completed/.
