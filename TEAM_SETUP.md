# Team setup — pick up where we left off

Everything needed to **run** Pelagos is committed (private repo): the `.env`
files hold the Supabase URL + anon key and all public on-chain IDs. Two things
are intentionally **not** in git (private keys) — see "Signing access" below.

## 1. Install & run

```bash
# from repo root
npm install                 # frontend deps
cd backend && npm install   # backend deps
cd ..

# terminal 1 — backend (port 13101)
cd backend && npm run dev

# terminal 2 — frontend (port 13100)
npm run dev
```
Open http://localhost:13100. Backend health: http://localhost:13101/api/health

## 2. What's already wired (committed in `.env` / `backend/.env`)

- **Supabase** — project `fhklafbywulainknvuyp`, anon key included. Bundles + live
  Polymarket legs already seeded; reads + writes work out of the box.
- **On-chain (Sui testnet)** — every package + object ID is committed in `backend/.env`
  and documented in **[`DEPLOYMENT.md`](DEPLOYMENT.md)** (live deploy 2026-06-16:
  `pelagos_sui` `0x598434be…`, `pelagos_vault` `0xcaff49f8…`, `pelagos_strategies`
  `0x30932e4e…`, deployer/admin wallet `0xcad0f800…`). DeepBook Predict is Mysten's
  testnet protocol — we call it, don't deploy it.
- **Data sources** — DeepBook Predict, Polymarket (Gamma + CLOB), DeFiLlama, Coinbase,
  Sui RPC — all live, no keys needed.

## 3. Signing access — everything is in `backend/.env`

This is a **private** repo, so all credentials for this project are committed so
you can work with the full stack immediately:

- **`SUI_PRIVATE_KEY`** — the `pelagos-deployer` testnet key. The backend signer
  reads this first, so admin / mint / the dev faucet endpoint all work on clone.
  (Only THIS project's deployer key is included — not the rest of Tharun's Sui
  keystore.) On clone it just works; no `sui` CLI keystore needed.
- **`DATABASE_URL`** — Supabase Postgres **session pooler** (IPv4) for schema /
  seed / DDL via `psql`. The app itself uses the anon key and doesn't need this;
  it's here so you can run migrations/seeds. (The direct `db.<ref>` host is
  IPv6-only and won't connect on most machines — use this pooler string.)

The non-custodial deposit/redeem flow is signed by the **end user's own wallet**
(connect a Sui testnet wallet → "Get test mUSDC" faucet → deposit). The deployer
key above only powers admin/mint/faucet server-side actions.

> ⚠️ **TESTNET only** — no real funds. Before this repo ever goes public, scrub
> `backend/.env` (`SUI_PRIVATE_KEY`, `DATABASE_URL`, `SUPABASE_ANON_KEY`) from
> the working tree **and git history** (e.g. `git filter-repo`), and rotate them.

## 4. Optional

- **`ANTHROPIC_API_KEY`** — currently empty; `/api/portfolio/construct` runs its
  deterministic fallback until a key is set.

## 5. Useful scripts (backend)

```bash
npx tsx --tsconfig ./tsconfig.dev.json src/scripts/smoke-vault.ts 5   # real deposit+redeem
npx tsx --tsconfig ./tsconfig.dev.json src/scripts/reseed-and-clean.ts # clean + reseed legs from live markets
```
