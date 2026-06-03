# Market Filter Pipeline
Pelagos exposes a five-stage filter that runs every Polymarket market through an NLP + heuristic gauntlet before a basket can include it. The goal is to reject low-quality markets - jokes, illiquid shells, near-duplicates, questions resolving too soon or too far out - before they ever touch the correlation model, the weight optimiser, or the Sui execution path.
This is inspired by the Laytus Protocol AI risk layer but re-implemented from scratch in TypeScript. No Python sidecar. No external ML libraries. Everything below lives in the same Node process as the API.
## Where it lives
- NLP primitives: `backend/src/services/nlp.ts`
- Pipeline: `backend/src/services/market-filter.ts`
- Public API: `backend/src/routes/markets.ts` (endpoints `/api/markets/curated` and `/api/markets/curated/stats`)
- Bundle gate: `backend/src/routes/bundles.ts` (`POST /api/bundles`)
- Lifetime counters: `backend/src/services/metrics.ts`
- Monitor panel: two new rows in `backend/src/monitor/monitor.html`
## Pipeline overview
Input: raw `PolymarketMarket[]` from the Gamma API.
Output: `{ kept, rejected, funnel }`. Each market is tagged with the stage at which it was dropped (if any), its detected category, and the per-stage reasons.
Stages apply in order. A market that fails a stage short-circuits the rest.
1. `liquidity_floor` — rejects `closed`, `inactive`, volume under the floor (`5,000` USD by default), or missing YES-side price.
2. `quality_nlp` — rejects questions that look like jokes, trolls, or opinions rather than binary outcomes. Uses `assessQuality` in `nlp.ts`.
3. `time_window` — rejects markets resolving in less than `minDaysToResolution` (default 2) or more than `maxDaysToResolution` (default 180).
4. `category_classify` — assigns one of {crypto, sports, politics, economics, entertainment, tech, world, other} via lexicon overlap. Rejects markets whose category is not in `allowedCategories` (default excludes `other` and `entertainment`).
5. `diversity_prefilter` — dedupes near-duplicates across the remaining set using TF-IDF cosine similarity on the question text plus the correlation service's `scoreLegPair`. The higher-volume market wins each dupe cluster.
Config lives in `DEFAULT_FILTER_CONFIG` and is overridable per call.
## Stage 1: liquidity_floor
A market is tradable only if real money has touched it. We check:
- `closed === false` and `active === true`
- USD volume `>= minVolumeUsd`
- YES-side price parses from `outcomePrices`
The volume floor has a big enough gap that penny-stock "memecoin price at 10:00 on a Saturday" markets get stripped immediately.
## Stage 2: quality_nlp
`assessQuality(text)` produces a `{passed, reasons, signals}` triple. A market passes only if every signal is clean:
- length in `[12, 240]` characters
- at most 2 question marks
- contains a binary trigger verb (`will`/`does`/`is`/`has`/`can`/...)
- contains a time anchor (month name, weekday, or a year token preceded by a temporal preposition)
- not a pure superlative (`best`/`worst`/`favorite`/`greatest`/...)
- no troll-pattern match (`gta vi`, `will \w+ die`, `aliens confirmed`, etc.)
The troll regex list is extensible. Adding a new trigger is a single line in `TROLL_PATTERNS` in `nlp.ts`.
## Stage 3: time_window
If `end_date_iso` is missing the market fails. Otherwise we compute `daysToResolution` in floating-point days from now. Below `minDaysToResolution` there isn't enough time for a bundle to be built around this leg. Above `maxDaysToResolution` the probability is too stale to inform pricing.
## Stage 4: category_classify
Category classification is a deterministic softmax over hand-curated lexicons:
- Tokenise the question with the same normaliser used by the correlation engine (lowercase, strip punctuation, drop stopwords, apply a tiny suffix stemmer).
- For each category, count tokens whose stem is in that category's lexicon set.
- Softmax over counts; argmax = detected category.
- Fallback to `other` when the top count is `<= 1` or the gap to the runner-up is smaller than `0.1` softmax mass.
The lexicons live in `LEXICONS` inside `nlp.ts`. They include named entities (Trump, Messi, Satoshi), instruments (BTC, BTC, SPX), venues (NFL, UEFA, FOMC), and domain jargon (halving, tariff, CPI). Stem normalisation means `games` and `game` both match a single stored token.
Adding a new category: add the key to the `Category` union, add a lexicon entry, and the classifier, filter config, and API instantly pick it up. No reindex, no cache bust.
### Why not embeddings?
Two reasons. One, this has to run inside the Node process with no Python. Two, embeddings add opacity — a hackathon judge can read `LEXICONS` and understand *exactly* why a market was labelled `politics`, which is not true of a 384-dim vector.
## Stage 5: diversity_prefilter
Given the survivors, this stage:
1. Builds a TF-IDF corpus over all candidate questions. IDF is smoothed (`log((N+1)/(n+1)) + 1`).
2. Orders candidates by descending volume so higher-liquidity markets anchor dupe clusters.
3. For every pair with at least one shared token, computes cosine similarity in the TF-IDF space.
4. For plausible-dupe pairs (`cosine >= 0.7 * threshold`), also computes `scoreLegPair` from the correlation service — a noisy-OR of Jaccard text, tag overlap, and resolution-date proximity.
5. Drops the lower-volume market if either `cosine >= dedupeCosineThreshold (0.55)` or `correlation >= dedupeCorrThreshold (0.60)`.
This reuses `scoreLegPair` rather than reimplementing it, so dedupe and the downstream correlation engine always agree on what "related" means.
## Public API
### `GET /api/markets/curated`
Query parameters:
- `limit` — max markets returned after filtering (default 24, max 100)
- `overfetch` — raw Polymarket page size before filtering (default `limit * 4`, max 400)
- `category` — restrict to one category (`crypto`/`sports`/`politics`/...)
- `min_volume`, `min_days`, `max_days` — override default thresholds
Response:
```
{
  "count": 18,
  "total_after_filter": 24,
  "funnel": { input_count, kept_count, rejected_count, per_stage, rejection_examples },
  "config": { ...DEFAULT_FILTER_CONFIG with overrides },
  "markets": [ { id, question, condition_id, volume_usd, days_to_resolution, yes_probability, category, category_confidence, ... } ]
}
```
### `GET /api/markets/curated/stats`
Returns lifetime filter counters plus the last 10 filter-run snapshots. This is what the monitor polls for the two new rows.
### `POST /api/bundles` gate
Before the correlation engine runs, every supplied leg has its underlying market fetched from Polymarket and run through `filterSingleMarket`. The request is rejected with HTTP 422 if any leg fails `quality_nlp` or `time_window`. `liquidity_floor`, `category_classify`, and `diversity_prefilter` are advisory at this stage — a bundle may intentionally pick a thin-volume market, and category is a suggestion not a rule.
Gate failure response:
```
422 {
  "error": "One or more legs rejected by market-filter gate",
  "gate_stages": ["quality_nlp", "time_window"],
  "failures": [ { market_id, stage, reasons: [...] }, ... ]
}
```
## Observability
The monitor at `http://localhost:13102` shows two rows:
- Market filter · funnel — four panels with lifetime counters (seen / kept / rejected) plus per-stage rejection totals.
- Market filter · recent runs — last 10 invocations with per-stage rejection breakdown in `L:#  Q:#  T:#  C:#  D:#` format.
Counters live on the shared `metrics` store in `backend/src/services/metrics.ts`. Both `/api/metrics` (used by the main API) and the monitor's `/data` endpoint serialise them in a `market_filter` block.
## Relationship to the correlation engine
The correlation engine (`backend/src/services/correlation.ts`) operates on `LegMetadata[]` and decides how a basket of markets should be weighted + whether it passes the VaR guardrail. The market filter operates one level up: it decides *which markets are even eligible* to be legs.
The two modules share a single primitive (`scoreLegPair`) so a market that passes stage 5 dedupe is guaranteed to also produce a non-degenerate correlation score downstream.
## Honest limitations
- Lexicon-based category classification cannot recover from typos or transliterated names. A market referring to "Musk'" instead of "Musk" still works because stemming strips the apostrophe, but a market about "Elón" will be labelled `other`.
- Quality heuristics are conservative. Some legitimate markets may be rejected if their questions don't contain a recognised binary trigger verb — this is a tunable parameter in `nlp.ts`.
- The diversity pre-filter runs in `O(N^2)` over survivors. Fine at Polymarket's current scale (<500 live markets at any time), but if the Gamma API grows we may need a locality-sensitive hash index.
- Troll patterns are hand-maintained. New memes will slip through until `TROLL_PATTERNS` is updated.
