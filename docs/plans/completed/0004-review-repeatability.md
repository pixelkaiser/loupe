---
id: 0004
title: Measure reviews with consistent source evidence
status: completed
created: 2026-10-20
updated: 2026-10-20
owner: agent
---

# Measure reviews with consistent source evidence

## Context

The original dsa-importer MRs !50 and !51 had identical patches and source
trees. The same Loupe image/model missed a fixed-date test issue in one run
and found it in the other. See the [knowledge map](../../knowledge-map.md)
for the engine, prompt, caller discovery, and configuration contracts.

## Goals

- Add an opt-in evidence mode that supplies stable, bounded source excerpts,
  related helpers, callers, and tests before model-directed exploration.
- Compare independent baseline/evidence reviews against a frozen checkout.
- Preserve raw findings, prompt hashes, and failures for inspection; never
  post benchmark results to a forge.

## Non-goals

- Guaranteed deterministic generation, cached review reuse, model changes,
  production rollout, or automatic majority voting.
- Language-complete parsing or claims that bounded evidence is exhaustive.

## Plan

- [x] Implement bounded evidence collection and PHP caller support — verify:
  `./node_modules/.bin/vitest run packages/core`.
- [x] Wire opt-in reviewer/CLI settings and document their limits — verify:
  `./node_modules/.bin/vitest run packages/action`.
- [x] Add a read-only frozen-fixture benchmark and compare repeated runs —
  verify: inspect saved per-run findings and prompt hashes.
- [x] Run `task check` (or its exact tasks when the task runner is absent),
  record measured results, and complete this plan.

## Decision log

| Date | Decision | Why / alternative rejected |
| --- | --- | --- |
| 2026-10-20 | Keep evidence collection opt-in while measuring. | Avoid making an unmeasured default change to all reviews. |
| 2026-10-20 | Keep repository tools available after supplying evidence. | Diff-only review could hide the retention helper that motivated this work. |
| 2026-10-20 | Compare discovery separately from verification. | Verification cannot discover a finding the primary pass missed. |

## Verification

    task check

When `task` is absent, run the commands in Taskfile.yml individually with
Bun 1.3.14. The live benchmark must use the original revision, identical
model/effort/budgets, separate independent calls, and no forge writes.

## Progress log

- 2026-10-20 — Opened; confirmed clean Loupe checkout at 85bf114. Local
  `task` and `whip` are absent; installed Bun is 1.3.6. Preparing isolated
  pinned runtimes and the original dsa-importer source archive.

- 2026-10-20 — Evidence collection, small-diff inlining, date-only prompts,
  PHP caller lookup, reviewer config, and CLI flag implemented. Regression
  tests cover helper/test collection, long functions, bounded output, path
  containment, stable prompts, and no forge writes.
- 2026-10-20 — First pilot missed the known issue in one baseline and two
  evidence runs. Inspection found PHP test-double methods producing unrelated
  production callers. Excluded those methods, stopped the pilot, and started
  a fresh three-pair comparison.
- 2026-10-20 — `bunx bun@1.3.14 run check` failed because its `bun test`
  invokes Bun's native runner (Vitest environment helpers are unavailable).
  The Taskfile commands use Vitest correctly; running those individually
  passes format, lint, TypeScript, tests, and knowledge verification.

## Outcomes

The opt-in mode and read-only benchmark are implemented. The mode supplies
stable source evidence while retaining repository tools. No production
configuration, CI image, MR comment, or default evidence setting changed.

Final trial: original dsa-importer head
`2a992a6c179c6d2de1d96ca2654e90586b234ebb`, fixed prompt clock
`2026-10-20T10:02:00Z`, Whip v0.6.5 on macOS arm64, Bun 1.3.14,
`deepseek-flash`, low reasoning, ten turns, verification off. Independent
fresh calls; no response cache. All six completed agentically with no
malformed findings, fallback, dropped findings, or errors. Manual inspection
of the parsed findings and raw final replies confirms all six reported no
issues, including no PR-level concern about the retention window.

| Mode | Known issue detected | Tool calls | Seconds | Unique primary prompts |
| --- | --- | --- | --- | --- |
| baseline | 0/3 | 20, 10, 19 | 71.7, 287.4, 60.0 | 3 |
| evidence | 0/3 | 5, 11, 20 | 26.7, 83.6, 69.9 | 1 |

Evidence primary prompt SHA-256:
`64964bda3f76692c7b174ce8c7d14391c1e7ef81a2e36c52188356b4e6dec79a`.
A capture-only pass using the final code reproduced that exact hash. Later
TypeScript test-basename normalization and standalone-clone validation did
not change this fixture's primary prompt. Source fingerprint at trial start:
`98fe408047295f16a779156a36badebfb8f4912d5fe49f9b7b715d866f2df722`.

Raw fixtures, settings, prompts, replies, and per-run results are local at
`/tmp/loupe-repeatability-final-20261020/`. The interrupted preliminary pilot
is separate at `/tmp/loupe-repeatability-20261020/` and is excluded from the
final comparison.

The evidence mode stabilized inputs, with median tool calls 11 versus 19.
Median elapsed time was 69.9 versus 71.7 seconds. It did not improve detection
of the known issue (0/3 in both modes). Identical initial prompts still led
to different tool counts and prose. Keep the mode opt-in; this trial does
not support promoting it as a review-quality improvement. It is one known
positive case, and three trials per mode cannot establish a general recall,
precision, cost, or reliability effect. The model id is an alias, and the
local tool environment differs from CI. Prompt time is fixed; tools still
observe the real OS clock.

### Commands and acceptance results

    PATH=/tmp/loupe-benchmark-bin:$PATH bunx bun@1.3.14 packages/action/src/benchmark.ts \
      --fixture /tmp/loupe-dsa-fixture.json \
      --workdir /tmp/loupe-dsa-benchmark-checkout \
      --output /tmp/loupe-repeatability-final-20261020 --runs 3

The provider key was supplied in the subprocess environment from the
existing provider configuration and was never written to disk.
The result directory was new at execution time; choose a new path to rerun.

Taskfile-equivalent checks passed because the `task` executable is absent:

    ./node_modules/.bin/oxfmt --check '**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}'
    ./node_modules/.bin/oxlint --type-aware
    ./node_modules/typescript-7/bin/tsc --build
    ./node_modules/.bin/vitest run
    bunx bun@1.3.14 scripts/verify-knowledge.ts
    git diff --check

The CLI help includes `--evidence`; config validation preserves the default
unset state and rejects non-boolean values. Integration tests confirm
small-diff prompts match across distinct checkout paths and minute values,
large diffs remain accessible, and dry-run makes no forge writes.

- 2026-10-20 — Completed six final samples, manually inspected raw replies,
  reproduced the evidence prompt hash with final code, and passed all
  Taskfile-equivalent checks. Kept evidence mode opt-in and undeployed.

## Activation follow-up

On 2026-10-20 the user explicitly requested activating evidence mode. The
follow-up makes source evidence the default for agentic reviews with a real
checkout. Reviewers may set `evidence: false`, and the CLI accepts
`--no-evidence` as an explicit override. One-shot reviews and the benchmark
baseline retain their prior behavior. The initial trial results above are
unchanged; activation is a user decision, not a new claim of improved recall.

Release path: push the tested feature branch, merge its GitLab MR, and wait
for the default-branch `docker:image` job to publish the new `:main` image.
Existing consumers of that image inherit the default on future review jobs.
