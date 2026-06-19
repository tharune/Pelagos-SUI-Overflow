# Pelagos — Structured products on Sui, settled on DeepBook Predict

Pelagos turns prediction-market outcomes into clean, tradeable **structured products** — a live
BTC options chain, a volatility desk, diversified event baskets, DeepBook range strategies, and
principal-protected notes — all priced off **real on-chain liquidity** and minted, **wallet-signed**,
on **Sui testnet**.

> **Track:** DeepBook Predict (DeepSurge) · **Network:** Sui testnet (chain `4c78adac`).
> **Status:** live end-to-end — real wallet-signed mints, real DeepBook Predict settlement, real
> market-maker pricing. No invented numbers anywhere in the pricing path.

## Two interfaces, one engine

A global **Basic / Advanced** toggle (header, persisted per browser) reskins every product:

- **Basic** — clean, guided, prebuilt. The default.
- **Advanced** — the institutional desk: order books, an interactive 3D SVI vol surface, the
  risk-slice tranching engine, full greeks, and on-chain deployment detail.

## Products

Nav: **Portfolio · Distributed Options · Volatility · Baskets · DeepBook · About**

| Product | What it is |
|---|---|
| **Distributed Options** | Live BTC options chain — calls/puts across every on-chain expiry (≈15m → 22d). Each contract is a DeepBook Predict range with a $1 binary payout, priced live off the protocol's own bid/ask. Whole contracts, depth/risk-capped, settled on Sui. |
| **Volatility** | Trade implied-vs-realized vol with prebuilt structures (straddle / strangle / butterfly / iron condor), a live payoff diagram + greeks, and a delta-hedge sleeve. Advanced adds an interactive **3D SVI vol surface** + smile / term-structure analytics + a multi-leg trade builder. |
| **Baskets** | Diversified event baskets (Polymarket CLOB-priced), de-correlated by an NLP layer (TF-IDF cosine + theme clustering) so the legs are genuinely uncorrelated, not 30 variants of one bet. Basic is a clean basket terminal; **Advanced** is the risk-slice tranching engine (senior / mezzanine / junior). |
| **DeepBook** | Prebuilt DeepBook Predict range strategies + principal-protected notes (a DeFi-yield sleeve allocated into the strategies). |
| **Portfolio** | Holdings, live mark-to-market, P&L, and per-strategy backtests on real price history. |

## On-chain (Sui testnet)

Three Pelagos Move packages, plus Mysten's **DeepBook Predict** (which we *call*, not deploy):

- **`pelagos_sui`** — `mock_usdc` (freely-mintable test collateral) + `prediction_market` (binary markets).
- **`pelagos_vault`** — a generic `Vault<T>` with NAV share-price, backing baskets + Predict-backed wrappers.
- **`pelagos_strategies`** — a `structured_note` primitive (principal-protection floor + admin settlement).
- **DeepBook Predict** (Mysten testnet) — on-chain range markets. Every option / strategy leg is priced
  against its real liquidity via `get_range_trade_amounts` and settled natively.

**Non-custodial:** the backend builds *unsigned* programmable transaction blocks; the user's wallet
(`@mysten/dapp-kit`) signs them. The backend never custodies user funds.

**Collateral:** **dUSDC** (DeepBook Predict's quote asset, faucet-gated) for every Predict leg;
**MOCK_USDC** (freely mintable) for Pelagos's own vault / basket flows so demos never bottleneck.

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
- **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — topology, backend engines, data sources.
- **[`README_DEEPBOOK.md`](README_DEEPBOOK.md)** — detailed DeepBook Predict integration writeup.
- **[`MARKET_FILTER.md`](MARKET_FILTER.md)** — the 5-stage NLP market-quality filter behind baskets.
- **[`backend/README.md`](backend/README.md)** · **[`backend/SETUP.md`](backend/SETUP.md)** — backend setup.
- **[`TEAM_SETUP.md`](TEAM_SETUP.md)** — team onboarding (env, signing access).
