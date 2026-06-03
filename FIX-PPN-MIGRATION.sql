-- =============================================================================
-- PPN + TRANCHE MIGRATION
-- =============================================================================
-- Paste the whole thing into Supabase SQL Editor (https://supabase.com/dashboard
-- -> your project -> SQL Editor -> New query) and hit Run.
--
-- Safe to re-run: every ALTER/CREATE uses IF NOT EXISTS. Applies two additive
-- migrations in one shot:
--   1) schema_ppn_onchain.sql  (note_seed_hex, onchain_tx_signature,
--                               redemption_tx_signature, maturity_ts)
--   2) schema_tranche.sql      (tranche_kind, tranche_attach, tranche_detach,
--                               price_per_token)
--
-- Without these columns, /api/ppn/onchain/prepare crashes with:
--   "Could not find the 'maturity_ts' column of 'ppn_vaults' in the schema cache"
-- which surfaces in the UI as "Failed to persist PPN vault record".
-- =============================================================================

-- ---------- schema_ppn_onchain.sql ----------
alter table ppn_vaults add column if not exists note_seed_hex text;
alter table ppn_vaults add column if not exists onchain_tx_signature text;
alter table ppn_vaults add column if not exists redemption_tx_signature text;
alter table ppn_vaults add column if not exists maturity_ts bigint;

create index if not exists idx_ppn_vaults_onchain_tx_signature
  on ppn_vaults (onchain_tx_signature)
  where onchain_tx_signature is not null;

-- ---------- schema_tranche.sql ----------
alter table ppn_vaults add column if not exists tranche_kind text
  check (tranche_kind in ('senior', 'mezzanine', 'junior'));
alter table ppn_vaults add column if not exists tranche_attach double precision;
alter table ppn_vaults add column if not exists tranche_detach double precision;
alter table ppn_vaults add column if not exists price_per_token double precision;

create index if not exists idx_ppn_vaults_tranche_kind
  on ppn_vaults (tranche_kind)
  where tranche_kind is not null;

-- ---------- Force Postgrest to re-read the schema cache ----------
-- Supabase's REST layer caches the table schema in memory. After adding
-- columns, tell it to reload so the next insert from the backend sees them.
notify pgrst, 'reload schema';
