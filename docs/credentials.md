# Credentials

loupe resolves the secrets a harness needs through an ordered **provider chain**;
the first provider to return a value for a key wins. Resolved values are injected
into the harness subprocess env.

## Providers

Set the chain with `--providers` (CLI) or `LOUPE_CREDENTIAL_PROVIDERS` (Action),
comma-separated:

| Provider | Reads from |
|---|---|
| `env` | `process.env` (default; works with plain CI secrets). |
| `dotenv` | a `.env` file (missing file is not an error). |
| `infisical` | the Infisical CLI (`infisical secrets get`), with `--infisical-env` / `--infisical-project`. |

Add your own by implementing `CredentialProvider` (`{ name, get(key) }`) from
`@loupe/credentials`.

## Per-harness auth

Each harness declares `credentialKeys` — the env vars it wants forwarded:

| Harness | Keys | Notes |
|---|---|---|
| `whip` | (none) | Reads the panel's `apiKeyEnv` from the inherited environment: `ADMETRICS_LLM_API_KEY` for Loupe's default Admetrics panel. Without a panel, Whip can use its local login (`~/.whip`). |
| `claude` | `ANTHROPIC_API_KEY` | Falls back to the local `claude` login if the key is absent. |
| `codex` | `OPENAI_API_KEY` | — |

Resolution is **best-effort**: loupe forwards whatever keys the chain can supply
and does not hard-fail on a missing one — a locally-logged-in harness self-auths,
and a genuinely missing key surfaces as the harness's own auth error (visible at
`LOG_LEVEL=debug`).

## In CI

The harness runs on the runner, so its key must reach the job env. Expose
`ADMETRICS_LLM_API_KEY` to use Loupe's default Whip panel, or the key named
by a custom panel's `apiKeyEnv`. Whip reads this key from the inherited job
environment. See [github-action.md](github-action.md).
