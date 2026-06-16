# Pelagos × DeepBook Predict — Integration Plan

> Status: research + merge complete, build not started. Authored 2026-06-16.
> Hackathon: DeepBook Predict track (DeepSurge). Min req: integrate the Predict
> contract on testnet, work end-to-end, and provide proper simulation results for
> a vault strategy.

## TL;DR

**Pelagos is already ~80% of a DeepBook Predict product that was never wired
together.** The pivot is *mechanical, not conceptual*: Pelagos's "Distribution
Markets" screen (a μ/σ Normal sold as a payoff strip) **is literally a strip of
DeepBook Predict `range` positions** over a BTC oracle. Point the existing,
already-wallet-signed distribution UI at the live SVI surface instead of the
simulated AMM and you have a real product.

**Recommendation: ship `Pelagos Range Desk` as the primary**, with the tokenized
`Strata` vault as a stretch. (Full ranking below.)

**Proven live this session:** the existing backend scaffold (`backend/src/services/predict/*`)
prices real BTC oracles on-chain via devInspect — see "Proof of life".

**The one hard blocker for a live write demo:** dUSDC is faucet-gated (manual
Tally form). Request it for 2 wallets *now*.

---

## 1. What DeepBook Predict is (grounded)

The third DeepBook primitive (after Spot and Margin). An expiry-based,
**SVI-vol-surface-priced** prediction/options protocol. Block Scholes feeds the
surface; the Predict server pushes second-level updates; Sui settles in <400ms.

Two instruments:
- **Binary** — `MarketKey{oracle_id, expiry, strike, is_up}` → pays $1/contract if
  `UP: settlement > strike` (or `DOWN: settlement ≤ strike`).
- **Range (vertical)** — `RangeKey{oracle_id, expiry, lower_strike, higher_strike}`
  (lower<higher) → pays $1/contract iff settlement ∈ `(lower, higher]`.
  `fair_range = up(lower) − up(higher)`.

**Counterparty = one shared PLP vault.** LPs `supply`/`withdraw` dUSDC for `PLP`
shares; `NAV = balance − total_mtm`. It takes the other side of every trade.

**Pricing:** per-unit prob from the SVI smile via `normal_cdf`;
`ask = fair + spread + utilization_adj` (base 2%, min 0.5%, util_mult 2×, clamped
[1%, 99%]). **Mint prices against post-trade state** (you pay for the liability you
add). UP+DOWN ≈ $1.017 live (the spread the PLP earns).

**Accounts:** each user has ONE shared `PredictManager` (wraps a DeepBook
`BalanceManager`; holds `Table<MarketKey,u64>` + `Table<RangeKey,u64>` as
**quantities, NOT NFTs**). The `owner` field gates mint/redeem/deposit/withdraw.
To "tokenize" positions you must own the *whole* manager (e.g. a vault object owns
it) and issue your own shares — there is no native position fractionalization.

**Lifecycle:** Inactive → Active → Pending settlement → Settled. Mint needs a live
oracle; after the first post-expiry price update spot freezes and only `redeem`
(owner) / `redeem_permissionless` (anyone) work.

### Key Move functions (no TS SDK — hand-roll PTBs; the scaffold already does)
```
predict::create_manager(ctx): ID
predict::mint<Quote>(predict, manager, oracle, MarketKey, qty, clock, ctx)
predict::redeem<Quote>(...) / redeem_permissionless<Quote>(...)   // settled = anyone
predict::mint_range<Quote>(predict, manager, oracle, RangeKey, qty, clock, ctx)
predict::redeem_range<Quote>(...)
predict::supply<Quote>(predict, Coin<Quote>, clock, ctx): Coin<PLP>
predict::withdraw<Quote>(predict, Coin<PLP>, clock, ctx): Coin<Quote>
predict::get_trade_amounts(...) / get_range_trade_amounts(...): (mint_cost, redeem_payout)  // devInspect
predict_manager::deposit<T> / withdraw<T> / position / range_position / balance
```

