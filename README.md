# Pelagos — Structured products on Sui, settled on DeepBook Predict

Pelagos turns prediction-market outcomes into clean, tradeable **structured products** — a live
BTC options chain, a volatility desk, diversified event baskets, DeepBook range-strip strategies, and
principal-protected notes — all priced off **real on-chain liquidity** and minted, **wallet-signed**,
on **Sui testnet**.

> **Track:** DeepBook Predict (DeepSurge) · **Network:** Sui testnet (chain `4c78adac`).
> **Status:** live end-to-end — real wallet-signed mints, real DeepBook Predict settlement, real
> market-maker pricing. No invented numbers anywhere in the pricing path.

**▶ Live demo:** **<https://pelagos-sui.vercel.app>** — frontend on Vercel, non-custodial backend on
Akash. Connect a Sui-testnet wallet, hit **"Test funds"** for dUSDC + mUSDC, and trade.

## Two interfaces, one engine

A global **Basic / Advanced** toggle (header, persisted per browser) reskins every product:

- **Basic** — clean, guided, prebuilt. The default.
- **Advanced** — the institutional desk: order books, an interactive 3D SVI vol surface, the
  risk-slice tranching engine, full greeks, and on-chain deployment detail.

## Products

Nav: **Portfolio · Distribution Markets · Volatility · Range Strips · Baskets · About**

| Product | What it is |
|---|---|
| **Distribution Markets** | A live BTC **options chain** — calls/puts across every on-chain expiry (≈15m → 22d), each a DeepBook Predict range with a $1 binary payout, priced live off the protocol's own bid/ask — plus a **μ/σ distribution builder** to trade your whole view of *where* BTC settles, not one strike. Whole contracts, depth/risk-capped, settled on Sui. |
| **Volatility** | Trade implied-vs-realized vol with prebuilt structures (straddle / strangle / butterfly / iron condor), a live payoff diagram + greeks, and a delta-hedge sleeve. Advanced adds an interactive **3D SVI vol surface** + smile / term-structure analytics + a multi-leg trade builder. |
| **Range Strips** | Prebuilt DeepBook Predict range-strip strategies (Pin · Iron Condor · Breakout · Convex Tail · Protected Core · Upside Skew · Term Ladder), each priced live off the order book — plus **principal-protected notes** that route real Sui DeFi yield into a deployed upside strip. |
| **Baskets** | Diversified event baskets (Polymarket CLOB-priced), de-correlated by an NLP layer (TF-IDF cosine + theme clustering) so the legs are genuinely uncorrelated, not 30 variants of one bet. Basic is a clean basket terminal; **Advanced** is the risk-slice tranching engine (senior / mezzanine / junior). |
| **Portfolio** | Holdings, live mark-to-market, and P&L. |

> Note: *Volatility* and *Range Strips* share one strip-pricing engine (`previewStrip` →
> `get_range_trade_amounts`) — Volatility is the analyst/sculpt surface (live vol surface + free-form
> builder), Range Strips is the prebuilt-recipe surface (+ protected notes).

## Why Sui

Pelagos isn't a generic dApp that happens to run on Sui — its core mechanics depend on primitives
that **only exist here**.

- **DeepBook Predict *is* the settlement venue, and it's Sui-native.** Every option, vol structure,
  range strip, and protected-note upside leg is a real DeepBook Predict **range** position — priced
  against the protocol's live on-chain liquidity (`get_range_trade_amounts`) and settled natively
  (`mint_range` / `redeem`). DeepBook Predict is Mysten's on-chain options/prediction protocol;
  there is no equivalent primitive to build this on elsewhere.
- **Programmable Transaction Blocks make multi-leg products one signature.** A protected note
  atomically splits dUSDC into a floor coin supplied to the PLP vault **and** an upside coin minted
  as an 8-leg range strip — in a *single* wallet signature. The in-app faucet tops a wallet with
  mUSDC + dUSDC + SUI gas in one PTB. On an account-based chain each of these is several transactions
  or a bespoke router contract; on Sui, PTBs compose arbitrary Move calls atomically.
- **`devInspect` gives real pre-trade pricing for free.** Every band of a strip is priced in a single
  read-only `devInspectTransactionBlock` against live vault state — real MM bid/ask *including
  post-trade slippage*, with zero gas and no on-chain write. That's how the UI shows honest quotes
  instantly; it's a Sui execution feature, not a model.
