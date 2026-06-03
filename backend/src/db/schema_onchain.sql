-- Pelagos Sui on-chain metadata.

alter table bundles add column if not exists onchain_tx_signature text;
alter table bundles add column if not exists onchain_finalized_at timestamptz;
alter table bundles add column if not exists onchain_finalize_tx text;

alter table legs add column if not exists leg_index int;
alter table legs add column if not exists onchain_resolved_at timestamptz;
alter table legs add column if not exists onchain_resolve_tx text;

alter table transactions add column if not exists onchain_tx_signature text;
