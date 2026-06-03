-- Tranche metadata overlay. Additive migration — safe to run on an existing DB.
-- Apply in Supabase SQL Editor AFTER schema_ppn_onchain.sql.
--
-- Tranches reuse the on-chain PPN note account for principal + maturity
-- (initialize_note / redeem_at_maturity). The tranche *waterfall* is off-chain
-- metadata owned by the backend: which slice of a bundle's eventual payout
-- this note is entitled to, and at what issue price. Because the tranche kind
-- is captured in Supabase (not on-chain), the program code stays untouched
-- and we can ship tranche trading on the existing verified PPN programs.
--
-- Columns:
--   tranche_kind      — enum: 'senior' | 'mezzanine' | 'junior'. NULL for
--                       vanilla PPN deposits.
--   tranche_attach    — fraction of basket payout where this tranche starts
--                       paying (e.g. 0.60 for mezzanine). NULL = vanilla PPN.
--   tranche_detach    — fraction where the tranche tops out (e.g. 0.85 for
--                       mezzanine). NULL = vanilla PPN.
--   price_per_token   — issue price per $1 face the user paid. Captured at
--                       deposit time so the eventual payoff calc matches the
--                       quote the user saw.
--
-- Query patterns:
--   list a user's tranche positions:
--     where wallet_address = $1 and tranche_kind is not null
--   separate vanilla from tranche PPN:
--     where tranche_kind is null  vs  where tranche_kind is not null
--
alter table ppn_vaults add column if not exists tranche_kind text
  check (tranche_kind in ('senior', 'mezzanine', 'junior'));
alter table ppn_vaults add column if not exists tranche_attach double precision;
alter table ppn_vaults add column if not exists tranche_detach double precision;
alter table ppn_vaults add column if not exists price_per_token double precision;

create index if not exists idx_ppn_vaults_tranche_kind
  on ppn_vaults (tranche_kind)
  where tranche_kind is not null;
