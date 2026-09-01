# Engineering Policy

`AGENTS.md` contains the contributor-facing rules. The machine-readable policy
is `config/engineering-policy.json`, and `pnpm policy:check` enforces it.

## Enforceable Definitions

- A complex workflow is persisted or restartable with at least three states,
  or supports retries, cancellation, pause/resume, concurrency, or delayed
  asynchronous completion.
- A heavily used constant is deployment-configurable, consumed by at least two
  production modules, or is a nontrivial numeric literal repeated in at least
  three production modules.
- Reusable functionality is equivalent behavior needed at two call sites or a
  production clone of at least eight lines and sixty tokens.
- Policy exclusions are only for false positives and require an owner, issue,
  rationale, and expiry within 90 days.

## Configuration Ownership

Cross-client defaults belong in `src/shared/constants.ts`. Runtime validation
and environment reads belong in `src/server/config.ts`.

| Environment key                            | Default           | Validation or purpose                  |
| ------------------------------------------ | ----------------- | -------------------------------------- |
| `PORT`                                     | `4173`            | TCP port from 1 through 65535          |
| `NODE_ENV`                                 | `development`     | `development`, `production`, or `test` |
| `LINGGO_SSE_KEEP_ALIVE_MS`                 | `15000`           | Positive milliseconds                  |
| `LINGGO_DEFAULT_KATAGO_VISITS`             | `5000`            | 25 through 100000                      |
| `LINGGO_DEFAULT_BENCHMARK_TRAINING_VISITS` | `10000`           | 25 through 100000                      |
| `LINGGO_PROVIDER_TIMEOUT_MS`               | 30 minutes        | Positive milliseconds                  |
| `LINGGO_PROVIDER_FIRST_TOKEN_TIMEOUT_MS`   | 1 minute          | Positive milliseconds                  |
| `LINGGO_PROVIDER_RETRY_LIMIT`              | `5`               | Positive attempts                      |
| `LINGGO_MODEL_REPAIR_RETRY_LIMIT`          | `3`               | Nonnegative retries                    |
| `LINGGO_PROXY_CONNECT_TIMEOUT_MS`          | `3000`            | Positive milliseconds                  |
| `LINGGO_NOTEBOOK_TOKEN_BUDGET`             | `2000`            | Positive tokens                        |
| `LINGGO_BENCHMARK_PROBLEM_ATTEMPTS`        | `5`               | Positive attempts                      |
| `LINGGO_FAKE_KATAGO`                       | `false`           | Boolean test mode                      |
| `LINGGO_DB_PATH`                           | `data/linggo.db`  | SQLite storage path                    |
| `LINGGO_TECHNIQUES_DIR`                    | `data/techniques` | Legacy notebook import path            |

KataGo path overrides, proxy variables, and provider API-key variables also
flow through the configuration module. Secrets are never included in runtime
configuration objects or logs.

## Git And GitHub

Install dependencies once to activate Husky. Pre-commit runs staged formatting,
lint, and policy checks; pre-push runs `pnpm verify:fast`. CI remains
authoritative because local hooks can be bypassed.

The desired `main` ruleset is `.github/rulesets/main.json`. Audit it with
`pnpm github:ruleset:audit`. Apply it with `pnpm github:ruleset:apply` using a
fine-grained `GH_TOKEN` with repository Administration write permission. The
ruleset has no bypass actors and requires pull requests, independent approval,
CODEOWNERS, current required checks, linear history, and resolved discussions.
