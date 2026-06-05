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
Open http://localhost:13100. Backend health: http://localhost:13101/api/sui/status

## 2. What's already wired (committed in `.env` / `backend/.env`)

- **Supabase** — project `fhklafbywulainknvuyp`, anon key included. 9 bundles /
  90 live Polymarket legs already seeded; reads + writes work out of the box.
- **On-chain (Sui testnet)** — the live vault is configured:
  - `VAULT_PACKAGE_ID` `0xa88c4e60…cdb670`, `VAULT_OBJECT_ID` (shared
    `Vault<MOCK_USDC>`) `0xeb8402f9…81e3fd`, `VAULT_ADMIN_CAP_ID` `0xafe1cf30…`
  - mock-USDC package `0xa630b97e…a2af`, TreasuryCap, AdminCap, metadata.
  - deployer/admin wallet `0x78f0be0d…29ec411`.
- **Data sources** — Polymarket (Gamma + CLOB), DefiLlama, Sui RPC — all live, no keys needed.

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
