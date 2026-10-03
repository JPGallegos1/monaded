-- Privy / marketplace: record verified on-chain purchases (tx hash usable once).
create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  tx_hash text not null,
  template_id uuid references public.templates (id) on delete set null,
  onchain_template_id text not null,
  buyer_wallet text not null,
  buyer_user_id uuid references public.users (id) on delete set null,
  creator_wallet text,
  verified_at timestamptz not null default now(),
  constraint purchases_tx_hash_unique unique (tx_hash)
);

create index if not exists purchases_template_id_idx on public.purchases (template_id);
create index if not exists purchases_buyer_wallet_idx on public.purchases (buyer_wallet);

alter table public.purchases enable row level security;
-- No policies: deny all for anon/authenticated. API uses service role.
