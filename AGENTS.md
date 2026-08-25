# Repository Guidelines

## Project Structure & Module Organization

LingGo is a single-package TypeScript application.

- `src/client/`: Preact UI, routes, pages, API client, components, and CSS.
- `src/server/`: Fastify API, SQLite store, Go rules, LLM providers, KataGo integration, notebooks, and benchmark orchestration.
- `src/server/migrations/`: ordered SQLite migrations.
- `src/shared/`: types and utilities used by both client and server.
- `e2e/`: Playwright browser flows; Vitest files are co-located as `*.test.ts`.
- `data/`: runtime databases and generated technique notebooks; never commit it.

## Build, Test, and Development Commands

Use Node.js 24+ and pnpm 11.

- `pnpm dev`: run Fastify with watch mode and Vite at `http://127.0.0.1:5173`.
- `pnpm build && pnpm start`: build and serve production on port 4173.
- `pnpm typecheck && pnpm lint`: validate types and ESLint rules.
- `pnpm test`: run all Vitest tests once.
- `pnpm exec vitest run src/server/go.test.ts`: run one test file.
- `pnpm test:e2e`: run desktop and mobile Playwright flows.

## Coding Style & Naming Conventions

Use two-space indentation and Prettier defaults: single quotes and no semicolons. Use `camelCase` for functions/variables and `PascalCase` for components/classes/types. Keep shared contracts in `src/shared/types.ts`; validate API input with Zod.

Model complex asynchronous workflows as explicit state machines with named statuses and phases. Keep persistence transitions atomic.

## Architecture and Behavioral Invariants

`src/server/go.ts` is authoritative for board replay, legality, captures, ko/repetition, and snapshot state. Validate moves against the replayed current board, not prompt history. Preserve capture totals and locations in LLM prompts and reflection records.

KataGo position analysis is stored separately from game JSON and must not increment game versions. Ordinary-game sharing is user-controlled; benchmark games derive sharing from `BenchmarkConfig.includeTrainingWinRates`. Benchmark prompts omit profile style text. Final prompts retain exactly five numbered sections and never include KataGo data. Repairable model output or illegal moves receive at most three attempts on the unchanged position.

## Testing Guidelines

Add co-located Vitest coverage. Use fake providers and `LINGGO_FAKE_KATAGO=1`; CI must not require credentials, KataGo, or a GPU. Cover user workflows with desktop and mobile Playwright tests. Run typecheck, lint, tests, build, and relevant E2E flows.

## Commit & Pull Request Guidelines

Use Git for all changes. Write short, imperative, lowercase subjects, such as `fix benchmark move retries`. Keep commits coherent.

Pull requests should explain behavior, verification, migrations/configuration impact, and linked issues. Include UI screenshots and note real-KataGo smoke tests. Never commit API keys, databases, generated notebooks, reports, or logs.
