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
- `SUI_PACKAGE_ID=0xd97616b19d16c944cb5f5f4d22c471df3d4ea1640764b46a2be2587a4be890cd`
- `SUI_MARKET_ADMIN_CAP_ID=0x54fcbdf626ff5474298e0b5f9859a9e6259f27ef63d248487a2db42e3cc88ec3`
- `MOCK_USDC_TREASURY_CAP_ID=0x190323bf43fb743f3ccf153ebbb978acfb3a86b5c60643228a1a2f4d0445b5c7`

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

See the root `detailed.md` for the full production-readiness plan.