### Scales (the classic Predict bug — enforce in ONE place)
- strikes / spot / forward / **probabilities** = **1e9** fixed-point
- dUSDC cash (cost/payout/balances/vault) = **1e6** micro-dUSDC
- **quantity 1_000_000 = 1 contract = $1 payout**
- SVI params `a,b,rho,m,sigma` are raw ints with separate `*_negative` sign flags

---

## 2. Live testnet state (verified this session)

- **Package** `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138`
- **Predict object** `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a`
- **Registry** `0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64`
- **dUSDC** `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC` (6dp, faucet: https://tally.so/r/Xx102L)
- **Indexer** `https://predict-server.testnet.mystenlabs.com` (no auth)
- **Oracles:** BTC only, **22 active / 4,224 settled**, rolling expiries spaced **15 min**, strike grid `$50k min + $1k tick`.
- **PLP vault:** ~**$1.015M** TVL, share price **1.00184**, utilization **0.07%** (wide open).
- **516 managers** exist; the **Pelagos deployer `0x78f0be0d…` already owns a PredictManager** `0x5a35dbab…` (so `create_manager` already worked with our key) — but it holds **0 dUSDC**.

### Indexer endpoints that matter
`/oracles`, `/oracles/:id/{state,svi/latest,svi,prices/latest,prices}`,
`/predicts/:id/vault/{summary,performance}`,
`/managers/:id/{summary,positions/summary,pnl}`,
`/positions/{minted,redeemed}`, `/ranges/{minted,redeemed}`,
`/lp/{supplies,withdrawals}`, `/trades/:oracle_id`.
The `*/svi` + `*/prices` history + `settlement_price` + `vault/performance` are the
**backtest data source** (no funds needed).

---

## 3. Proof of life (this session)

`previewTrade` (devInspect of on-chain `get_trade_amounts`) against a live ATM BTC
oracle (37 min to expiry, spot ≈ $65,776):

| side | premium / unit | implied prob |
|------|----------------|--------------|
| UP   | $0.509         | 50.9%        |
| DOWN | $0.508         | 50.8%        |

UP+DOWN ≈ $1.017 (the spread). Linear in quantity. **The existing scaffold already
resolves correctly against the live protocol** — remaining work is *writes
(wallet-signed) + frontend + product logic*, not protocol plumbing.

---

## 4. Pelagos → Predict reuse/gap map

### REUSE as-is
- `backend/src/services/predict/{ptb,index,config,server,sui}.ts` — real, correct
  PTB layer + devInspect previews + typed indexer client. (Proven live.)
- `app/app/_lib/wallet-bridge.ts` — non-custodial dapp-kit prepare→sign→confirm.
- `app/app/_lib/curve.ts`, payoff-strip chart, `tokens.ts` — pure rendering.
- `pelagos_vault/sources/vault.move` — generic ERC4626; redeploy over **DUSDC** by
  type-arg only (no source edit) for the Strata stretch.

### ADAPT
- `app/app/distribution/page.tsx` + `_lib/distribution-continuous-client.ts` — the
  hero UX (μ/σ sliders, f-vs-g chart, payoff strip, prepare/sign/confirm). Repoint
  markets to `predictServer.predictOracles()`, repoint f(x) to the live SVI, replace
  single-open with the N-bucket strip mint.
- `backend/src/services/predict/index.ts` — add non-custodial `prepare/confirm`
  (copy `vault/index.ts buildAndDryRun` + `prepareDeposit`); add `previewRange`.
- `routes/predict.ts` — add `/range/preview`, `/range/open/{prepare,confirm}`,
  `/range/redeem/prepare` (the existing write routes are custodial).

### DELETE (from the product path)
- Simulated AMM (`distribution-continuous.ts quoteCore`), `drawNormal` fake
  settlement, `mintMockUsdc`-as-payout, the JSON position store.
- Polymarket sourcing (`distribution.ts` polymarket bits, `polymarket.ts`,
  `market-filter.ts`, `proxy.ts` relay if unreferenced).
- Market Baskets (`live-baskets.ts`, `bundles`, `basket/`).
- `prediction_market.move` + `mock_usdc.move` from the live path.
- The fabricated chain layer (`pelagos-chain.ts` sha256 ids, `onchain-bridge.ts`
  fake tx_signature) — must not be in the demo flow.

### Collateral & custody
- **Collapse to dUSDC** as the single quote asset. (vault.move is generic → redeploy
  over DUSDC; repoint `useUsdcBalance` + faucet to dUSDC.)
- **Custody:** MVP = non-custodial per-user `PredictManager` (`owner = wallet`),
  using the proven vault prepare/sign/confirm pattern. (The current backend predict
  writes — and the teammate's `/predict` page — are *custodial* backend-signed.)

---

## 5. Current state including teammate's merged work

Merged `sui/main` → `Tharun-Pelagos` (commit `3d1e991`). The teammate added an
**end-to-end binary `/predict` surface**:
- `app/app/predict/page.tsx` — a BTC binary up/down screen: asset = BTC, contracts
  input, UP/DOWN toggle, **live debounced quote** via `/api/predict/quote`
  (devInspect — works now, no funds), create-manager + mint/redeem buttons.
- `app/app/_lib/predict-client.ts` — wraps `/api/predict/*`.
- `backend/src/routes/predict.ts` — new `GET /api/predict/quote` (find active oracle
  → snap strike → previewTrade).
- `Header.tsx` — nav link.

**This is the *binary* angle and is *custodial* (backend-signed; writes need the
backend wallet to hold dUSDC).** It's a working partial-MVP. The recommended primary
(`Range Desk`) is the *distribution/range* angle and is *non-custodial*. They are
complementary: binary tab + range tab can coexist, sharing `predict-client.ts`, the
indexer, and the oracle/quote plumbing.

---

## 6. Recommended product + ranking

### Ranking (Pelagos fit · feasibility · judge legibility · differentiation · meets-min-req)
1. **Pelagos Range Desk** — *primary*. 82% reuse, ~3 days. Reskin the distribution
   screen to mint REAL Predict ranges from the wallet. Only new code ≈120 lines
   (μ/σ → on-grid buckets). Lowest debug surface → highest polish ceiling.
2. **Pelagos Strata** — *strongest story, highest risk*. Same UX + a tokenized
   `VaultShare` that "moves", auto-rolled. Its differentiator (a **new Move module
   where the vault owns a PredictManager**) is net-new code + tests, a 2–3d critical
   path. **Fold in as the stretch on top of Range Desk**, not load-bearing.
3. **Pelagos Surface** (analytics/risk studio) — safest, least differentiated.
   Donate its SVI-replay + PLP-NAV panel as a supporting tab.
4. **Streak** (binary game + settlement keeper) — most fun, worst Pelagos reuse
   (~45%); the distribution UX doesn't transfer. Keeper alone is a nice add-on.

### Recommendation
Ship **Range Desk** as primary + two supporting components that share its code:
**(A)** an LP "be the house" tab (`supply`/`withdraw` vs the live PLP vault — builders
already exist), and **(B)** a thin SVI-surface + PLP-NAV strip (visual proof f(x) is
the *real* on-chain surface). Sequence **Strata's** tokenized vault + auto-roll as
upside. The teammate's binary page rides along as a secondary "single-strike" tab.

---

## 7. MVP scope (definitely demoable)
1. Market picker from `predictServer.predictOracles()` (active BTC, soonest expiry).
2. μ/σ sliders + DistChart, with **f(x) repointed to the live SVI** (`/oracles/:id/svi/latest`).
3. `range-strip.ts` (~120 lines): μ/σ Normal → N adjacent on-grid buckets
   (`snapStrikeToGrid` + `tick_size`, N capped 5–7), density→budget allocation,
   one `previewRange` per bucket → payoff strip.
4. `previewRange()` in `services/predict/index.ts` (devInspect over `get_range_trade_amounts`).
5. **OPEN (one signature):** backend `prepareMintRangeBundle()` builds `deposit + N×mint_range`
   in one PTB → `tx.toJSON()`; frontend signs via `useWalletSigner`; first-open
   auto-creates the manager.
6. Portfolio + EXIT from indexer; `redeem_range` (live) / `redeem_permissionless` (settled).
7. LP tab: `supply`/`withdraw` + live NAV from `/vault/summary`.
8. A pre-staged **already-settled** oracle so `redeem_permissionless` pays $1 on stage.
9. Static **backtest panel** (SVI-replay equity curve + hit-rate/spread/Sharpe table).

## 8. Stretch scope
1. Redeploy `vault.move` over DUSDC (type-arg only) → transferable `VaultShare<DUSDC>`.
2. New `strata` Move module: vault OWNS a PredictManager — `build_strip` / `harvest` /
   `roll`. **2–3d critical path — only after MVP is green.**
3. Auto-roll keeper (operator cron) + manual "force roll" admin button.
4. SVI "replay" control (walk `/oracles/:id/svi` history — the smile breathing).
5. PLP risk panel (NAV waterfall, utilization gauge, max-payout stress tile).
6. Settlement keeper across the 4,224-oracle backlog (`redeem_permissionless`).

## 9. Sprint
- **Day 0 (blocks live leg):** submit dUSDC faucet (https://tally.so/r/Xx102L) for
  2 wallets; verify funds land. Pricing/backtest need none.
- **Day 1 AM:** `previewRange()` backend. *Verify:* curl returns
  `fair_range = up(lower)−up(higher)` matching hand-computed `normal_cdf`.
- **Day 1 PM:** `prepareMintRangeBundle()` + non-custodial `/range/*` routes (copy
  `vault/index.ts`). *Verify:* `/range/open/prepare` returns valid tx_bytes; dry-run resolves.
- **Day 2 AM:** `range-strip.ts` + unit test (weights sum to budget, on-grid, lower<higher).
- **Day 2 PM:** copy distribution page → Range Desk route; repoint markets + f(x);
  strip-mint via prepare→sign→confirm; first-open auto-create+fund. *Verify (no funds):*
  preview renders live per-bucket prices as σ drags.
- **Day 3 AM:** LIVE on testnet with funded wallet — create+deposit → one-sig strip
  mint → portfolio → `redeem_range` sell; pre-staged settled oracle `redeem_permissionless`.
  *Verify:* digests resolve on Suiscan; PnL matches indexer.
- **Day 3 PM:** LP supply/withdraw tab + SVI/NAV strip; execute delete list; run
  design-review skill. *Verify:* supply digest moves `plp_share_price` live.
- **Stretch (if green):** DUSDC vault redeploy + `strata` Move + force-roll button.

## 10. Simulation / backtest design (the "proper simulation results")
Pure indexer reads, zero on-chain spend, reproducible.
- **Inputs:** enumerate the 4,224+ settled BTC oracles (`expiry, min_strike,
  tick_size, settlement_price`); per oracle pull historical `/svi` (surface at
  mint-time), `/prices` (forward anchor), `settlement_price` (realized), and
  `/predicts/:id/vault/performance` (PLP share-price benchmark).
- **Method:** at each oracle's activation SVI snapshot, recompute per-unit prob with
  the SAME `normal_cdf`-over-SVI-total-variance the contract uses; price each on-grid
  bucket `fair_range = up(lower)−up(higher)`; add spread/utilization → mint cost.
  Build the N-bucket strip for a fixed μ/σ policy; pay $1/contract to buckets whose
  band contains `settlement_price`. Chain epochs → rolled NAV curve.
- **Validation gate (trust signal):** assert offline `fair_range` matches the live
  contract's `get_range_trade_amounts` within rounding.
- **Outputs:** strategy rolled share-price vs the PLP vault's real performance;
  table of hit-rate / mean epoch return / avg spread (~1.7%) / Sharpe / max DD across
  thousands of expiries; an N × σ efficient-frontier sweep; a calibration scatter +
  Brier score (the "spread is the house edge" LP story).

## 11. Demo script (~2.5 min)
1. "Predict lets you bet above/below ONE BTC strike. Range Desk lets you express your
   whole *view* of where BTC lands — minting the right basket of real range-options in
   one signature."
2. Pick live "BTC, ~40-min expiry" (real testnet oracle).
3. Drag μ right (bullish): f(x) shifts — "**this curve is the ACTUAL on-chain SVI
   surface now**" — payoff strip lights green.
4. Drag σ wide: distribution fans out; 6 strike buckets populate with LIVE per-bucket
   prices (devInspect, no funds yet).
5. "Open position" — ONE signature mints all 6 `mint_range`; Suiscan resolves the tx.
6. Portfolio: live marks; "Sell" one rung → `redeem_range` digest resolves.
7. Pre-staged SETTLED oracle → Claim → `redeem_permissionless` pays $1/contract on-chain.
8. LP tab: "or be the house" — Supply, sign, PLP NAV ticks up live.
9. **Killer close:** the backtest panel — strategy rolled share-price overlaid on the
   PLP vault's real history across thousands of settled BTC expiries + hit-rate/spread/
   Sharpe. "Live mints, real settlement, and a backtest on the protocol's own history."

## 12. Risks
- **dUSDC faucet is manual and the only hard blocker for live writes** — pre-provision 2 wallets.
- **Mint prices against post-trade state** — re-preview right before signing; util ~0.07% so drift is tiny now.
- **Scale mismatch (1e9 vs 1e6)** — enforce once, unit-test, validate vs live `get_range_trade_amounts`.
- **SVI sign/scale decode** — validate the smile vs live `previewTrade` asks before trusting f(x)/backtest.
- **First-open must create AND fund the manager** — fall back to a one-time `create_manager` (≤2 sigs).
- **15-min expiries won't settle inside a judging slot** — pre-stage a settled oracle.
- **Non-standard Next.js fork** (see `AGENTS.md`) — copy the distribution page; add no new Next patterns.
- **Stretch Move risk** — vault-owns-manager is net-new; MVP must not depend on it.
- **Testnet-only + mainnet redeploy** — every id is env-overridable in `config.ts` (one-line repoint).
- **Backend predict writes are custodial today** — non-custodial wrapping is ~1d (copy vault pattern).

## 13. Open decisions (recommended defaults in **bold**)
1. **Primary product:** **(A) Range Desk primary, Strata as stretch** / (B) Strata from day 1.
2. **Redeploy vault over DUSDC:** **(A) only for the Strata stretch** / (B) now.
3. **Tranches / PPN:** **(A) cut from this submission** / (B) keep a tab.
4. **Custody model:** **(A) non-custodial per-user manager** / (B) custodial backend (matches teammate's current page).
5. **Keeper / auto-roll:** **(A) manual force-roll button** / (B) full operator cron + settlement keeper.
6. **Strip width N:** **(A) cap 5–7 buckets** / (B) up to ~12.
7. **Branding:** **(A) "Pelagos Range Desk"** / (B) "Pelagos Strata" if vault-primary.
8. **Teammate's binary page:** **(A) keep as a secondary "single-strike" tab** / (B) drop it.

---

## 14. LOCKED SCOPE (2026-06-16) — full suite, fresh on-chain, DeepBook-central

Decisions made by the user:
- **Full product suite** (not Range-Desk-only): Distribution Markets, Tranches, PPN, and **both** basket kinds — keep Polymarket uncorrelated-event baskets **but drop the ~50% (coin-flip) basket and replace it with DeepBook BTC structured baskets**.
- **Collateral split:** **dUSDC** for everything that touches Predict (required); a fresh, freely-mintable **mock USDC** for the non-Predict (Polymarket) baskets so they're testable without the faucet.
- **PPN floor → DeepBook PLP vault** (`predict::supply`), upside → Predict ranges. ("routing to another protocol surface", all on testnet.)
- **Custody:** non-custodial (user wallet owns the PredictManager, wallet-signed).
- **Fresh on-chain deploy** under a new user-funded wallet. **Theme preserved** (Tidal).

### Per-product on-chain design
| Product | Engine | Collateral |
|---|---|---|
| Distribution Markets | μ/σ → `previewStrip` → wallet-signed `mint_range` strip; settle via `redeem_range`/`redeem_permissionless` | dUSDC |
| Tranches (Risk Slices) | senior/mezz/junior claims on a vault holding a range strip | dUSDC (vault redeployed over dUSDC) |
| PPN | floor → `predict::supply` (PLP yield) + upside → range strip | dUSDC |
| Baskets — DeepBook | a bundle of Predict structures across strikes/expiries (replaces the 50% basket) | dUSDC |
| Baskets — Polymarket | uncorrelated-event baskets, settled on our own market/vault | mock USDC |

### Fresh deploy plan (under the new wallet)
1. `mock_usdc` (fresh publish) — freely-mintable test collateral for Polymarket baskets.
2. `pelagos_vault` redeployed (generic `Vault<T>` — instantiate over **dUSDC** for the Predict-backed products; a second instance over mock USDC for Polymarket baskets if needed).
3. (stretch) `pelagos_structurer` Move module — a vault that OWNS a PredictManager (`build_strip`/`harvest`/`roll`) for the tokenized auto-rolling story; MVP can use per-user managers + the vault as a wrapper.
4. Repoint `backend/.env` + `app/.env.local` to the new package/object IDs (all already env-overridable).

### Engine status (built + live-verified this session)
- `backend/src/services/predict/ptb.ts` — `addGetRangeTradeAmounts` added.
- `backend/src/services/predict/index.ts` — `previewRange` (devInspect) added & proven live.
- `backend/src/services/predict/structured.ts` (NEW) — strip math (`buildStripBuckets`, normal-CDF weights), `previewStrip` (resilient, skips out-of-ask-bounds bands, quantity∝Normal-weight sizing), non-custodial `prepareCreateManager`/`prepareMintStrip`/`prepareRedeemRange`/`preparePlpSupply`/`preparePlpWithdraw`, `confirmPredictDigest`. Live-verified pricing.
- `backend/src/routes/predict.ts` — non-custodial routes: `POST /api/predict/strip/preview`, `/manager/prepare`, `/strip/open/prepare`, `/range/redeem/prepare`, `/lp/supply/prepare`, `/lp/withdraw/prepare`, `/confirm`.

### What's needed from you to deploy (do while I build Move + frontend)
1. **New Sui testnet wallet** (the on-chain owner). Easiest: `! sui client new-address ed25519` then `! sui client switch --address <new>`; fund gas at the Sui testnet faucet. Put its key where the backend signer reads it: `SUI_PRIVATE_KEY=suiprivkey...` (and `SUI_ACTIVE_ADDRESS=0x...`) in `backend/.env`.
2. **Request dUSDC** for that wallet: https://tally.so/r/Xx102L (manual; the only hard blocker for live Predict writes).
3. Tell me the address; I'll publish the packages and wire the IDs.

### Remaining build sequence
- [x] Backend Predict structured-product engine (this session).
- [ ] Move: fresh `mock_usdc` + `pelagos_vault` over dUSDC (+ optional `structurer`), build + tests.
- [ ] Frontend: wire Distribution/Tranches/PPN/baskets to the engine, drop the 50% basket + add DeepBook baskets, keep theme.
- [ ] Deploy under the new wallet + live end-to-end (needs dUSDC).
- [ ] In-depth docs + the indexer backtest panel.
