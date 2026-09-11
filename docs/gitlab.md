# GitLab (self-hosted or gitlab.com)

loupe reviews GitLab merge requests with the same engine as GitHub: the
same focused reviewers, conventions, incremental reviews, and inline
line-anchored comments. Two entry points:

- **GitLab CI** — a job that runs on merge-request pipelines (the equivalent
  of the GitHub Action). Copy [examples/gitlab-ci.yml](../examples/gitlab-ci.yml)
  into your `.gitlab-ci.yml`.
- **CLI** — `loupe review` against a MR URL or `group/project!N` shorthand.

## Token

A **project access token** (or personal access token) with the `api` scope,
passed as `GITLAB_TOKEN`:

- **CI**: add it as a masked, protected CI/CD variable named `GITLAB_TOKEN`.
- **CLI**: resolved in order `--token` → `GITLAB_TOKEN` → `glab auth token`
  (glab picks the right host from the MR URL or `GITLAB_HOST`).

`CI_JOB_TOKEN` can read the MR but cannot reliably create positioned
discussions on self-hosted versions — use a real token.

## CI job

The job clones loupe, installs, and runs the same entry as the GitHub
Action. loupe self-configures from GitLab's predefined variables
(`CI_PROJECT_PATH`, `CI_MERGE_REQUEST_IID`, `CI_API_V4_URL`, `CI_PROJECT_DIR`),
so a self-hosted instance needs no extra wiring — the job picks up its API
URL automatically.

```yaml
include:
  # or copy the job inline — see examples/gitlab-ci.yml
  remote: https://raw.githubusercontent.com/context-labs/loupe/main/examples/gitlab-ci.yml
```

The prebuilt image (below) ships the default harness `whip` plus bun and
git; if you build your own image or use a different harness, make sure its
CLI is on `PATH`. Harness keys come through the same
[credential chain](credentials.md) as on GitHub (`LOUPE_CREDENTIAL_PROVIDERS`,
default `env`) — e.g. a group-level `DEEPSEEK_API_KEY` CI variable plus a
`whip` provider block with `"apiKeyEnv": "DEEPSEEK_API_KEY"` in `.loupe.json`
runs reviews on the DeepSeek API platform.

Non-MR pipelines (branch/tag) are skipped cleanly — the job only needs the
`merge_request_event` rule.

### Prebuilt image

This repo also builds itself into a container image: `.gitlab-ci.yml` pushes
`$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA` and `:main` to the project's
container registry on every commit to the default branch (merge requests
build the image without pushing). Use it as the job image instead of cloning
loupe at review time:

```yaml
loupe-review:
  image: registry.example.com/admetrics/loupe:main # your $CI_REGISTRY_IMAGE
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - bun run /loupe/packages/action/src/main.ts
  variables:
    LOUPE_HARNESS: whip # + harness keys, or LOUPE_CONFIG: .loupe.json
```

The image bundles bun 1.3.14 and git and installs the workspace with
production dependencies; it needs a runner with Docker-in-Docker to build.

## CLI

```bash
# MR URL — any host, so self-hosted just works (the host drives the API base)
bun run packages/action/src/cli.ts review \
  https://gitlab.example.com/group/project/-/merge_requests/42 --dry-run

# shorthand against gitlab.com, or self-hosted with --api
bun run packages/action/src/cli.ts review group/project!42
bun run packages/action/src/cli.ts review group/project!42 --api https://gitlab.example.com
```

Everything else is forge-neutral: `.loupe.json` reviewers, `--dir`,
`--ensemble`, conventions, dry-run.

## Differences from GitHub

| Aspect | GitHub | GitLab |
|---|---|---|
| Review object | one review with inline comments | one note per finding (positioned discussions) + a summary note |
| Verdict | `REQUEST_CHANGES` / `COMMENT` review event | stated in the summary note body — GitLab has no "request changes" event, and loupe never approves |
| Re-review cleanup | prior review comments deleted | prior loupe notes (summary + inline) deleted, then reposted |
| Chat (`@loupe fix`) | via comment-event workflows | not available — GitLab CI has no comment-triggered pipelines (needs a webhook receiver; see the ExecPlan non-goals) |

Off-diff or stale anchors degrade exactly like on GitHub: a finding whose
position GitLab rejects (line moved between diff versions) is demoted into
the summary's "Other notes" section — it never fails the review.

## Version requirements

Any GitLab with merge-request pipelines and the MR notes/discussions v4 API
(15.x and up is the tested baseline; the job relies on `CI_API_V4_URL` and
`CI_MERGE_REQUEST_IID`, both longstanding). If your instance rejects a
positioned discussion, loupe logs a warning and falls back to the summary —
check the job log for `GitLab rejected an inline position`.
