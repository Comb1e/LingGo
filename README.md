# LingGo

LingGo is a bilingual localhost Go workspace where either seat can be human-controlled or driven by an LLM. New games default to **19x19** and also support 9x9 and 13x13.

## Requirements

- Node.js 24.14 or newer
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

Settings separates reusable provider connections from player profiles. Connections support OpenAI, Anthropic, Google Gemini, DeepSeek, and OpenAI-compatible endpoints. Every connection can override its base URL, so multiple proxies or self-hosted APIs can be saved as separate connections. Leave the base URL empty to use the official OpenAI, Anthropic, Gemini, or DeepSeek endpoint; it is required for OpenAI-compatible connections.

Save any number of player profiles against those connections. The New Game page lists every saved LLM player for both seats, with the model ID emphasized and the profile name and connection underneath, so a profile can be selected directly for Black or White.

Profiles can also define optional top-level provider request fields as name/content pairs. JSON objects, arrays, numbers, and booleans are parsed; other values are sent as text. For example, name `reasoning` with content `{"effort":"high"}` adds that effort to the final provider request. Custom objects merge with same-named provider objects; scalar and array values replace them. Use **Test profile** to make a minimal call with the unsaved form values before saving. The same fields are applied to ordinary moves and benchmark move/reflection requests.

Games, provider connections, and player profiles can be edited or deleted from their list or detail views. Game editing is limited to player display names, commentary visibility, and the move cap so board rules and move history remain valid. Deleting a connection also deletes its profiles. LingGo blocks profile or connection deletion while an unfinished game still uses it, and keeps the built-in deterministic profile available as a fallback.

## KataGo analysis

Every ordinary game page includes a smooth KataGo win-rate curve with exact per-turn values. New and imported games enable live root analysis by default. Existing games can backfill their full history from the chart. Settings stores editable executable, model, and analysis-config paths plus the ordinary-game visit count. The bundled defaults target the verified local installation:

```text
/home/comb1e/tools/KataGo/cpp/katago
/root/.local/share/pipx/venvs/katrain/lib/python3.12/site-packages/katrain/models/b10c384h6nbttflrs.bin.gz
/root/.local/share/pipx/venvs/katrain/lib/python3.12/site-packages/katrain/KataGo/analysis_config.cfg
```

Use **Test KataGo** to launch the engine and analyze a 9x9 position. Analysis failures do not interrupt ordinary play. Position analysis lives outside the optimistic-versioned game JSON, and is removed past the current turn after undo.

Enable **Share with LLM** per game to include the complete turn-aligned KataGo win-rate history in ordinary LLM prompts from the current model's perspective. The model waits for the current root analysis when sharing is enabled; if KataGo is unavailable, the move proceeds without analysis. Sharing is disabled by default and never changes benchmark prompt isolation.

## LLM benchmark

Benchmark trains one saved profile through ten sequential 19x19 games against KataGo, alternating colors, then scores one final game in the selected color. All games use Chinese area scoring, komi 7.5, a 722-move cap, and the configured 25–10,000 KataGo visits. Different player profiles can run benchmarks concurrently, but each profile may have only one queued, running, or paused benchmark so its technique notebook remains deterministic. LingGo does not impose a global concurrency or resource limit; operators are responsible for provider rate limits, KataGo capacity, GPU memory, and system load.

Training can expose turn-aligned win rates to the LLM. During each benchmark game, the model can maintain numbered in-game reflections, revise them by number, and receive the current list with every later move in that game. After each training game, those reflections are folded into the model's consolidated Markdown technique notebook, then cleared before the next game. The final prompt contains only rules, that notebook, the one-move instruction, JSON schema, and current position. Human style prompts and KataGo data are omitted. Current notebooks are stored under `data/techniques/`; each run keeps a downloadable snapshot.

The final 0–100 score equally weights game result and per-move quality derived from KataGo point loss. Set `LINGGO_FAKE_KATAGO=1` to use the deterministic pass-only engine for CI and browser tests; production uses the configured executable.

API keys are never written to SQLite. Keys entered in Settings are kept in the current browser tab's session storage and automatically restored to server memory after a development or production restart. Closing the tab ends that browser session. For persistence independent of a browser tab, set the matching environment variable:

| Provider          | Environment variable           |
| ----------------- | ------------------------------ |
| OpenAI            | `OPENAI_API_KEY`               |
| Anthropic         | `ANTHROPIC_API_KEY`            |
| Google Gemini     | `GOOGLE_GENERATIVE_AI_API_KEY` |
| DeepSeek          | `DEEPSEEK_API_KEY`             |
| OpenAI-compatible | `OPENAI_COMPATIBLE_API_KEY`    |

The built-in deterministic local profile requires no credentials and is useful for smoke tests. OpenAI uses the AI SDK OpenAI provider's Responses API path. DeepSeek uses a dedicated Chat Completions stream receiver that separately accumulates `reasoning_content` and final `content`, with thinking mode enabled by default. Every provider is asked for plain text containing one JSON object; LingGo parses and validates the text itself instead of passing provider-specific structured-output parameters.

Each model prompt contains the Go rules, the profile's optional style prompt, a single-move instruction, the exact `{"move":"D4","reason":"..."}` response schema, and the current board and move list. Moves use the letter-number coordinates printed on the board (columns skip I); `"pass"` means pass and `"resign"` means resign.

For a manual provider smoke test, create a connection, enter a session key, create a profile with an available model ID, then start a 9x9 human-vs-model game. Confirm that the model produces one legal move, its comment appears when enabled, and usage is added once. Repeat for each configured provider. Transient network/provider errors retry up to five attempts with exponential backoff. Repairable or illegal model output receives at most three repair retries after the initial response. The game page shows provider retry progress and the latest failure; after the provider retry limit or repair limit, processing pauses for operator recovery.

### WSL with Clash Verge

Windows system-proxy settings are not automatically inherited by processes running inside WSL. In Clash Verge, enable **Allow LAN** and note the HTTP or mixed proxy port.

When WSL uses mirrored networking, Windows services are available on localhost. This machine's Clash Verge Rev mixed port is `7897`, so start LingGo with:

```bash
LINGGO_PROXY_URL="http://127.0.0.1:7897" pnpm dev
```

Replace `7897` if Clash Verge shows a different port. Do not use LingGo's Vite port `5173` as the proxy port. For WSL NAT networking, use the Windows host address instead of `127.0.0.1`; select the normal WSL network route rather than a Clash/TUN route. LingGo checks `LINGGO_PROXY_URL` during startup and exits with a direct error if the proxy listener is unreachable.

`LINGGO_PROXY_URL` applies to both HTTP and HTTPS provider requests. LingGo also honors the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` variables. Keep `localhost,127.0.0.1` in `NO_PROXY` so local LingGo traffic stays direct.

## Rules and records

- Chinese area scoring, komi 7.5 by default
- No suicide and positional whole-board repetition prevention
- Two passes enter scoring; select a chain to toggle dead stones
- Human seats approve the score explicitly; two-model games need final operator confirmation
- Single-ply undo cancels pending generation and pauses autoplay
- UTF-8 SGF import reads the first game and main line; SGF export writes linear FF4

## Research experiments

The headless research layer is documented in [docs/research-protocol.md](docs/research-protocol.md). It supports four typed adaptation conditions, reproducible fake-provider runs, filesystem response caching, per-turn provenance traces, held-out position manifests, and deterministic statistical summaries. Run a credential-free smoke experiment with `pnpm research:run -- --manifest experiments/smoke.json`, then analyze and validate its generated artifact directory. This studies inference-time context and externalized memory; it does not claim model weight updates.

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