- **The object model makes positions first-class.** Sui objects + Move resources mean every position
  is a real owned object — a `VaultShare<T>` receipt, a `NotePosition<T>`, a minted range — that is
  transferable and composable, not a row in a global balance map. Structured-product receipts,
  tranches, and notes are the natural shape of Sui objects.
- **Parallel execution + shared objects = a trading-app feel.** Owned-object transactions execute in
  parallel (Mysticeti consensus); shared objects (the `Vault`, the Predict root, the `Faucet`) handle
  concurrent multi-user access. Low, predictable gas + fast finality is what lets wallet-signed
  minting feel like a desk, not a settlement queue.
- **Woven into Sui DeFi, not just deployed on it.** The vol desk marks BTC against Sui-native venues
  first — **Bluefin** perp, **DeepBook** XBTC/USDC CLOB, **Pyth** on Sui — and the protected-note
  floor earns real **Sui USDC lending** yield (Suilend / Navi / Scallop / Kai). The data and the hedge
  live on the same chain as the product.
- **Coin standard + shared `TreasuryCap` powers the demo rail.** A shared `mock_usdc::Faucet` wraps
  the `TreasuryCap` so anyone can mint test **mUSDC** permissionlessly — the same DeepBook pricing on
  an unlimited test supply, so a demo never bottlenecks on the scarce dUSDC faucet, while the real
  dUSDC settlement path stays intact.

## On-chain (Sui testnet)

Three Pelagos Move packages, plus Mysten's **DeepBook Predict** (which we *call*, not deploy):

- **`pelagos_sui`** — `mock_usdc` (freely-mintable test collateral) + `prediction_market` (binary markets).
- **`pelagos_vault`** — a generic `Vault<T>` with NAV share-price, backing baskets + Predict-backed wrappers.
- **`pelagos_strategies`** — a `structured_note` primitive (principal-protection floor + admin settlement).
- **DeepBook Predict** (Mysten testnet) — on-chain range markets. Every option / strategy leg is priced
  against its real liquidity via `get_range_trade_amounts` and settled natively.

**Non-custodial:** the backend builds *unsigned* programmable transaction blocks; the user's wallet
(`@mysten/dapp-kit`) signs them. The backend never custodies user funds.

**Collateral:** every product settles in **either** currency, 1:1 in USD, chosen per order.
**dUSDC** (DeepBook Predict's quote asset, faucet-gated) routes through Predict directly; **Pelagos
USDC** (`MOCK_USDC`, freely mintable) settles on Pelagos's own generic `Vault<T>` — same DeepBook
pricing, with an unlimited test supply so demos never bottleneck on the dUSDC faucet.

→ Full deployed package + object IDs and verified on-chain flows: **[`DEPLOYMENT.md`](DEPLOYMENT.md)**.

## Quickstart

Prereqs: Node 20+, npm, Sui CLI configured for testnet, a funded testnet key.

```bash
npm install && (cd backend && npm install)

cp .env.local.example .env.local
cp backend/.env.example backend/.env        # fill in the IDs from DEPLOYMENT.md + a funded key

# backend (:13101) + monitor (:13102)
(cd backend && npm run dev)
# frontend (:13100) — in another terminal
npm run dev
```

- Frontend: <http://localhost:13100>
- Backend health: <http://localhost:13101/api/health>
- Monitor: <http://localhost:13102>

> **Heads-up:** this is a *forked* Next.js with non-standard conventions (the app dir is `app/app/`).
> Read **[`AGENTS.md`](AGENTS.md)** before touching frontend code.

## Verify

```bash
(cd app && npx tsc --noEmit)              # frontend typecheck
(cd backend && npx tsc --noEmit)          # backend typecheck
(cd pelagos_strategies && sui move test)  # Move unit tests (per package)
curl http://localhost:13101/api/health
```

## Docs

- **[`DEPLOYMENT.md`](DEPLOYMENT.md)** — live testnet package/object IDs + verified on-chain flows.
- **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — topology, backend engines, data sources, and why Sui.
- **[`README_DEEPBOOK.md`](README_DEEPBOOK.md)** — detailed DeepBook Predict integration writeup.
- **[`MARKET_FILTER.md`](MARKET_FILTER.md)** — the 5-stage NLP market-quality filter behind baskets.
- **[`backend/README.md`](backend/README.md)** · **[`backend/SETUP.md`](backend/SETUP.md)** — backend setup.
- **[`TEAM_SETUP.md`](TEAM_SETUP.md)** — team onboarding (env, signing access).
