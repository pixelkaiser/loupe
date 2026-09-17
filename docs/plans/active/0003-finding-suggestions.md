---
id: 0003
title: Add applyable suggestion blocks to findings
status: active
created: 2026-09-17
updated: 2026-09-17
owner: agent
---

# Add applyable suggestion blocks to findings

## Context

A side-by-side test against Greptile (admetrics/airflow2!1067) showed Greptile
quotes the actual changed code in its inline comments via applyable
suggestion blocks; loupe anchors findings to lines but never shows the
proposed replacement code. Findings already carry `path`/`line`/`body`; this
plan adds an optional `suggestion` field with the replacement code and renders
it as the forge-native suggestion block (GitHub review comments and GitLab
positioned discussions both render fenced suggestion blocks as one-click
apply).
Pipeline overview: [docs/architecture.md](../../architecture.md).

## Goals

- Findings may carry optional replacement code (`suggestion`, unfenced).
- Inline comments render it as an applyable suggestion block.
- Off-diff/demoted notes show it as a plain code fence (not applyable).
- The default guidance and output contract instruct the model when to emit it.

## Non-goals

- Multi-line-range anchored suggestions (loupe anchors single lines).
- Suggestions on PR-level concerns (no line to apply against).
- Any change to severity, verification, or dedup semantics.

## Plan

- [x] Add `suggestion` to `findingSchema` with fence-stripping normalize —
      verify: unit test in `packages/core/tests/diff.test.ts` (parse path)
- [x] Teach `DEFAULT_REVIEW_GUIDANCE` + `OUTPUT_CONTRACT` about suggestions —
      verify: `packages/core/tests/prompt.test.ts`
- [x] Shared `inlineFindingBody()` in `render.ts`; use it in `github.ts` and
      `gitlab.ts`; render suggestions in the summary "Other notes" list —
      verify: unit tests in `github.test.ts` / `gitlab.test.ts`
- [x] Show suggestions in the dry-run terminal rendering (`run.ts`) — verify:
      read the rendered output shape
- [x] Update docs + knowledge map — verify: `task check` (verify:knowledge)
- [x] `task check` green — verify: `task check`

## Decision log

| Date | Decision | Why / alternative rejected |
| --- | --- | --- |
| 2026-09-17 | Schema field + forge-native suggestion fence, not free-form quoting guidance | A structured field keeps bodies terse (the default guidance's "no restating the diff" stands) and lets render guarantee the fence; prompt-only quoting would be unreliable and untestable. |
| 2026-09-17 | Strip surrounding code fences in the schema normalize | Models wrap code in fences even when told not to; stripping there means every consumer (render, dry-run) gets bare code. |
| 2026-09-17 | Demoted/off-diff findings keep the suggestion as a plain fence | A suggestion fence outside a positioned note is inert; a plain block keeps the summary readable without implying it is applyable. |

## Verification

    task check    # expected: green, including verify:knowledge

## Progress log

- 2026-09-17 — opened; schema, prompts, render, both forges, tests, docs done.
