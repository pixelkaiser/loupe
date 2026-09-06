# Known technical debt

Debt worth recording but not yet worth a plan. When a row graduates to work,
open an ExecPlan in [active/](active/) referencing its id and flip the row to
`paid` when that plan completes. Verified present (not accurate — accuracy is
on the row's author) by `scripts/verify-knowledge.ts` coverage checks.

| ID | Area | Debt | Impact | Next step | Status |
| --- | --- | --- | --- | --- | --- |
| DEBT-001 | tests | `@loupe/action` (config, reviewers, cli, respond, orchestrate) has no unit tests | config-parsing and chat-command regressions land untested | port core's vitest style to config env parsing + `@loupe` command routing | open |
| DEBT-002 | tests | `@loupe/credentials` and `@loupe/logger` have no tests | provider-chain ordering bugs surface only during real reviews | cover `resolveProviders` ordering and env/dotenv providers | open |
| DEBT-003 | docs | the reviewer-field table in `docs/configuration.md` is hand-maintained against the zod schema in `packages/action/src/reviewers.ts` | fields can drift from the schema when either changes | derive the table from the schema, or add a verifier check comparing them | open |
