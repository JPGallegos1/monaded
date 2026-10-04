-- Creator Economy indexer: on-chain sales, royalties, deferred payments, withdrawals.
-- Only the api Worker (service role) writes these tables. RLS on, no policies.
-- Apply BEFORE deploying api/ + indexer/. Do not apply from this PR environment.

-- ---------------------------------------------------------------------------
-- Raw decoded logs (idempotent by tx_hash + log_index)
-- ---------------------------------------------------------------------------
create table if not exists public.chain_events (
  id bigint generated always as identity primary key,
  chain_id integer not null,
  contract text not null,
  event_name text not null,
  args jsonb not null default '{}'::jsonb,
  block_number bigint not null,
  block_time timestamptz,
  tx_hash text not null,
  log_index integer not null,
  created_at timestamptz not null default now(),
  constraint chain_events_tx_log_unique unique (tx_hash, log_index)
);

create index if not exists chain_events_contract_block_idx
  on public.chain_events (chain_id, contract, block_number);
create index if not exists chain_events_event_name_idx
  on public.chain_events (event_name);
create index if not exists chain_events_tx_hash_idx
  on public.chain_events (tx_hash);

alter table public.chain_events enable row level security;

-- ---------------------------------------------------------------------------
-- Per-contract cursor (seeded to deploy_block - 1)
-- ---------------------------------------------------------------------------
create table if not exists public.indexer_cursor (
  chain_id integer not null,
  contract text not null,
  last_block bigint not null,
  updated_at timestamptz not null default now(),
  primary key (chain_id, contract)
);

alter table public.indexer_cursor enable row level security;

-- TemplateMarketplace on Monad testnet: deploy block 67913228 → seed 67913227
insert into public.indexer_cursor (chain_id, contract, last_block)
values (10143, '0xc8c9cd5a19b4fc27b209adf75eda442c798ab59e', 67913227)
on conflict (chain_id, contract) do nothing;

-- ---------------------------------------------------------------------------
-- On-chain template state (TemplatePublished / TemplateUpdated)
-- template_id links to public.templates via templates.onchain_token_id when present.
-- Templates 1–3 from smoke tests have no Supabase rows → template_id stays null.
-- ---------------------------------------------------------------------------
create table if not exists public.onchain_templates (
  id bigint generated always as identity primary key,
  chain_id integer not null,
  contract text not null,
  onchain_id text not null,
  creator text not null,
  parent_id text,
  price numeric(78, 0) not null,
  payment_token text not null,
  metadata_uri text,
  publisher text,
  template_id uuid references public.templates (id) on delete set null,
  block_number bigint not null,
  block_time timestamptz,
  tx_hash text not null,
  log_index integer not null,
  updated_block_number bigint,
  updated_tx_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint onchain_templates_chain_id_unique unique (chain_id, contract, onchain_id),
  constraint onchain_templates_tx_log_unique unique (tx_hash, log_index)
);

create index if not exists onchain_templates_creator_idx
  on public.onchain_templates (creator);
create index if not exists onchain_templates_template_id_idx
  on public.onchain_templates (template_id);
create index if not exists onchain_templates_onchain_id_idx
  on public.onchain_templates (onchain_id);

alter table public.onchain_templates enable row level security;

-- ---------------------------------------------------------------------------
-- Sales (one row per Purchased)
-- ---------------------------------------------------------------------------
create table if not exists public.sales (
  id bigint generated always as identity primary key,
  chain_id integer not null,
  contract text not null,
  onchain_template_id text not null,
  buyer text not null,
  creator text not null,
  token text not null,
  price numeric(78, 0) not null,
  creator_amount numeric(78, 0) not null,
  platform_fee numeric(78, 0) not null,
  block_number bigint not null,
  block_time timestamptz,
  tx_hash text not null,
  log_index integer not null,
  created_at timestamptz not null default now(),
  constraint sales_tx_log_unique unique (tx_hash, log_index)
);

create index if not exists sales_buyer_idx on public.sales (buyer);
create index if not exists sales_creator_idx on public.sales (creator);
create index if not exists sales_token_idx on public.sales (token);
create index if not exists sales_onchain_template_id_idx on public.sales (onchain_template_id);
create index if not exists sales_tx_hash_idx on public.sales (tx_hash);

alter table public.sales enable row level security;

-- ---------------------------------------------------------------------------
-- Royalty payments (one row per RoyaltyPaid)
-- ---------------------------------------------------------------------------
create table if not exists public.royalty_payments (
  id bigint generated always as identity primary key,
  chain_id integer not null,
  contract text not null,
  onchain_template_id text not null,
  ancestor_id text not null,
  recipient text not null,
  level integer not null,
  token text not null,
  amount numeric(78, 0) not null,
  block_number bigint not null,
  block_time timestamptz,
  tx_hash text not null,
  log_index integer not null,
  created_at timestamptz not null default now(),
  constraint royalty_payments_tx_log_unique unique (tx_hash, log_index)
);

create index if not exists royalty_payments_recipient_idx on public.royalty_payments (recipient);
create index if not exists royalty_payments_token_idx on public.royalty_payments (token);

alter table public.royalty_payments enable row level security;

-- ---------------------------------------------------------------------------
-- Deferred payments (PaymentDeferred — push failed, pull balance grew)
-- ---------------------------------------------------------------------------
create table if not exists public.deferred_payments (
  id bigint generated always as identity primary key,
  chain_id integer not null,
  contract text not null,
  recipient text not null,
  token text not null,
  amount numeric(78, 0) not null,
  block_number bigint not null,
  block_time timestamptz,
  tx_hash text not null,
  log_index integer not null,
  created_at timestamptz not null default now(),
  constraint deferred_payments_tx_log_unique unique (tx_hash, log_index)
);

