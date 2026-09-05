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

-- ---------------------------------------------------------------------------
-- Apple Reminders sync (iCloud CalDAV). One row per reminder, mirrored both
-- ways by the `reminders-sync` edge function. The app edits `data` and sets
-- `pending`; the function pushes to iCloud and rewrites the row.

create table if not exists public.reminders (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  uid        text        not null,
  data       jsonb       not null,
  pending    text,
  updated_at timestamptz not null default now(),
  primary key (user_id, uid)
);

alter table public.reminders enable row level security;
drop policy if exists "reminders: own rows" on public.reminders;
create policy "reminders: own rows" on public.reminders
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index if not exists reminders_user_pending on public.reminders (user_id) where pending is not null;

-- iCloud account per user. The app-specific password is encrypted by the edge
-- function with a server-side key before it is stored; the app never reads it.
create table if not exists public.icloud_accounts (
  user_id        uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  apple_id       text        not null,
  password_enc   text        not null,
  principal_url  text,
  home_url       text,
  dinners_list   text        not null default 'Dinners',
  last_sync_at   timestamptz,
  last_error     text,
  lists          jsonb       not null default '[]'::jsonb,
  updated_at     timestamptz not null default now()
);

alter table public.icloud_accounts enable row level security;
-- Users may see their own connection status but never the encrypted secret
-- (the app selects specific columns; the function uses the service role).
drop policy if exists "icloud: own row read" on public.icloud_accounts;
create policy "icloud: own row read" on public.icloud_accounts
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "icloud: own row update" on public.icloud_accounts;
create policy "icloud: own row update" on public.icloud_accounts
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "icloud: own row delete" on public.icloud_accounts;
create policy "icloud: own row delete" on public.icloud_accounts
  for delete to authenticated using (user_id = auth.uid());
-- Supabase grants `authenticated` full table access by default; replace that
-- with column-level grants that exclude the encrypted secret.
revoke all on public.icloud_accounts from anon;
revoke all on public.icloud_accounts from authenticated;
grant select (user_id, apple_id, principal_url, home_url, dinners_list, last_sync_at, last_error, lists, updated_at), update (dinners_list), delete on public.icloud_accounts to authenticated;

-- ---------------------------------------------------------------------------
-- Apple Reminders via an iPhone Shortcut (Apple removed CalDAV access to
-- Reminders in iOS 13). The app creates one row with a random token; the
-- Shortcut presents that token to the `reminders-shortcut` edge function.

create table if not exists public.shortcut_links (
  user_id      uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  token        text        not null unique,
  dinners_list text        not null default 'Dinners',
  todo_list    text        not null default 'Reminders',
  lists        jsonb       not null default '[]'::jsonb,
  last_sync_at timestamptz,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.shortcut_links add column if not exists todo_list text not null default 'Reminders';

alter table public.shortcut_links enable row level security;
drop policy if exists "shortcut_links: own row" on public.shortcut_links;
create policy "shortcut_links: own row" on public.shortcut_links
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
revoke all on public.shortcut_links from anon;
