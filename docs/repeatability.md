# Review repeatability

Fresh model calls can discover different issues in identical code. Evidence
mode reduces variation in the material the reviewer sees before it chooses
its own tools. It does not guarantee identical findings or improve coverage
on every change.

## Evidence mode

Evidence collection is enabled by default for agentic reviews with a real
checkout, including GitLab CI, GitHub Actions, and the CLI. Repository tools
remain available. One-shot and fallback reviews remain diff-only.

Set `"evidence": false` on a reviewer in `.loupe.json` to opt out. The CLI
can override reviewer settings explicitly:

```sh
bun run packages/action/src/cli.ts review <MR-URL> \
  --workdir <checkout> --no-evidence --dry-run
```

Use `--evidence` to enable it explicitly, including when the reviewer config
sets it to false. The benchmark still sets each mode explicitly so its
baseline remains the former collection behavior.

Before calling the model, Loupe sorts files, collects changed-function or
hunk excerpts, finds up to four matching tracked test files by basename,
and follows two hops of referenced functions within those files. Referenced
constants are included too. Function boundaries are heuristic for named
function declarations (including PHP methods), not language-complete
parsing. Inspect missing contracts with tools; an absent excerpt is not
evidence that code or a caller does not exist.

Source files over 512 KB, binary files, and paths resolving outside the
checkout are skipped. Collection is bounded to about 48,000 source
characters, 10,000 per excerpt, and 180 lines per function; changed hunk
windows are also supplied so deep edits are preserved. Character-budget
truncation is reported; the function-length cap still applies. Caller searches
include PHP, exclude vendor/test directories, and sort before limiting results.

Diffs up to 24,000 characters are supplied inline. Larger diffs retain the
temporary diff file and its full contents, so their prompts still contain
a run-specific path. Evidence mode uses the current date in the configured
timezone rather than minute-level timestamps. The reviewer retains tools
for missing information. The `Prepared review evidence` log records source
and prompt hashes, not source text.

## Compare independent runs

The benchmark entry point uses a local fixture and a clean standalone clone at
the fixture's exact head SHA. It copies the checkout for every sample,
fixes the prompt date (not the operating-system clock), and alternates
baseline/evidence order between pairs. It uses live model calls with existing
harness credentials.

```sh
bun run packages/action/src/benchmark.ts \
  --fixture /absolute/path/fixture.json \
  --workdir /absolute/path/frozen-checkout \
  --output /absolute/path/new-results-directory --runs 3
```

The fixture is JSON with `repo`, `title`, `description`, `headSha`,
`reviewTime` (an ISO timestamp), and `files` (`path` and optional `patch`).
Optional `conventions` contains frozen repository guidance. Optional
`expected` contains a `path` and case-insensitive regular-expression
`pattern` used to count a known issue. This matcher is a screening aid;
inspect the findings manually before judging correctness.

The defaults are Whip, `deepseek-flash`, low reasoning, ten turns, three
samples per mode, and verification disabled to measure issue discovery.
Use `--model`, `--reasoning`, `--mode baseline|evidence|both`, or `--verify`
to change these. Keep settings equal between modes. No forge writes or
history calls are implemented, even if a caller accidentally disables
dry-run. Disposable checkout copies prevent source edits affecting the
fixture or later samples.

The output directory must not exist. It contains settings, frozen fixture
metadata, per-sample prompts and hashes, raw final replies, parsed findings,
timings, tool counts, and failures. These files contain repository source;
keep them private. The benchmark does not save reasoning text or API keys.
Prompt hashes reveal whether model inputs were actually identical; matching
hashes do not make model generation deterministic.

Verification only checks proposed findings. It cannot recover an issue a
discovery pass missed. Likewise, reusing a cached review guarantees the same
answer while preserving any omissions, so this experiment does not cache
answers. Evidence increases the initial prompt size; fewer tool calls alone
do not establish lower inference cost. Multi-pass discovery and voting are
separate experiments.

## Reference case

On 2026-10-20, the initial reviews of dsa-importer MRs !50 and !51 used
identical three-file patches and source trees (`2a992a6` and merge commit
`ef5a75a`), the same Loupe image, and `deepseek-flash`. Only !51 reported
that a fixed-date test eventually falls outside the 365-day retention
window. The local benchmark freezes the original `2a992a6` checkout and
the review clock at `2026-10-20T10:02:00Z`.

Measured results are recorded in the
[execution plan](plans/completed/0004-review-repeatability.md). This is one
known positive case, not a representative evaluation of review quality.

The initial trial kept the feature opt-in. On 2026-10-20 the user approved
activating it by default despite the inconclusive detection result. This
changes evidence collection, not the sampling parameters or review model.
