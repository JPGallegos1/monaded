-- Idempotent parent lineage column for fork → publish parentId resolution.
-- Production already has templates.parent_template_id + templates_parent_template_id_fkey
-- from the initial schema; this must not fail or duplicate the constraint.
alter table public.templates
  add column if not exists parent_template_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'templates_parent_template_id_fkey'
  ) then
    alter table public.templates
      add constraint templates_parent_template_id_fkey
      foreign key (parent_template_id) references public.templates (id)
      on delete set null;
  end if;
end $$;

create index if not exists templates_parent_template_id_idx
  on public.templates (parent_template_id);

comment on column public.templates.parent_template_id is
  'DB lineage for forks. publishFor parentId is derived from parent.onchain_token_id — never from the client body.';
