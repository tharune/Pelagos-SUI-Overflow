# Pelagos — Architecture

Pelagos packages prediction-market outcomes into structured products on **Sui testnet**, priced off
real on-chain liquidity (DeepBook Predict + Polymarket CLOB) and minted via **wallet-signed**
programmable transaction blocks. The backend is a pricing/orchestration layer that builds *unsigned*
transactions — it never custodies user funds.

## Topology

```text
Next.js frontend  :13100   (forked Next.js; app dir = app/app/)
      │  wallet-signed PTBs (@mysten/dapp-kit)
      ▼
Express API       :13101   ── builds UNSIGNED tx_bytes; non-custodial
      ├── DeepBook Predict (Mysten testnet) ── range pricing · SVI surface · native settlement
      ├── Polymarket Gamma + CLOB           ── basket markets + midpoint pricing
      ├── DeFiLlama                         ── live Sui USDC lending APY (protected notes)
      ├── Coinbase                          ── BTC spot (CEX price reference)
      ├── Supabase                          ── persistence (bundles, positions)
      └── Sui RPC                           ── pelagos_sui / _vault / _strategies moveCalls
      │
      └── Monitor   :13102   ── process / API / on-chain / market-filter metrics
```

## On-chain packages (Sui testnet · chain `4c78adac`)

| Package | Modules | Role |
|---|---|---|
| `pelagos_sui` | `mock_usdc`, `prediction_market` | freely-mintable test collateral + binary markets |
| `pelagos_vault` | `vault` | generic `Vault<T>` (NAV share-price); baskets + Predict-backed wrappers |
| `pelagos_strategies` | `structured_note` | principal-protection floor + admin settlement |
| DeepBook Predict (Mysten) | — | range markets we price against + settle on (not deployed by us) |

Deployed IDs live in **`DEPLOYMENT.md`**. Pricing uses the protocol's own `get_range_trade_amounts`
(real MM bid/ask + slippage); a mintable-band filter ([2%, 98%]) keeps every surfaced bucket actually
mintable. Settlement is native to DeepBook Predict (oracle settles → permissionless `redeem_range`).

## Why Sui (architectural dependencies)

The design leans on Sui-specific primitives — it is not chain-agnostic:

- **DeepBook Predict** (Mysten, Sui-native) is the pricing + settlement venue for every option / vol /
  range-strip / PPN-upside leg. No equivalent on-chain range/options primitive exists elsewhere to
  build this against.
- **Programmable Transaction Blocks** make each multi-leg product a *single* wallet signature — e.g. a
  PPN that splits dUSDC into a PLP-floor supply **and** an N-leg upside strip mint atomically, or the
  combined mUSDC+dUSDC+SUI faucet PTB.
- **`devInspect`** prices every strip band against live vault state (real MM bid/ask + slippage) with
  zero gas and no write — the source of all pre-trade quotes.
- **Object model** — positions are owned objects (`VaultShare<T>`, `NotePosition<T>`, minted ranges),
  transferable and composable rather than ledger rows.
- **Parallel execution + shared objects** (Vault, Predict root, Faucet) give the responsive,
  low-gas, wallet-signed UX; **Sui DeFi** (Bluefin / DeepBook CLOB / Pyth; Suilend / Navi / Scallop /
  Kai) supplies the BTC mark and the protected-note yield.

## Backend engines (`backend/src/services`)

- **`options-chain`** — the BTC options chain: each strike priced off DeepBook Predict range liquidity,
  IV from the live SVI smile, depth/risk caps per strike.
- **`predict/`** — SVI surface, implied density, range-strip pricing + mint PTBs (the shared core under
  Distribution Markets, Volatility, *and* Range Strips).
- **`volatility`** — prebuilt vol structures + greeks.
- **`custom-basket` / `baskets` / `market-filter` / `nlp`** — Polymarket discovery → 5-stage NLP quality
  filter → correlation-decorrelated weighting → tranching.
- **`deepbook` / `notes` / `notes-allocation`** — prebuilt range strategies + protected-note DeFi-yield sleeve.
- **`vault/` · `sui` · `pelagos-chain`** — on-chain moveCall / PTB builders.

The live API surface is ~30 route groups mounted under `/api/*` (see `backend/src/index.ts`).

## Frontend (`app/app`)

Forked Next.js (App Router; routes under `app/app/` — see `AGENTS.md`). A global **Basic/Advanced**
mode (`_lib/mode.tsx`) and **light/dark** theme (`_lib/theme.tsx`) reskin every product; both support a
`?mode=` / `?theme=` deep-link override. One product page per tab, with typed backend clients in
`app/app/_lib/`.

## Verify

```bash
(cd app && npx tsc --noEmit)
(cd backend && npx tsc --noEmit)
(cd pelagos_strategies && sui move test)
curl http://localhost:13101/api/health
curl http://localhost:13102/data
```
