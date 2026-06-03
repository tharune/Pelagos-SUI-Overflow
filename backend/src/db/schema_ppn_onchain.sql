-- Pelagos protected-note on-chain integration columns. Additive migration:
-- safe to run on an existing DB after schema_onchain.sql.

alter table ppn_vaults add column if not exists note_seed_hex text;
alter table ppn_vaults add column if not exists onchain_tx_signature text;
alter table ppn_vaults add column if not exists redemption_tx_signature text;
alter table ppn_vaults add column if not exists divest_tx_signature text;
alter table ppn_vaults add column if not exists maturity_ts bigint;

create index if not exists idx_ppn_vaults_onchain_tx_signature
  on ppn_vaults (onchain_tx_signature)
  where onchain_tx_signature is not null;
