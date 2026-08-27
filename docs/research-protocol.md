# Research Protocol

LingGo's research layer studies whether inference-time adaptation improves Go decisions for frozen language models. It does not claim learning in the weight-update sense: adaptation is provided through prompt context, KataGo feedback, and an externalized technique notebook.

## Conditions

`no_adaptation` receives neither a notebook nor KataGo feedback. `reflection_only` updates a persistent notebook after training games. `katago_feedback` supplies turn-level KataGo root feedback without persistence. `reflection_plus_katago` combines both. Conditions are selected by the typed `condition` field in a manifest.

Training prompts and reflections are never included in final evaluation prompts. Final prompts contain exactly the benchmark rules, optional notebook, move instruction, JSON schema, and current position.

## Protocol and provenance

Every manifest records model/provider and prompt fingerprints, board size, komi, rules, move caps, training/evaluation counts, evaluator executable/network/config/visits, seed, condition, notebook digest, software version, and immutable protocol versions. Each run writes per-turn JSONL traces, notebook versions, KataGo records, a summary, and an error log below `data/experiments/<experiment-id>/<run-id>`.

Raw model responses are redacted by default. API keys and session credentials are never serialized. Set `liveProvider: true` explicitly for real provider calls; fake mode uses deterministic local adapters and KataGo.

## Metrics and analysis

Primary metrics are legal move rate, KataGo point loss, KataGo win-rate loss, game win rate, score margin, token cost, latency, and notebook size. Candidate agreement is included when candidate data is available. The UI's 0-100 aggregate remains a secondary metric. Point loss is the non-negative deterioration in the model-color perspective between evaluator roots before and after a move.

The analysis command reports per-condition means and medians, paired deltas against `no_adaptation`, deterministic bootstrap 95% intervals, seed-level matching, and missing-baseline diagnostics. Resampling uses the recorded seed. `summary.csv` is tidy and suitable for plotting.

## Reproducibility and limitations

Use `pnpm research:run -- --manifest experiments/smoke.json`, then `pnpm research:analyze -- --input data/experiments/smoke`, and `pnpm research:validate -- --input data/experiments/smoke/<run-id>`. Public position sets must include source identifiers, checksums, board size, komi, move history, side to move, and train/evaluation split. SGF data remains subject to its original license; provider terms govern model outputs and raw traces.

Threats include evaluator bias, finite visits, prompt-length/token effects, provider nondeterminism, opening leakage, and the limited ecological validity of synthetic or pass-heavy games. Production studies should pin evaluator assets, use held-out games and openings on 9x9 and 19x19 (with optional 13x13 transfer), and report all missing runs.
