-- Pelagos structured prediction market bundles
-- Run in Supabase SQL Editor

create table bundles (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  risk_tier int not null check (risk_tier in (50, 70, 90)),
  resolution_date date not null,
  issue_price numeric not null,
  status text not null default 'active',
  description text,
  theme text,
  created_at timestamptz not null default now()
);

create table legs (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references bundles(id) on delete cascade,
  market_id text not null,
  question text not null,
  probability numeric not null,
  weight numeric not null,
  status text not null default 'active',
  resolution_value numeric,
  polymarket_url text,
  created_at timestamptz not null default now()
);

create table positions (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references bundles(id) on delete cascade,
  wallet_address text not null,
  tokens_held numeric not null,
  entry_price numeric not null,
  deposited_usdc numeric not null,
  created_at timestamptz not null default now()
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references bundles(id) on delete cascade,
  wallet_address text not null,
  type text not null check (type in ('deposit', 'redemption', 'transfer')),
  amount_usdc numeric not null,
  tokens numeric not null,
  fee_usdc numeric not null,
  tx_signature text,
  created_at timestamptz not null default now()
);

create table nav_snapshots (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references bundles(id) on delete cascade,
  nav numeric not null,
  legs_data jsonb not null,
  created_at timestamptz not null default now()
);

create index idx_legs_bundle_id on legs(bundle_id);
create index idx_positions_bundle_id on positions(bundle_id);
create index idx_positions_wallet_address on positions(wallet_address);
create index idx_transactions_bundle_id on transactions(bundle_id);
create index idx_transactions_wallet_address on transactions(wallet_address);
create index idx_nav_snapshots_bundle_id on nav_snapshots(bundle_id);
create index idx_nav_snapshots_created_at on nav_snapshots(created_at);

-- PPN (Principal Protected Notes) vaults
create table ppn_vaults (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references bundles(id) on delete cascade,
  wallet_address text not null,
  principal_usdc numeric not null,
  yield_deployed_usdc numeric not null default 0,
  estimated_apy numeric not null default 0.08,
  vault_address text,
  status text not null default 'active',
  maturity_date date not null,
  created_at timestamptz not null default now()
);

create index idx_ppn_vaults_wallet on ppn_vaults(wallet_address);
create index idx_ppn_vaults_bundle on ppn_vaults(bundle_id);

-- Price alerts
create table price_alerts (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references bundles(id) on delete cascade,
  wallet_address text not null,
  alert_type text not null check (alert_type in ('above', 'below', 'change_percent')),
  threshold numeric not null,
  triggered boolean not null default false,
  triggered_at timestamptz,
  triggered_nav numeric,
  created_at timestamptz not null default now()
);

create index idx_price_alerts_wallet on price_alerts(wallet_address);
create index idx_price_alerts_bundle on price_alerts(bundle_id);
create index idx_price_alerts_active on price_alerts(bundle_id) where triggered = false;
