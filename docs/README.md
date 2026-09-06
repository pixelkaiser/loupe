# loupe docs

AI pull-request reviewer: inline, line-anchored comments with a
COMMENT / REQUEST_CHANGES verdict. Harness-agnostic, reviews against each repo's
own conventions, runs its focused reviewers agentically by default. Runs on
GitHub (Action or CLI) and GitLab (CI or CLI, self-hosted included).

## User docs

- [Guide](guide.md) — install, run a review locally, CLI flags, dry-run.
- [Configuration](configuration.md) — `.loupe.json` reviewer profiles, model,
  reasoning, agentic mode, custom prompts, conventions.
- [Credentials](credentials.md) — the provider chain and per-harness auth.
- [GitHub Action](github-action.md) — wire loupe into CI, inputs, secrets.
- [GitLab](gitlab.md) — self-hosted or gitlab.com: CI job, MR refs, token,
  differences from GitHub.
- [Releases & versioning](releases.md) — how to pin/select a version (`@v0` vs a
  pinned tag vs a SHA) and how maintainers cut a release.

## Maintainer docs

- [Architecture](architecture.md) — packages, the review pipeline, key files,
  how to extend (new harness, new credential provider).

## Agent operating docs

- [Knowledge map](knowledge-map.md) — every doc, spec, and reviewer skill,
  catalogued with verification status; mechanically kept complete and fresh.
- [ExecPlans](plans/README.md) — the plan convention for non-trivial work:
  [active](plans/active/) · [completed](plans/completed/) ·
  [tech debt](plans/debt.md).
- [AGENTS.md](../AGENTS.md) — the agent entry point (also enforced at review
  time, since loupe reads it as a convention doc).
