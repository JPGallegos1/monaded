-- Mirrors production migration version 20261004235040 (lock_down_indexer_views).
-- Named 20261004300100 so it sorts after 20261004300000_creator_economy_indexer.sql,
-- which creates the views this hotfix locks down. Re-running is harmless.

alter view public.creator_balances set (security_invoker = true);
alter view public.sales_with_purchase_claims set (security_invoker = true);
revoke all on public.creator_balances from anon, authenticated;
revoke all on public.sales_with_purchase_claims from anon, authenticated;
