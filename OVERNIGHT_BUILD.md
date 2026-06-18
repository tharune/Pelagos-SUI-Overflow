# Pelagos — Overnight Build Report

_Built autonomously overnight 2026-06-18 · branch `Tharun-Pelagos` · all commits pushed to `sui/Tharun-Pelagos`._

You asked for a dual-mode (Basic/Advanced) overhaul of the whole product, a live backend, new
on-chain Move modules, and a clean institutional look — to wake up to a working app. Here's what
shipped, how to drive it, and the short list of things flagged for us to finish together.

---

## TL;DR — what's new

- **Global Basic / Advanced toggle** in the header (top-right, next to the theme switch). Persisted per
  browser (`localStorage["pelagos.mode"]`), defaults to **Basic**. It flips **every** product between a
  clean guided view and an institutional / tradfi desk view. Every product title carries a **(Beta)** chip.
- **Information architecture combined** per your screenshots. New nav:
  `Portfolio · Distributed Options · Volatility · Baskets · DeepBook · About`.
- **5 new live backend engines** + **a new on-chain Move package deployed to testnet**.

## The products (Basic ⇄ Advanced)

| Product | Basic | Advanced |
|---|---|---|
| **Distributed Options** (`/app/distribution`) | Live BTC **options-chain terminal** — CALLS \| STRIKE \| PUTS off the live DeepBook-Predict SVI surface, ATM-highlighted, order ticket, real on-chain open | The existing **f(x)/g(x) SVI distribution desk**, preserved (μ/σ view, mint range strip) |
| **Volatility** (`/app/volatility`) | Cleaned **4-strategy desk** (straddle/strangle/butterfly/condor) + **Short/Mid/Far horizon**, payoff, live Greeks, delta-hedge, on-chain open | **Bloomberg vol desk** — interactive **three.js 3D SVI vol surface** + smile slice + ATM term structure + trade builder |
| **Baskets** (`/app/basket`) | **Event Baskets (left) + Risk Slices (right)** side-by-side | **Custom basket builder** (left) — theme or free-text query → diversified, low-correlation legs via the NLP+correlation pipeline, MM pricing; Risk Slices unchanged (right) |
| **DeepBook** (`/app/deepbook`) *(new)* | Simple **strategy cards** (7 prebuilt, risk-tagged) + **Protected Notes** preset picker | **Deployment book** — every range band where capital deploys, on-chain routing handles, greeks; Notes = full **DeFi yield-sleeve** breakdown |
| **Portfolio** (`/app/portfolio`) | Simplified holdings + clean P&L (heavy analytics removed) + **per-strategy backtests on real history** | Same, with extra position detail |

DeepBook BTC moved out of Baskets into its own product; Risk Slices folded into Baskets; Protected
Notes folded into DeepBook. Old routes (`/app/tranche`, `/app/ppn`) still resolve for deep links.

---

## On-chain (testnet — deployed, tested, exercised)

New Move package **`pelagos_strategies`** — a `structured_note` primitive: principal-protection floor +
admin settlement + on-chain risk metadata (tail_risk, convexity). Backs PPNs (floor>0, upside via a
funded reserve), custom baskets (floor=0, settle-at-NAV), and DeepBook strategies.

| Item | ID |
|---|---|
| Package | `0x30932e4e99263ff9649cbab023d0bd42d47d07824a239e77d95a0d17f5d93a57` |
| Publish digest | `EUinMBrnxKnc5ePPAASJaJ2NzniWPaoYAhdrwxGJmS2M` |
| UpgradeCap | `0x5a3f56277a720e7993d014fb395047a9ecc1cae649b83cae1e9d5f451f125a2a` |
| Live Note — at-risk basket (floor 0) | `0xcf62e527122ca2813d7de3a7cb5c37a3d645c554d1edd5660a4cb370d19ad9fd` |
| Live Note — PPN (floor 100%) | `0x5b8a78fd9919608db31073dc95ca8b7fced141768d0e790f8bdb6608ed9a015c` |

- **3/3 Move unit tests pass** (`cd pelagos_strategies && sui move test`): PPN-with-upside, at-risk-basket-loss, early-exit-at-par.
- The package is not just published bytecode — both Notes were **created on-chain** via `create_note`, proving the entry points are callable. IDs are in `backend/.env`.
- Deployer / admin signer: `0xcad0f800f44a48360c01e9fa2d21e779bd829cb60e7220227ed16bb74d4d73e5` (~0.46 SUI gas left).

