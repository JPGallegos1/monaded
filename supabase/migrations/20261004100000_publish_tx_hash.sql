-- Recoverable publish state: persist broadcast outcome before relying on is_published.
-- If chain publishFor succeeds but the final Supabase update fails, retries can
-- reconcile from publish_tx_hash / onchain_token_id without broadcasting again.
alter table public.templates
  add column if not exists publish_tx_hash text;

create unique index if not exists templates_publish_tx_hash_uidx
  on public.templates (publish_tx_hash)
  where publish_tx_hash is not null;
