-- Day 2: AI-generated study templates from uploaded PDFs.
-- materials: where extracted text lives + failure reason.
alter table public.materials
  add column if not exists original_filename text,
  add column if not exists text_r2_key text,
  add column if not exists error text;

-- templates: generated structured content + generation lifecycle.
alter table public.templates
  add column if not exists content jsonb,
  add column if not exists status text not null default 'ready',
  add column if not exists error text,
  add column if not exists generation jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'templates_status_check') then
    alter table public.templates
      add constraint templates_status_check check (status in ('generating', 'ready', 'failed'));
  end if;
end $$;

create index if not exists templates_material_id_idx on public.templates (material_id);
