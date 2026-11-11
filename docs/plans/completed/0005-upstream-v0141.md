---
id: 0005
title: Integrate upstream v0.14.1 into the GitLab-capable fork
status: completed
created: 2026-11-11
updated: 2026-11-11
owner: agent
---

# Integrate upstream v0.14.1 into the GitLab-capable fork

## Context

GitLab main includes the fallback-context fix from MR !5. The GitHub fork
must first receive that baseline, then integrate upstream v0.14.1. The
[knowledge map](../../knowledge-map.md) links the architecture, GitLab setup,
and repeatability contracts that this integration must preserve.

## Goals

- Integrate upstream security, reliability, and review-quality changes.
- Preserve the forge abstraction, Admetrics provider, source evidence, and
  verification of both inline findings and PR-wide concerns.
- Expose freshness checks and shared rendering fixes to both forges.

## Non-goals

- Deploy or merge the integration into GitLab main.
- Adopt the unmerged Whip SDK migration or change the default review model.

## Plan

- [x] Synchronize the GitHub fork baseline; verify remote heads and ancestry.
- [x] Resolve upstream integration; verify with TypeScript and focused tests.
- [x] Add regression coverage for GitLab freshness and security adaptation.
- [x] Run `task check` with Bun 1.3.14 and inspect the final diff.
- [x] Publish the integration branch and GitHub PR for review.

## Decision log

| Date | Decision | Why / alternative rejected |
| --- | --- | --- |
| 2026-11-11 | Integrate from GitLab main `bac561e` and upstream `5083770`. | Includes the merged fallback fix while retaining upstream ancestry. |
| 2026-11-11 | Keep forge operations generic. | Upstream's GitHub-specific publishing must also work for GitLab. |
| 2026-11-11 | Copy unpublished GitLab commits with the approved GitHub noreply email. | GitHub rejected the original push with GH007; preserve GitLab history and all copied file trees. |

## Verification

- `task check` with Bun 1.3.14: format, lint, TypeScript, tests, knowledge map.
- `git diff --check` and both remote ancestry checks.
- Focused tests for shared markers, GitLab freshness, provider guards,
  evidence/fallback context, and multi-reviewer orchestration.

## Progress log

- 2026-11-11 — Verified MR !5 merged and started the upstream integration in
  a separate worktree. Baseline publication is awaiting the privacy choice.

- 2026-11-11 — Published the approved noreply copy of GitLab main as
  `2d7b75f`; its tree equals GitLab `bac561e`.
- 2026-11-11 — Resolved upstream conflicts, preserved source evidence and
  concern verification, and added GitLab freshness/provider regression tests.
- 2026-11-11 — `task check` passes with Bun 1.3.14: formatting, lint,
  TypeScript, 391 source test cases plus their compiled copies, and the
  knowledge verifier. The linux/amd64 container build also passed.

- 2026-11-11 — Published the integration in GitHub PR #1. GitHub CI and
  advisory self-review run against its pushed head. GitLab remains unchanged.
