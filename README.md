# Pelagos Sui

Pelagos is a structured prediction-market interface running locally against a
Sui testnet Move package. The current build preserves the Pelagos product
surface - baskets, tranches, principal-protected notes, distribution markets,
portfolio views, and docs - while routing local testnet actions through Sui mock
USDC and a Sui binary prediction-market module.

This repository is the Sui-focused hackathon project. The active local
deployment is Pelagos on Sui testnet.

## What Works

- Sui testnet Move package deployed with:
  - `mock_usdc::MOCK_USDC`
  - `prediction_market`
- Backend Sui API routes under `/api/sui`.
- Frontend Sui mode via `NEXT_PUBLIC_CHAIN=sui`.
- Portfolio reads the configured Sui testnet mock-USDC balance.
- Basket buy creates a Sui market, mints mock USDC, buys a Sui position object,
  and links to Sui Explorer.
- Basket sell resolves and claims the Sui position and clears local holdings.
- PPN open/close exercises the Sui-backed local position path.
- Tranche buy/RFQ sell exercises the Sui-backed local position path.
- Distribution Markets has a dedicated product tab inspired by Paradigm's
  distribution-market design: the backend discovers live, liquid market groups,
  scores volume, orderbook depth, spread, time-to-resolution, and NLP quality,
  then builds a CLOB-implied reference curve from the underlying outcome prices.
- Frontend build, backend build, and Move tests pass locally.

## Important Caveat

This is a working local Sui testnet harness, not a production custody model.
The backend currently signs Sui transactions with a configured local dev key.
Production must replace that with Sui wallet-signed programmable transaction
blocks, a real indexer, and audited product-level Move contracts. See
`detailed.md` for the production-readiness roadmap.

## Active Sui Testnet Deployment

Package:

- Package ID: `0xa630b97e9c5f1cd9804553018c9c14cf38a3ce51c341899ba7bc92a5f7c6a2af`
- Modules: `mock_usdc`, `prediction_market`
- Publish transaction: `89uojuuT4nCiewG2ezJhKtQihr4AMmfPMUkPxftVLEJN`
- Deployer: `0x78f0be0d03f277c11d696436a3dd2f02c02f9cce118f6c0286fbc701a29ec411`

Mock USDC:

- Coin type: `0xa630b97e9c5f1cd9804553018c9c14cf38a3ce51c341899ba7bc92a5f7c6a2af::mock_usdc::MOCK_USDC`
- Decimals: `6`
- TreasuryCap: `0x16b34adda0f968ab481449d55f445d3598e0a617f2d6a83d62e84907be534aa1`
- Metadata object: `0x952435fcae9412796ddf2a9f0e173c9a2caba7b2f26079714a9e1a3bfd33a287`

Prediction market admin:

- AdminCap: `0x450d3450381a1f0fcbfbc0c354b8af4e7d0e7f732591bd6db57d5c14bf01105d`

## Repository Layout

```text
app/                    Next.js frontend
backend/                Express API and Sui local harness
pelagos_sui/            Sui Move package
public/                 Product assets
detailed.md             Production readiness roadmap
SUI_PARITY_PLAN.md      Current Sui parity status
.env.local.example      Frontend Sui env example
backend/.env.example    Backend Sui env example
```

## Quickstart

Prerequisites:

- Node.js 20+
- npm
- Sui CLI configured for testnet
- A Sui testnet account that owns the deployed package caps if you want to mint
  the existing mock USDC

Install dependencies:

```bash
npm install
(cd backend && npm install)
```

Configure env:

```bash
cp .env.local.example .env.local
cp backend/.env.example backend/.env
```

Then edit `backend/.env` if your local Sui keystore path differs:

```text
SUI_KEYSTORE_PATH=/path/to/.sui/sui_config
SUI_ACTIVE_ADDRESS=0x78f0be0d03f277c11d696436a3dd2f02c02f9cce118f6c0286fbc701a29ec411
```

Run the backend:

```bash
cd backend
npm run dev
```

Run the frontend in another terminal:

```bash
npm run dev
```

Open:

- Frontend: `http://localhost:13100`
- Portfolio: `http://localhost:13100/app/portfolio`
- Baskets: `http://localhost:13100/app/basket`
- Risk Slices: `http://localhost:13100/app/tranche`
- PPN: `http://localhost:13100/app/ppn`
- Distribution Markets: `http://localhost:13100/app/distribution`
- Backend status: `http://localhost:13101/api/sui/status`
- Distribution API: `http://localhost:13101/api/distribution/candidates`
- Monitor: `http://localhost:13102`

## Verification

Frontend build:

```bash
npm run build
```

Backend build:

```bash
cd backend
npm run build
```

Move tests:

```bash
sui move test --path pelagos_sui
```

Backend Sui status:

```bash
curl http://localhost:13101/api/sui/status
```

## Sui API Surface

Main local Sui routes:

- `GET /api/sui/status`
- `POST /api/sui/mock-usdc/mint`
- `POST /api/sui/markets`
- `POST /api/sui/markets/:marketId/buy`
- `POST /api/sui/markets/:marketId/resolve`
- `POST /api/sui/markets/:marketId/claim`
- `POST /api/sui/local/basket/deposit`
- `POST /api/sui/local/basket/redeem`

The `/api/sui/local/basket/*` routes are the current local bridge used by
basket, tranche, and PPN UI flows.

Distribution market routes:

- `GET /api/distribution/candidates`
- `POST /api/distribution/quote`
- `POST /api/distribution/launch-plan`

The distribution product is now dynamic. It pulls live Polymarket event groups,
filters out low-quality candidates with deterministic NLP, scores liquidity,
and exposes Paradigm-style discrete outcome bands for local launch planning.
Quotes treat the live curve as `f`, the submitted curve as `g`, and return the
terminal payout surface `g - f`; required collateral is the worst negative band.

## Documentation

- `detailed.md` - where the project stands and what is needed for production.
- `SUI_PARITY_PLAN.md` - current parity status and local architecture.
- `pelagos_sui/DEPLOYMENT.md` - deployed Sui package/object IDs.
- `backend/README.md` - backend-specific Sui setup.

## Production Roadmap

The short version:

1. Replace backend CLI signing with Sui SDK transaction builders.
2. Add real Sui wallet connect/signing in the frontend.
3. Build a Sui event/object indexer.
4. Replace browser-local virtual positions with indexed chain state.
5. Move basket, tranche, PPN, and distribution-market accounting into native
   audited Move modules.
6. Integrate DeepBook Predict or an explicit settlement source.
7. Add CI for frontend, backend, Move tests, browser e2e, and secret scanning.

Full roadmap: `detailed.md`.