create index if not exists deferred_payments_recipient_idx on public.deferred_payments (recipient);
create index if not exists deferred_payments_token_idx on public.deferred_payments (token);

alter table public.deferred_payments enable row level security;

-- ---------------------------------------------------------------------------
-- Withdrawals (Withdrawn — zeroes pendingWithdrawals)
-- ---------------------------------------------------------------------------
create table if not exists public.withdrawals (
  id bigint generated always as identity primary key,
  chain_id integer not null,
  contract text not null,
  account text not null,
  token text not null,
  amount numeric(78, 0) not null,
  block_number bigint not null,
  block_time timestamptz,
  tx_hash text not null,
  log_index integer not null,
  created_at timestamptz not null default now(),
  constraint withdrawals_tx_log_unique unique (tx_hash, log_index)
);

create index if not exists withdrawals_account_idx on public.withdrawals (account);
create index if not exists withdrawals_token_idx on public.withdrawals (token);

alter table public.withdrawals enable row level security;

-- ---------------------------------------------------------------------------
-- Optional ERC-1155 license transfers (TransferSingle / TransferBatch expanded)
-- ---------------------------------------------------------------------------
create table if not exists public.license_transfers (
  id bigint generated always as identity primary key,
  chain_id integer not null,
  contract text not null,
  operator text not null,
  from_addr text not null,
  to_addr text not null,
  onchain_template_id text not null,
  value numeric(78, 0) not null,
  batch boolean not null default false,
  block_number bigint not null,
  block_time timestamptz,
  tx_hash text not null,
  log_index integer not null,
  batch_index integer not null default 0,
  created_at timestamptz not null default now(),
  constraint license_transfers_tx_log_batch_unique unique (tx_hash, log_index, batch_index)
);

create index if not exists license_transfers_to_idx on public.license_transfers (to_addr);
create index if not exists license_transfers_from_idx on public.license_transfers (from_addr);
create index if not exists license_transfers_template_idx on public.license_transfers (onchain_template_id);

alter table public.license_transfers enable row level security;

-- ---------------------------------------------------------------------------
-- Creator balances per (wallet, token)
-- earned = sales.creator_amount + royalty_payments.amount
-- pending (owed) = sum(deferred) - sum(withdrawn)  ≈ pendingWithdrawals(token, account)
-- ---------------------------------------------------------------------------
create or replace view public.creator_balances as
with earned_sales as (
  select creator as wallet, token, sum(creator_amount) as earned_sales
  from public.sales
  group by creator, token
),
earned_royalties as (
  select recipient as wallet, token, sum(amount) as earned_royalties
  from public.royalty_payments
  group by recipient, token
),
deferred as (
  select recipient as wallet, token, sum(amount) as deferred
  from public.deferred_payments
  group by recipient, token
),
withdrawn as (
  select account as wallet, token, sum(amount) as withdrawn
  from public.withdrawals
  group by account, token
),
wallets as (
  select wallet, token from earned_sales
  union
  select wallet, token from earned_royalties
  union
  select wallet, token from deferred
  union
  select wallet, token from withdrawn
)
select
  w.wallet,
  w.token,
  coalesce(es.earned_sales, 0)::numeric(78, 0) as earned_sales,
  coalesce(er.earned_royalties, 0)::numeric(78, 0) as earned_royalties,
  (coalesce(es.earned_sales, 0) + coalesce(er.earned_royalties, 0))::numeric(78, 0) as earned,
  coalesce(d.deferred, 0)::numeric(78, 0) as deferred,
  coalesce(wd.withdrawn, 0)::numeric(78, 0) as withdrawn,
  (coalesce(d.deferred, 0) - coalesce(wd.withdrawn, 0))::numeric(78, 0) as pending
from wallets w
left join earned_sales es on es.wallet = w.wallet and es.token = w.token
left join earned_royalties er on er.wallet = w.wallet and er.token = w.token
left join deferred d on d.wallet = w.wallet and d.token = w.token
left join withdrawn wd on wd.wallet = w.wallet and wd.token = w.token;

comment on view public.creator_balances is
  'Per (wallet, token): earned_sales + earned_royalties = earned; pending = deferred - withdrawn (reconcile with pendingWithdrawals).';

-- Join path: buyer-claimed purchases ↔ indexer sales (same tx_hash).
-- purchases stays buyer-written by POST /purchases/verify; sales is indexer-written.
create or replace view public.sales_with_purchase_claims as
select
  s.*,
  p.id as purchase_claim_id,
  p.template_id as purchase_template_id,
  p.buyer_user_id,
  p.verified_at as purchase_verified_at
from public.sales s
left join public.purchases p on lower(p.tx_hash) = lower(s.tx_hash);

comment on view public.sales_with_purchase_claims is
  'Indexer sales left-joined to buyer-claimed purchases on tx_hash.';

-- Backfill-safe link: set onchain_templates.template_id from templates.onchain_token_id
-- when a Supabase row appears after the on-chain event was indexed.
create or replace function public.link_onchain_templates_to_templates()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.onchain_templates ot
  set template_id = t.id,
      updated_at = now()
  from public.templates t
  where ot.template_id is null
    and t.onchain_token_id is not null
    and t.onchain_token_id = ot.onchain_id;
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.link_onchain_templates_to_templates() is
  'Sets onchain_templates.template_id from templates.onchain_token_id for rows still null. Safe to call after every indexer batch.';
