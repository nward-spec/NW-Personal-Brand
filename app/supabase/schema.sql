-- Weekly Journal: Supabase schema.
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- One row per user per week, plus one templates row per user. Each row stores
-- the whole document as JSON; the app merges by updated_at (last write wins).

create table if not exists public.weeks (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  week_start date        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, week_start)
);

create table if not exists public.templates (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);

alter table public.weeks     enable row level security;
alter table public.templates enable row level security;

-- Each signed-in user can only see and change their own rows.
drop policy if exists "weeks: own rows" on public.weeks;
create policy "weeks: own rows" on public.weeks
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "templates: own rows" on public.templates;
create policy "templates: own rows" on public.templates
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index if not exists weeks_user_updated on public.weeks (user_id, updated_at desc);
