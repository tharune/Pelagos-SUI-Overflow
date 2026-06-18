# Pelagos — Session handoff (2026-06-18)

Snapshot of where the build stands so a fresh session can pick up cold. For the
permanent docs see **[README.md](README.md)** (product), **[ARCHITECTURE.md](ARCHITECTURE.md)**
(topology), **[DEPLOYMENT.md](DEPLOYMENT.md)** (canonical on-chain IDs), and
**[TEAM_SETUP.md](TEAM_SETUP.md)** (clone-and-run + credentials).

## TL;DR state

- **Working end-to-end on Sui testnet.** Non-custodial: backend builds unsigned
  PTBs, the user's wallet (`@mysten/dapp-kit`) signs.
- **Git:** working tree clean, fully pushed to remote `sui` (`Tharun-Pelagos`). Last
  commit `fcef045`.
- **Builds:** frontend `tsc --noEmit` clean, backend `tsc --noEmit` clean.
- **Servers (currently running locally):** frontend `:13100`, backend `:13101`.
- **Backend health = "degraded" is expected** — the only failing service is the
  external **Polymarket** API (`fetch failed`); Supabase is `ok`. Nothing of ours
  is broken by that flag.

## Run it

```bash
# terminal 1 — backend (:13101)
cd backend && npm run dev
# terminal 2 — frontend (:13100)
npm run dev
```
- App: http://localhost:13100  ·  Health: http://localhost:13101/api/health
- Dual-mode UI: append `?mode=basic` / `?mode=advanced` (and `?theme=` to force).
- ⚠️ This is **Next.js 16** (forked) — app dir is `app/app/`, conventions differ.
  Read `node_modules/next/dist/docs/` before touching framework APIs (see AGENTS.md).

## The two product surfaces (where the recent work was)

1. **Distributed Options** — `app/app/distribution/page.tsx`
   - Binary digital options chain on **DeepBook Predict** RANGE markets ($1 payout
     if settlement lands in the band). CALL @ K = `[K, far]`, PUT @ K = `[floor, K]`;
     `call_mid + put_mid ≈ 1.00`. Verified arb-free vs Black-Scholes `N(d2)` at the
     displayed SVI IV (<1¢), and cross-checked offline against Deribit.
   - Pricing: `backend/src/services/options-chain.ts` via `previewRangeBatch`;
     near-expiry degeneracy floored at `MIN_TIME_TO_EXPIRY_MS = 12min`.
   - Liquidity caps: `/api/options/depth` (`getBandDepth`) — slippage ≤15% AND ≤2%
     of pool. On testnet the pool cap binds ~20k contracts.
   - Basic + Advanced offer the **same markets / same liquidity**, no arb between modes.
   - Most recent fix: selected-strike highlight is a clean fill + outer-edge accent
     bar (no floating inset border).

2. **Volatility desk** — `app/app/volatility/page.tsx`
   - Strategies: straddle / strangle / butterfly / iron-condor, replicated as
     DeepBook Predict range strips (`previewStrip`), native Predict settlement.
   - Basic desk reworked: 4-stat metrics box + separate live-price box, payoff chart
     fills the column, plain-English thesis, structure section highlights the exact
     legs (IN-PROFIT band tagged). Quotes re-fetch per strategy + per timeframe.
   - Execute flow has an **optional delta-neutral hedge** toggle in the modal before
     the user signs the TX.
   - 3D vol surface: `app/app/volatility/_components/VolSurface3D.tsx` (auto-framed camera).

## On-chain (testnet, deploy 2026-06-16 — see DEPLOYMENT.md for all IDs)

- `pelagos_sui` (mock_usdc + prediction_market) `0x598434be…`
- `pelagos_vault` `0xcaff49f8…` — `Vault<MOCK_USDC>` + `Vault<dUSDC>` shared
- `pelagos_strategies` (structured_note) `0x30932e4e…` — **deployed but unwired** (no UI)
- DeepBook Predict is **Mysten's** testnet protocol — we call it, never redeploy it.
- Deployer/admin wallet `0xcad0f800…`.

## Known / pending (nothing blocking; decide next session)

- **Lending** — backend route + a Portfolio allocation row exist, but there's no UI
  page. Keep stub or build out.
- **`pelagos_strategies`** — deployed, not surfaced in the UI.
- **Polymarket external API** — intermittently `fetch failed`; only affects the
  Distribution-candidates feed, surfaces as health "degraded".
- **`ANTHROPIC_API_KEY`** — empty; `/api/portfolio/construct` runs its deterministic
  fallback until set.
- **`FIX-PPN-MIGRATION.sql`** (root) — one-paste Supabase migration helper (folds
  `schema_ppn_onchain.sql` + `schema_tranche.sql`); kept intentionally as an op aid.

## Conventions to preserve

- Deribit stays **out of the product** — offline cross-check only.
- Don't touch Mysten DeepBook Predict shared infra IDs.
- Commits authored + signed under the user's own identity only; no AI attribution.
- `.env` is gitignored (private repo holds testnet creds per TEAM_SETUP.md); no secrets in history.
