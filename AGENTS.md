# Repository Guidelines

## Project Structure & Module Organization

LingGo is a TypeScript monorepo-style application managed as one pnpm package.

- `src/client/`: Preact UI, routes, API client, shared components, and CSS.
- `src/client/pages/`: page-level views such as games, settings, and benchmarks.
- `src/server/`: Fastify API, Go rules, provider adapters, KataGo integration, and benchmark orchestration.
- `src/server/migrations/`: ordered SQLite migrations (`001_initial.sql`, etc.).
- `src/shared/`: types and utilities used by both client and server.
- `e2e/`: Playwright browser flows. Unit tests are co-located as `*.test.ts`.
- `data/`: runtime databases and generated technique notebooks; never commit it.

## Build, Test, and Development Commands

Use Node.js 24+ and pnpm 11.

- `pnpm install`: install dependencies.
- `pnpm dev`: run Fastify with watch mode and Vite at `http://127.0.0.1:5173`.
- `pnpm build`: create the production client bundle.
- `pnpm start`: serve the production application on port 4173 by default.
- `pnpm typecheck`: run TypeScript validation without emitting files.
- `pnpm lint`: check ESLint rules.
- `pnpm format:check`: verify Prettier formatting.
- `pnpm test`: run all Vitest tests once.
- `pnpm test:e2e`: run desktop and mobile Playwright flows.

## Coding Style & Naming Conventions

Use two-space indentation and the repository's Prettier defaults (single quotes and no semicolons). Prefer named exports, `camelCase` functions/variables, `PascalCase` components/classes/types, and descriptive filenames. Keep shared contracts in `src/shared/types.ts`. Validate API inputs with Zod and use structured parsers instead of ad hoc string handling.

Model complex asynchronous workflows, such as benchmarks, as explicit state machines with named statuses and phases. Keep persistence transitions atomic and avoid coupling asynchronous analysis to optimistic game versions.

## Testing Guidelines

Add focused Vitest coverage beside changed server or shared modules using `name.test.ts`. Use deterministic fake providers and `LINGGO_FAKE_KATAGO=1`; CI must not require credentials, KataGo, or a GPU. Add Playwright coverage for user-facing workflows and verify both desktop and mobile layouts. Run typecheck, lint, unit tests, build, and relevant E2E tests before submission.

## Commit & Pull Request Guidelines

Use Git for all changes. Recent history uses short, imperative, lowercase subjects, for example `add analysis and benchmark user interface`. Keep commits scoped to coherent milestones.

Pull requests should explain behavior changes, verification performed, migration or configuration impact, and linked issues. Include screenshots for UI changes and note any optional real-KataGo smoke testing. Never include API keys, databases, generated notebooks, reports, or logs.
