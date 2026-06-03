# Pelagos on Sui Status

Goal: keep the Pelagos product behavior intact while running the local
hackathon build against Sui testnet assets and Move contracts.

## Done

- Sui CLI installed and configured for testnet.
- Sui v2 package deployed with:
  - `mock_usdc::MOCK_USDC`
  - `prediction_market` using Mock USDC collateral
- Backend local Sui routes added under `/api/sui`.
- Canonical Sui env examples created:
  - `.env.local.example`
  - `backend/.env.example`
- Active local env copied into:
  - `.env.local`
  - `backend/.env`
- Backend Sui smoke test passed through localhost API:
  - mint mUSDC
  - create market
  - buy YES and NO
  - resolve YES
  - claim winning payout
- Frontend Sui local mode added:
  - header shows the Sui testnet dev account
  - basket buy creates a real Sui testnet market, mints mock USDC, and buys a
    Sui position object
  - basket sell resolves and claims that Sui position object
  - local portfolio state stores Sui market/position ids for UI continuity
- Browser-tested `/app/basket/PBU-HIGH-SHORT` end to end:
  - buy position created a Sui Explorer-linked transaction
  - sell used the Sui redeem harness and cleared the local held balance
- Browser-tested PPN and tranche flows end to end:
  - PPN open creates a Sui-backed local vault position and displays the Sui
    transaction digest
  - PPN close resolves/claims the backing Sui position and removes the row
  - tranche buy creates a Sui-backed local position
  - tranche sell executes the local Sui resolve/claim path and clears the lot
- Backend and frontend build cleanly in Sui local mode.
- Sui Move package tests pass.
- Legacy tracked example secrets were sanitized before publishing.

## Local Sui Architecture

- The deployed Move package owns the mock-USDC mint cap and prediction-market
  entry points used by the local backend.
- The backend exposes `/api/sui/*` routes and signs local testnet actions with
  the configured Sui dev key.
- The frontend runs with `NEXT_PUBLIC_CHAIN=sui`; wallet UI shows the Sui
  dev account, portfolio cash reads from `/api/sui/status`, and basket, tranche,
  and PPN actions call the Sui local routes.
- Browser-local position metadata preserves the Pelagos UX while the Move
  objects provide testnet transaction evidence.

## Productionization Notes

- The current build is intentionally a local hackathon harness. For production,
  swap CLI-backed backend signing for Sui wallet/user-signed PTBs and replace
  the local position bridge with an event/object indexer.
- The active docs, env examples, monitor, and Move package are Pelagos/Sui.
  Dormant compatibility modules remain only where current TypeScript imports
  still require them to preserve the existing UI behavior.
