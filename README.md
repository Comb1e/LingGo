# LingGo

LingGo is a bilingual localhost Go workspace where either seat can be human-controlled or driven by an LLM. New games default to **19x19** and also support 9x9 and 13x13.

## Requirements

- Node.js 24 or newer
- pnpm 11

## Run locally

```bash
pnpm install
pnpm dev
```

Open <http://127.0.0.1:5173>. The API runs on `127.0.0.1:4173`, and Vite proxies `/api` during development.

For a production build:

```bash
pnpm build
pnpm start
```

Open <http://127.0.0.1:4173>. Game data is stored in `data/linggo.db`. Set `LINGGO_DB_PATH` to use another SQLite path.

## Providers

Settings separates reusable provider connections from player profiles. Connections support OpenAI, Anthropic, Google Gemini, and OpenAI-compatible endpoints. Every connection can override its base URL, so multiple proxies or self-hosted APIs can be saved as separate connections. Leave the base URL empty to use the official OpenAI, Anthropic, or Gemini endpoint; it is required for OpenAI-compatible connections.

Save any number of player profiles against those connections. The New Game page lists every saved LLM player for both seats, with the model ID emphasized and the profile name and connection underneath, so a profile can be selected directly for Black or White.

Games, provider connections, and player profiles can be edited or deleted from their list or detail views. Game editing is limited to player display names, commentary visibility, and the move cap so board rules and move history remain valid. Deleting a connection also deletes its profiles. LingGo blocks profile or connection deletion while an unfinished game still uses it, and keeps the built-in deterministic profile available as a fallback.

API keys are never persisted; enter one for the current server process or set the matching environment variable:

| Provider          | Environment variable           |
| ----------------- | ------------------------------ |
| OpenAI            | `OPENAI_API_KEY`               |
| Anthropic         | `ANTHROPIC_API_KEY`            |
| Google Gemini     | `GOOGLE_GENERATIVE_AI_API_KEY` |
| OpenAI-compatible | `OPENAI_COMPATIBLE_API_KEY`    |

The built-in deterministic local profile requires no credentials and is useful for smoke tests. OpenAI uses the AI SDK OpenAI provider's Responses API path. Compatible endpoints can declare structured-output support; otherwise LingGo requests strict JSON text and validates it with the same schema.

For a manual provider smoke test, create a connection, enter a session key, create a profile with an available model ID, then start a 9x9 human-vs-model game. Confirm that the model produces one legal move, its comment appears when enabled, and usage is added once. Repeat for each configured provider. Network/provider errors intentionally pause without paid retries.

## Rules and records

- Chinese area scoring, komi 7.5 by default
- No suicide and positional whole-board repetition prevention
- Two passes enter scoring; select a chain to toggle dead stones
- Human seats approve the score explicitly; two-model games need final operator confirmation
- Single-ply undo cancels pending generation and pauses autoplay
- UTF-8 SGF import reads the first game and main line; SGF export writes linear FF4

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

The Playwright suite runs deterministic, credential-free desktop and mobile flows.
