# Pelagos Sui Architecture

Pelagos packages prediction-market outcomes into structured products and runs
the local hackathon build against Sui testnet. The product surfaces are market
baskets, risk slices, protected notes, distribution markets, and portfolio
views.

## Local Topology

```text
Next.js frontend :13100
        |
        v
Express API :13101 -------- Polymarket Gamma/CLOB
        |
        +---- /api/sui/* ---- Sui CLI ---- Sui testnet package
        |
        +---- /api/distribution/* ---- live market discovery + quote engine
        |
        +---- monitor :13102 ---- process, API, Sui, and market-filter metrics
```

The active chain path is Sui:

- Move package: `pelagos_sui/`
- Testnet package ID: `0xd97616b19d16c944cb5f5f4d22c471df3d4ea1640764b46a2be2587a4be890cd`
- Modules: `mock_usdc`, `prediction_market`
- Backend route prefix: `/api/sui`
- Frontend mode: `NEXT_PUBLIC_CHAIN=sui`

## Repository Layout

```text
app/             Next.js app and product UI
backend/         Express API, Sui local harness, monitor, pricing services
pelagos_sui/     Sui Move package and Move tests
public/          Pelagos visual assets
README.md        Quickstart and active deployment IDs
detailed.md      Production-readiness plan
```

## Local Setup

```bash
npm install
(cd backend && npm install)

cp .env.local.example .env.local
cp backend/.env.example backend/.env
```

Confirm the Sui CLI is configured for testnet:

```bash
sui client active-env
sui client active-address
```

Run locally:

```bash
(cd backend && npm run dev)
npm run dev
```

Open:

- Frontend: `http://localhost:13100`
- Backend status: `http://localhost:13101/api/sui/status`
- API docs: `http://localhost:13101/api/docs`
- Monitor: `http://localhost:13102`

## Runtime Responsibilities

The frontend keeps the existing Pelagos UI and branches on
`NEXT_PUBLIC_CHAIN=sui` for product actions. In Sui mode, basket, risk-slice,
and protected-note actions call backend `/api/sui/local/basket/*` routes.

The backend is a local Sui testnet harness. It shells out to the Sui CLI using
`SUI_KEYSTORE_PATH` and `SUI_ACTIVE_ADDRESS`, then signs with the configured dev
key. Production should replace this with wallet-signed programmable transaction
blocks and indexed Sui state.

The Move package provides the current testnet primitive:

- `mock_usdc` mints testnet-only mUSDC through a TreasuryCap.
- `prediction_market` creates binary markets, opens YES/NO position objects,
  resolves outcomes, and pays winning positions pro rata.

Distribution Markets are built from live Polymarket event groups. The backend
filters candidates, builds a CLOB-implied reference curve, quotes submitted
target curves, and returns local launch plans.

## Verification

```bash
npm run build
(cd backend && npm run build)
sui move test --path pelagos_sui
curl http://localhost:13101/api/sui/status
curl http://localhost:13102/data
```
