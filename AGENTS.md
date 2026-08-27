# Repository Guidelines

## Project Structure & Module Organization

- `src/client/`: Preact pages, components, API client, localization, and CSS.
- `src/server/`: Fastify API, SQLite, Go rules, LLM/KataGo integrations, notebooks, and benchmarks.
- `src/server/migrations/`: ordered SQLite migrations.
- `src/shared/`: contracts and utilities shared by client and server.
- `e2e/`: Playwright browser flows. Vitest tests are co-located as `*.test.ts`.
- `data/`: runtime databases and generated technique notebooks; never commit it.

## Build, Test, and Development Commands

Use Node.js 24.14+ and pnpm 11.

- `pnpm dev`: run the watched server and Vite at `http://127.0.0.1:5173`.
- `pnpm build && pnpm start`: build and serve on port 4173.
- `pnpm typecheck && pnpm lint`: check TypeScript and ESLint rules.
- `pnpm format:check`: verify Prettier formatting.
- `pnpm test`: run all Vitest tests once.
- `pnpm exec vitest run src/server/go.test.ts`: run one test file.
- `pnpm test:e2e`: run desktop and mobile Playwright flows.

## Coding Style & Naming Conventions

Use two-space indentation, single quotes, and no semicolons. Use `camelCase` for functions/variables and `PascalCase` for components/classes/types. Keep shared contracts in `src/shared/types.ts`; validate API input with Zod.

Model complex asynchronous workflows as explicit state machines with named statuses and phases. Keep persistence transitions atomic.

## Architecture and Behavioral Invariants

`src/server/go.ts` is authoritative for board replay, legality, captures, ko/repetition, and snapshot state. Validate moves against the replayed current board, not prompt history. Preserve capture totals and locations in LLM prompts and reflection records.

Store KataGo analysis separately from game JSON without incrementing game versions. Benchmarks derive sharing from `BenchmarkConfig.includeTrainingWinRates`; ordinary-game sharing remains user-controlled. Benchmark prompts omit profile style text. Final prompts keep exactly five numbered sections and exclude KataGo data. Retry repairable or illegal output at most three times on the unchanged position.

## Testing Guidelines

Add co-located Vitest coverage for changed behavior. Use fake providers and `LINGGO_FAKE_KATAGO=1`; CI must not require credentials, KataGo, or a GPU. Cover workflows with desktop and mobile Playwright tests. Before a PR, run typecheck, lint, tests, build, and relevant E2E flows.

## Commit & Pull Request Guidelines

Use Git for all changes. Follow repository history with short, imperative, lowercase subjects, such as `fix benchmark move retries`. Keep commits coherent.

Pull requests should explain behavior, verification, migrations/configuration impact, and linked issues. Include UI screenshots and note real-KataGo smoke tests. Never commit API keys, databases, generated notebooks, reports, or logs.
