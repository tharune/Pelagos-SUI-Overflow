# Pelagos Backend

Express + TypeScript backend for the Pelagos Sui local testnet harness.

The active Sui path is exposed under `/api/sui`, with product-level
distribution-market routes under `/api/distribution`. These wrap the deployed
`pelagos_sui` Move package, mock USDC, and local prediction-market actions
used by the frontend demo.

## Quickstart

```bash
npm install
cp .env.example .env
npm run dev
```

Backend:

- API: `http://localhost:13101`
- Monitor: `http://localhost:13102`
- Sui status: `http://localhost:13101/api/sui/status`
- Distribution candidates: `http://localhost:13101/api/distribution/candidates`

## Environment

Use `backend/.env.example` as the source of truth for local Sui mode.

Important values:

- `SUI_NETWORK=testnet`
- `SUI_RPC_URL=https://fullnode.testnet.sui.io:443`
- `SUI_CLI=sui`
- `SUI_KEYSTORE_PATH=/path/to/.sui/sui_config`
- `SUI_ACTIVE_ADDRESS=<local testnet address>`
- `SUI_PACKAGE_ID=0x598434be38a69bf97b70490d320a698445990de38eb36e2f4c9d41dbe1ff3e45`
- `SUI_MARKET_ADMIN_CAP_ID=0x450d3450381a1f0fcbfbc0c354b8af4e7d0e7f732591bd6db57d5c14bf01105d`
- `MOCK_USDC_TREASURY_CAP_ID=0x16b34adda0f968ab481449d55f445d3598e0a617f2d6a83d62e84907be534aa1`

Supabase can be left unset for local Sui mode. The health endpoint reports
Supabase as `not_configured` while keeping the overall status `ok`.

## Sui Routes

- `GET /api/sui/status`
- `POST /api/sui/mock-usdc/mint`
- `POST /api/sui/markets`
- `POST /api/sui/markets/:marketId/buy`
- `POST /api/sui/markets/:marketId/resolve`
- `POST /api/sui/markets/:marketId/claim`
- `POST /api/sui/local/basket/deposit`
- `POST /api/sui/local/basket/redeem`

The `local/basket` routes are also used by current PPN and tranche UI flows.

## Distribution Routes

- `GET /api/distribution/templates`
- `GET /api/distribution/candidates`
- `POST /api/distribution/quote`
- `POST /api/distribution/launch-plan`

These routes support the Distribution Markets tab. The backend pulls live
Polymarket market groups, applies deterministic NLP quality/category scoring,
checks volume, CLOB depth, spread, and time-to-resolution, then returns
launchable outcome bands and quote analytics. The reference curve is the
normalized CLOB-implied probability vector, while liquidity is tracked as a
separate confidence/depth signal. Quote responses model the user position as
`target - reference`; the collateral requirement is the maximum negative payout
across resolution bands. `/templates` is kept only as a compatibility alias for
`/candidates`.

## Build

```bash
npm run build
```

## Production Notes

This backend currently shells out to the Sui CLI and signs local testnet actions
with the configured Sui dev key. Production should replace that with:

- Sui TypeScript SDK transaction builders.
- Wallet-signed programmable transaction blocks for user actions.
- A Sui event/object indexer.
- Persistent portfolio state from indexed chain objects.
- Sui-native monitor metrics for package health and indexer lag.

See the root `README.md` and `ARCHITECTURE.md` for the full product + topology overview.
