# Pelagos × Sui — Status & Handoff

_Last updated: 2026-06-18 · branch `Tharun-Pelagos` · synced with `sui/Tharun-Pelagos`_

This is a self-contained handoff so a fresh session can continue without re-discovering the
codebase. Read this first, then `AGENTS.md` (it warns the Next.js fork is non-standard — read
`node_modules/next/dist/docs/` before writing Next code).

---

## 0. TL;DR for the next session

- **What works:** backend (`:13101`) + monitor (`:13102`) + frontend (`:13100`) all live; Sui testnet
  RPC + signer + vault + DeepBook Predict pricing all verified on-chain; Polymarket live; the whole
  pricing surface is wired to **real live data** (only MM spreads / synthetic-market outcomes are
  simulated, and they're labeled).
- **Recently rebuilt (latest session):** Event Baskets now build **on the backend** (`GET /api/baskets`
  / `/:id`, service `backend/src/services/baskets.ts`) from a ~1,200-market live universe, pricing
  **every constituent leg off the Polymarket CLOB midpoint** (batched `POST clob.polymarket.com/midpoints`,
  BBO→Gamma fallback). Frontend `useLiveBaskets` fetches that; the old client `buildLiveBaskets` is now a
  fallback only. The **MID (tier 70) basket tier was fully retired** — Baskets + Risk Slices ship High/Low
  only (2×3 = 6 baskets). **Volatility desk** default notional is now **$25k** (at $100 every Greek/hedge
  read 0.0000). A full screenshot QA sweep fixed docs MID copy, the basket-detail constituents table
  (all legs, scrollable), landing $-billions formatting, the DeepBook EXPIRY column, the junior-APY
  "300%+" cap label, and assorted polish.
- **Earlier:** Volatility desk build, "DeepBook Predict" de-branding.
- **Conventions (do not break):** commit + push every change to `sui/Tharun-Pelagos`, author
  "Tharun Ekambaram", **NEVER add Claude/AI co-author or "Generated with" trailers**. Mac is
  disk-constrained — never write large data locally.
- **To verify everything in one go:** see §8 (Verification cookbook).

---

## 1. What Pelagos is

A Sui-testnet dApp of **structured products over prediction markets**, two engines:

1. **BTC structured products** on Mysten's **DeepBook Predict** (range/binary markets). A SVI vol
   surface is sliced into on-grid range "strips"; pricing is **real** `get_range_trade_amounts`
   devInspect (not a model). Powers Distribution, Volatility, Baskets (term), Protected Notes.
2. **Polymarket event baskets** (PBU-*) — curated baskets of uncorrelated binary event markets,
   tranched (senior/mezz/junior) and sliced by probability tier (High/Mid/Low), settled on Pelagos's
   own on-chain vault. Powers Baskets (event), Risk Slices, Portfolio, the MM secondary desk.

Non-custodial throughout: the backend builds **unsigned** PTBs; the user's wallet (`@mysten/dapp-kit`)
signs. dUSDC (DeepBook) and MOCK_USDC (vault) are the quote assets — both faucet-gated testnet coins.

---

## 2. Architecture & how to run

```
repo root (= the Next.js app; app dir is app/app/, NON-standard fork)
├── app/app/                 frontend pages + components (Next.js 16, App Router)
│   ├── volatility/ basket/ tranche/ distribution/ ppn/ portfolio/ predict/ docs/
│   ├── _components/         shared UI (strip-products, charts, Header, MmDeskBid, …)
│   └── _lib/                clients + tokens (predict-strip-client, mm-client, tokens, bundles, live-baskets)
├── backend/                 Express/TS API (port 13101), run via `tsx watch`
│   └── src/routes/  src/services/  (predict/, vault/, bluefin, polymarket, proxy, …)
└── pelagos_sui/             Move package (prediction_market + mock_usdc)
```

**Run (three processes):**

```bash
# backend (port 13101) + monitor (13102)
cd backend && npm run dev          # = tsx watch --tsconfig ./tsconfig.dev.json src/index.ts
# frontend (port 13100)
npm run dev                        # = next dev --port 13100  (app at repo ROOT, not frontend/)
```

> `tsx watch` does NOT reliably hot-reload on every edit — **restart the backend** after backend
> edits: `kill $(lsof -nP -iTCP:13101 -sTCP:LISTEN -t); cd backend && npm run dev &`.

**Type-checking:**
- Frontend: `npx tsc --noEmit` from repo root is currently **clean (0 errors)**. `next build` is the
  authoritative check but conflicts with a running `next dev` over `.next` — prefer `tsc` + dev compile.
- Backend: `npx tsc --noEmit -p backend/tsconfig.dev.json` shows ~60 **pre-existing** errors that are
  all the `@mysten/sui` module-resolution quirk under bare tsc (+ its downstream implicit-anys in
  scripts/services). `tsx`/esbuild resolves them at runtime — they are NOT real. Filter to your
  changed files; if your files are absent from the error list, you're clean.

**Ports:** 13100 frontend · 13101 backend · 13102 monitor.

---

## 3. Live on-chain deployment (testnet) — CURRENT values

> ⚠️ These supersede older IDs in memory/docs (the footprint was redeployed). Source of truth is the
> running backend: `curl -s localhost:13101/api/onchain/status` and `.../api/predict/config`.

**Pelagos package (prediction_market + mock_usdc):**
- `SUI_PACKAGE_ID` = `0x598434be38a69bf97b70490d320a698445990de38eb36e2f4c9d41dbe1ff3e45`
- `MOCK_USDC_TYPE` = `0x598434be…::mock_usdc::MOCK_USDC` (6 decimals)
- market AdminCap = `0x450d3450381a1f0fcbfbc0c354b8af4e7d0e7f732591bd6db57d5c14bf01105d`
- mUSDC metadata = `0x952435fcae9412796ddf2a9f0e173c9a2caba7b2f26079714a9e1a3bfd33a287`

**Pelagos vault (deposit/redeem, share price):**
- `VAULT_PACKAGE_ID` = `0xcaff49f849bdf83b2df754ffc7d43c07b19ee33c2395255185607b55802e2b19`
- `VAULT_OBJECT_ID` = `0x5fdc7d7a94d1dc7ae459b2e3f6760cb3b6745e6c3e4f2eed511da54bd0042d2d`
- On-chain share price verified live (devInspect) — currently 1.0 (empty vault).

**Signer / deployer (holds caps + faucet mUSDC):**
- `0xcad0f800f44a48360c01e9fa2d21e779bd829cb60e7220227ed16bb74d4d73e5`
- Balances at handoff: ~0.50 SUI, ~1,012,345 mUSDC.

**DeepBook Predict (Mysten SHARED infra — NOT ours, leave untouched):**
- server `https://predict-server.testnet.mystenlabs.com`
- package `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138`
- predict object `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a`
- dUSDC type `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC` (6 dp)
- RPC `https://fullnode.testnet.sui.io:443`

Live `.env*` files are gitignored (only `*.example` tracked). `backend/.env` carries the
`POLYMARKET_RELAY_URL` (now non-fatal, see §5).

---

## 4. Product surfaces (current state)

Nav: Portfolio · Distribution · Volatility · Risk Slices · Protected Notes · Baskets · About.

| Surface | Route | What it is | UI state |
|---|---|---|---|
| **Volatility** | `/app/volatility` | BTC vol desk — 4 structured strategies, payoff diagram, live Greeks + live delta-hedge | **Rebuilt** this session, institutional |
| **Distribution** | `/app/distribution` | Trade the whole BTC settlement distribution f(x)/g(x) on the live SVI surface | Clean |
| **Baskets** | `/app/basket` | Tab 1 = BTC **term/calendar** strips (DeepBook); Tab 2 = Polymarket **event baskets** (High/Mid/Low) | Mid tier restored |
| **Risk Slices** | `/app/tranche` | Senior/mezz/junior tranches of event baskets, by tier | **High/Mid/Low** (Mid restored) |
| **Protected Notes** | `/app/ppn` | PLP floor + upside strip; on-chain deposit/redeem | Clean |
| **Portfolio** | `/app/portfolio` | Positions, live NAV mark-to-market | Clean |
| **MM secondary desk** | component `MmDeskBid` (basket detail) | Sell a position to the protocol MM at a live mark − simulated spread | Live-mark anchored |

**Volatility desk details (the centerpiece):**
- 4 strategies = `straddle` (long γ ATM) · `strangle` (long γ OTM wings) · `butterfly` (short γ pinned)
  · `condor` (iron condor, short γ ranged). Backend `strategyProfile()` in
  `backend/src/services/predict/volatility.ts` maps each to a strip weight/span. `/api/vol/quote`
  takes `{strategy, notional_usd}`; returns `{strategy, strategy_label, thesis, sigma_usd, strip,
  greeks, mark, hedge, …}`.
- **Payoff diagram** = net P&L vs BTC settlement (SVG), profit/loss shaded, forward + live-mark marker.
- **Live updates:** `GET /api/vol/mark` (cached ~1.5s, `fetchBtcMarkCached`) polled every 2s →
  ticker + net delta + gamma P&L recompute client-side (`runDelta = δ + Γ·(mark − fwd)`; position is
  delta-neutral at entry and drifts with gamma). Quote re-polls every 8s for Greeks.
- Greeks signs verified: long γ → +Γ/+vega/−θ; short → inverse. Default horizon ~3 days (not 1h — a
  1h tenor annualized theta into a nonsense −$571/day; ~3d gives ~−$5/day).

---

## 5. Data-source map: LIVE vs SIMULATED (the audit + remediation)

A full audit (parallel agents over every non-predict cluster) confirmed and fixed the fabrications.
Headline: **everything user-facing is now live data; only MM spread + synthetic-market outcomes are
simulated, and they're labeled.**

**LIVE (real):**
- **DeepBook Predict pricing** — real `get_range_trade_amounts` devInspect (strips, vol legs, term
  baskets, PPN upside). The vol leg + Distribution + Baskets-term all price on-chain.
- **Polymarket** — Gamma markets + CLOB books. `getMarketProbability` (live odds) drives bundle NAV.
- **Event Baskets (`GET /api/baskets`)** — `backend/src/services/baskets.ts` buckets the live universe
  into 6 baskets (High/Low × Short/Med/Long) and prices **every constituent leg off the CLOB midpoint**
  (`POST clob.polymarket.com/midpoints`, batched; BBO→Gamma fallback). Each leg carries a `priceSource`
  (`clob`/`bbo`/`gamma`) — currently 167/167 legs priced from CLOB. NAV = volume-weighted CLOB mids with
  a per-tier NAV tilt (HIGH→0.95, LOW→0.05). Frontend renders this; client `buildLiveBaskets` is fallback.
- **BTC mark** (vol hedge) — Sui-DeFi-first: Bluefin BTC-PERP → **DeepBook XBTC/USDC** on-chain CLOB
  mid → Pyth → Coinbase → Predict forward, tagged `chain: sui|cex|forward`. Currently serves DeepBook
  (Bluefin DAPI was down). `services/bluefin.ts`.
- **Realized vol** — real Coinbase hourly candles (`fetchRealizedVol(window, product)`); feeds VRP and
  the continuous-market σ per asset.
- **Vault** — real on-chain `readVaultState` (devInspect), real deposit/redeem PTBs + dry-run.
- **Vault yields** — DeFiLlama Sui USDC pools (NAVI/Scallop/Suilend), honest fallback.
- **Lending rates** — anchored to live DeFiLlama Sui USDC supply APY (`market_supply_apy`,
  `rate_source`); warmed at boot. (Lend/borrow *actions* are an in-memory demo — see below.)
- **Continuous distribution AMM** — pool backing `b` = real CLOB depth / 24h CoinGecko volume (was
  `Math.random()`); μ live (CoinGecko), σ from real realized vol.
- **Tranche σ** — `basketSigmaFromLegs()` = √(Σ wᵢ²·pᵢ(1−pᵢ)) from live per-leg odds (was a binomial
  approx). Wired into PPN RFQ, MM mark, portfolio. **Two `quoteTranches`:** `services/tranching.ts`
  (Polymarket baskets) vs `services/predict/products.ts` (DeepBook, already real SVI σ).
- **MM secondary bid** — anchored to a live mark (basket→live NAV, tranche→model fair value, note→par).
- **Leaderboard** — positions marked to live NAV (was stale entry-price cost basis).

**SIMULATED (no real flow exists — labeled honestly):**
- **MM fill** — the secondary sell settles off-chain to the ledger (no on-chain Pelagos MM rail). The
  *spread* (MM edge) is simulated; the *mark* is live.
- **Perp hedge routing** — "Route hedge" is a simulated fill; the mark/funding/size are real.
- **Continuous-market realized outcome** — `drawNormal` (seeded, deterministic) — these synthetic
  forwards have no settlement oracle; the on-chain money (escrow/mint) is real.
- **Lending lend/borrow/repay** — in-memory pool mutation, no on-chain Pelagos lending contract.
- **Correlation model** — `scoreLegPair` is a documented deterministic heuristic standing in for an
  unshipped sklearn classifier; `/api/ml/manifest` now reports `artifacts_present:false` and nulls the
  audited metrics (no zeros-as-audited).

**Key fix — Polymarket relay (`services/proxy.ts`):** the leased relay had died (HTTP 000) and
`proxiedFetch` forced ALL Gamma/CLOB through it, silently breaking every live price. Now it's
**direct-first with relay fallback on throw** (adaptive) — a dead relay is non-fatal. This is why
`/api/health` shows `polymarket: ok`.

---

## 6. Work log (newest first, all pushed)

```
657da30 distribution: fade the tenor list bottom so a scrolled card doesn't read as clipped
1ed8dc1 qa sweep: fix docs MID copy, vol polish, constituents, landing + table nits
ddfb1e9 vol UI: institutional $25k default notional + $-labeled payoff axis
e4691e6 baskets: backend CLOB-priced Event Baskets + retire the MID tier
73f8388 status: in-depth handoff doc (STATUS.md) + fix landing duplicate stat
f2c605f de-brand: remove 'DeepBook Predict' from user-facing labels
284f851 products: restore the Mid (70) tier on Baskets + Risk Slices
683a9ef vol UI: wide institutional desk — strategies, payoff diagram, live hedge
29b468f vol backend: structured option strategies + live mark endpoint
e399c22 leaderboard + vault yields: live mark-to-market and honest attribution
631faa2 correlation: ML manifest honest about absent artifacts (no zeros-as-audited)
54c5736 distribution-continuous: σ from REAL realized vol, not hardcoded multipliers
518101c lending: anchor pool rates to LIVE Sui USDC lending market (DeFiLlama)
3289e52 tranching: basket σ from REAL live per-leg odds, not a binomial approx
e10deaa mm: anchor the secondary-market bid to a LIVE mark, simulate only the spread
9e1727b distribution-continuous: back the AMM pool with LIVE depth, not Math.random
5c841ae proxy: make Polymarket relay non-fatal — direct-first with relay fallback
48ee4c1 / 3e0a19b / 9be7f99 / 2ad39bd  Volatility desk (initial build + Sui mark)
032fd8e / f3e6d4d  BTC term/calendar baskets
```

---

## 7. Known issues / pending / next steps

- **Live wallet-signed E2E not exercised this session.** Pricing/quote/prepare layers are verified, but
  Open (vol/basket/PPN/distribution) and the MM sell need a funded testnet wallet to click through and
  confirm an on-chain digest. **Highest-value next step.** (Signer has SUI+mUSDC; users get dUSDC via
  the faucet at https://tally.so/r/Xx102L for DeepBook products.)
- **MID tier retired** — Baskets + Risk Slices ship High/Low only. If you re-add a tier, touch
  `services/baskets.ts` (TIER_RANGE/TARGET_COMBOS) + the frontend `live-baskets.ts` mirror + tier
  filters/labels in `basket/page.tsx`, `tranche/page.tsx`, `tokens.ts:tc()`.
- **Deferred low-priority polish (from the QA sweep, not yet done):** portfolio empty-wallet messaging
  (triple "no positions", `+$0.00` shown in gain-green), PPN order-book 6-ask/7-bid asymmetry + dUSDC-vs-`$`
  unit labels, DeepBook basket left-card empty lower halves, basket-detail question-text truncation
  (full text only via the external link). All cosmetic; the screenshots are clean otherwise.
- **`/api/markets` is hard-capped at 100** (route-level) — the wide universe for baskets comes from the
  internal `fetchMarkets({limit:1200})` service, not that public route. Don't "fix" the cap expecting
  baskets to change.
- **Bluefin DAPI** was returning "no healthy upstream" — the mark falls through to DeepBook (still Sui,
  still live). Will auto-use Bluefin's perp mark + real funding when their gateway returns.
- **pelagos-chain.ts** `estimateDeposit/estimateRedeem` are dead code (no callers); `getYieldSleeveState`
  `apy_bps:800` is admin-only display. Low priority.

---

## 8. Verification cookbook

```bash
B=http://127.0.0.1:13101
# health (expect: status ok | supabase ok | polymarket ok)
curl -s $B/api/health
# on-chain (Sui RPC + signer balances + package ids)
curl -s "$B/api/onchain/status"
# DeepBook Predict config (shared Mysten infra ids)
curl -s "$B/api/predict/config"
# live predict oracle forward (real on-chain)
curl -s "$B/api/predict/forward?underlying=BTC"
# vol desk: a structured strategy quote (full devInspect strip + Greeks + live mark)
curl -s -X POST "$B/api/vol/quote" -H 'content-type: application/json' -d '{"strategy":"straddle","notional_usd":100}'
curl -s "$B/api/vol/mark"        # fast live BTC mark
curl -s "$B/api/vol/surface"     # IV term structure + RV + VRP
# Event Baskets — 6 baskets (High/Low × Short/Med/Long), every leg CLOB-priced
curl -s "$B/api/baskets" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['count'],'baskets ·',d['clob_priced_legs'],'/',d['total_legs'],'legs CLOB-priced')"
curl -s "$B/api/baskets/PBU-LOW-SHORT" | python3 -c "import sys,json;b=json.load(sys.stdin)['basket'];print(b['id'],'nav',b['nav'],'legs',b['totalLegs'])"
# baskets / tranches / lending / vault yields / leaderboard
curl -s "$B/api/bundles" | python3 -c "import sys,json;print(len(json.load(sys.stdin)),'bundles')"
curl -s "$B/api/lending" | python3 -c "import sys,json;d=json.load(sys.stdin);print('rate_source',d['rate_source'],'market_supply',d['market_supply_apy'])"
curl -s "$B/api/vaults/yields" | python3 -c "import sys,json;d=json.load(sys.stdin);print('yield venues', len(d.get('yields') or d.get('sources') or []))"
# frontend pages (expect 200)
for p in / /app/volatility /app/distribution /app/basket /app/tranche /app/ppn /app/portfolio; do echo -n "$p "; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:13100$p; done
```

Headless screenshot (no browser MCP): `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
--headless=new --hide-scrollbars --disable-gpu --force-device-scale-factor=1 --virtual-time-budget=11000
--window-size=1600,1300 --screenshot=/tmp/out.png http://127.0.0.1:13100/app/volatility` then read the PNG.

---

## 9. Conventions & guardrails

- **Git:** branch `Tharun-Pelagos`, remote `sui` → github.com/tharune/Pelagos-SUI-Overflow. Commit +
  push **every** change with a message naming the specific changes. Author "Tharun Ekambaram".
  **NEVER** add a Claude/Opus/Anthropic co-author or "Generated with" trailer (global rule).
- **Next.js fork:** non-standard — read `node_modules/next/dist/docs/` before writing Next code.
  styled-jsx + LayoutProps cause spurious bare-`tsc` errors; `next build` is authoritative.
- **Honesty:** never present simulated/estimated numbers as live — label venue/source; the audit above
  is the standard to maintain.
- **Mac is disk-constrained** — never download/write large data locally.
- **Don't touch** the Mysten DeepBook Predict shared infra IDs (§3) — they're not ours.
```