Existing on-chain rails are untouched and still drive every product's real Open/Sign flow (DeepBook
Predict range-strip mint via `get_range_trade_amounts` devInspect; the Pelagos vault deposit/redeem).

## Backend engines (all live data, reuse existing pricing)

| Endpoint | What | Source |
|---|---|---|
| `GET /api/options/chain?underlying=BTC` | Black-76 options chain (12 expiries × 13 strikes, full greeks) | live SVI surface + on-chain forward |
| `GET/POST /api/custom-baskets/*` | diversified uncorrelated basket builder (themes + query) | Polymarket + NLP + correlation + tranching |
| `GET /api/deepbook/strategies`, `POST /api/deepbook/quote` | 7 prebuilt range-strip strategies, real priced | on-chain `get_range_trade_amounts` |
| `GET /api/notes/strategies`, `POST /api/notes/quote` | principal-protected notes via DeFi-yield allocation | live DeFiLlama Sui USDC APY |
| `GET /api/backtest/*` | per-strategy backtests | real Coinbase candles + Polymarket prices-history |

---

## How to drive it (UAT)

```bash
# processes (already running): frontend :13100, backend :13101, monitor :13102
# toggle Basic/Advanced top-right; it persists. Try Advanced on /app/volatility (3D surface,
# needs WebGL — a real browser has it) and /app/basket (custom builder → pick "AI & Tech" → Build).

# spot-check the engines:
B=http://127.0.0.1:13101
curl -s "$B/api/options/chain?underlying=BTC" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d['expiries']),'expiries')"
curl -s -X POST "$B/api/custom-baskets/build" -H 'content-type: application/json' -d '{"theme":"ai-tech","target_legs":12}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d['legs']),'legs, avg_corr',d['diversification']['avg_pair_corr'])"
curl -s -X POST "$B/api/deepbook/quote" -H 'content-type: application/json' -d '{"strategy_id":"breakout-long-gamma","notional_usd":25000}' | python3 -c "import sys,json;d=json.load(sys.stdin);print('source',d['source'],'buckets',len(d['strip']['buckets']))"
curl -s "$B/api/backtest/strategy?id=short-vol-condor&window=60" | python3 -c "import sys,json;d=json.load(sys.stdin);print('sharpe',round(d['metrics']['sharpe'],2))"
```

Verified clean (screenshot QA, both modes): all 5 products render, no overlap/clipping; full
`tsc --noEmit` is **0 errors**; all routes 200; Move tests pass.

---

## Known limitations / things flagged for us to finish together

1. **Notes "Deploy" button is intentionally disabled** (honest, not broken). The on-chain note primitive
   is deployed + exercised, but the wallet-signed **note-deposit PTB** isn't wired into the button yet
   (no `prepareNoteDeposit` endpoint). **Top fast-follow** — it's a small backend service
   (split MOCK_USDC → `structured_note::deposit(note, coin, label)` → unsigned `tx_bytes`) against the
   live Note IDs above, then point the button at it. I left this rather than risk a half-working
   wallet flow overnight.
2. **Custom-basket "Deploy"** currently routes to Portfolio (the build endpoint returns a quote, not yet
   an on-chain position). Wire it to the same note-deposit flow as (1) once it exists.
3. **Testnet oracles are minute-/hour-dated**, so option greeks (theta/vega) annualize huge — I bound
   them by position value for a sane display, and far-OTM near-expiry premiums collapse to ~0 (rendered
   honestly as "indicative"). Both are correct given testnet tenors; longer-dated oracles would show
   full curvature.
4. **Custom-basket themes cap at the available on-theme liquid markets** — `ai-tech` fields the full 12,
   narrower themes (macro/crypto) field 6–9. That's honest (there aren't always 12 liquid uncorrelated
   markets per theme); `avg_pair_corr` reports diversification truthfully.
5. **Docs / About page** still describes the previous product structure (Distribution / Risk Slices /
   Protected Notes as separate). Prose only — the products work; worth a copy pass.

Everything above is committed and pushed. Happy to knock out (1)+(2) first thing — they're the only
items between this and a fully wallet-clickable new-product flow.
