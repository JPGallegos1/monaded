-- Atomic publish claim: only one concurrent /publish may call chain/ per template.
-- Claim is a timestamp so stale locks can be reclaimed safely after TTL.
-- Apply this migration BEFORE deploying api/ (and chain/ if you deploy it).
alter table public.templates
  add column if not exists publish_claimed_at timestamptz;

comment on column public.templates.publish_claimed_at is
  'Set when a publish attempt claims the row for chain/; cleared on success or safe release. Stale claims may be reclaimed after TTL.';
