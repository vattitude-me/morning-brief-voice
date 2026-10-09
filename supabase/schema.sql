-- Morning Brief Voice: Supabase schema.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- Who writes what:
--   * The PWA (signed-in users, publishable key) reads its own briefings and manages its own links,
--     settings and push subscriptions. Row-level security keeps every user to their own rows.
--   * The Linux worker (secret key, bypasses RLS) reads everyone's links, writes briefings,
--     uploads MP3s and publishes the shared app_status row.

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  is_admin    boolean not null default false,
  -- Unguessable folder name for this user's MP3s in the public bucket.
  feed_token  text not null unique default replace(gen_random_uuid()::text, '-', ''),
  settings    jsonb not null default '{}'::jsonb,
  -- Written by the worker: last build time, last error, notes for the user.
  status      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users created before this script ran.
insert into public.profiles (id, email) select id, email from auth.users on conflict (id) do nothing;

-- ----------------------------------------------------------------- sources
-- user_id null = built-in source shared by everyone (seeded by the worker).
create table if not exists public.sources (
  id              bigint generated always as identity primary key,
  user_id         uuid default auth.uid() references auth.users (id) on delete cascade,
  name            text not null check (char_length(name) <= 200),
  url             text not null check (char_length(url) <= 2000 and url ~* '^https?://'),
  feed_url        text,
  kind            text not null default 'auto' check (kind in ('auto', 'feed', 'page', 'article')),
  section         text not null default 'custom',
  enabled         boolean not null default true,
  weight          real not null default 1.0,
  created_at      timestamptz not null default now(),
  last_fetched_at timestamptz,
  last_status     text,
  last_count      integer,
  consumed_at     timestamptz,
  unique nulls not distinct (user_id, url)
);
create index if not exists sources_user_idx on public.sources (user_id);

-- ------------------------------------------------- single-source transition
-- The brief is now a shared daily pack of The Guardian's stories (app/guardian.py),
-- so a topic is no longer a bag of outlets. The old per-outlet built-ins are dropped
-- and only the seven pack sections plus 'custom' (links people add themselves)
-- remain. Safe to re-run: the deletes are idempotent and the update only moves rows
-- that are still on an old section name.
delete from public.sources where user_id is null;
update public.sources set section = 'custom'
  where section not in ('top', 'ai', 'tech', 'politics', 'entertainment', 'science', 'sports', 'custom');
alter table public.sources drop constraint if exists sources_section_check;
alter table public.sources add constraint sources_section_check check (section in
  ('top', 'ai', 'tech', 'politics', 'entertainment', 'science', 'sports', 'custom'));

-- Per-profile story counts: keep the seven pack sections (0 = section off), drop the
-- old canada/world/business/health/local/follow keys. Idempotent — a stored count for
-- one of the seven is preserved, anything missing (or unreadable) defaults to 5.
create or replace function public._story_count(s jsonb, k text) returns int
language sql immutable set search_path = '' as $$
  select least(5, greatest(0,
    coalesce(nullif(regexp_replace(coalesce(s->'stories'->>k, ''), '\D', '', 'g'), '')::int, 5)))
$$;
update public.profiles set settings = jsonb_set(settings, '{stories}', jsonb_build_object(
  'top',           public._story_count(settings, 'top'),
  'ai',            public._story_count(settings, 'ai'),
  'tech',          public._story_count(settings, 'tech'),
  'politics',      public._story_count(settings, 'politics'),
  'entertainment', public._story_count(settings, 'entertainment'),
  'science',       public._story_count(settings, 'science'),
  'sports',        public._story_count(settings, 'sports')));
drop function if exists public._story_count(jsonb, text);

-- --------------------------------------------------------------- briefings
-- Superseded by the shared story_audio pack plus the client-side merge; these
-- per-user rows are no longer written by anything.
create table if not exists public.briefings (
  user_id     uuid not null references auth.users (id) on delete cascade,
  date        date not null,
  data        jsonb not null,
  audio_path  text,
  created_at  timestamptz not null default now(),
  primary key (user_id, date)
);

-- One-time cleanup: the old per-user briefings are replaced by the shared daily pack.
delete from public.briefings;

-- ------------------------------------------------------ push subscriptions
create table if not exists public.push_subscriptions (
  endpoint    text primary key check (char_length(endpoint) <= 2048),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------- build requests
-- 'push_test' and 'delete_account' are open to everyone. 'build' (one listener's briefing)
-- and 'pack' (the shared daily audio every listener hears) are admin-only.
-- 'delete_account': the worker removes the user's MP3s, then their sign-in, which cascades to every row.
-- 'pack' carries its options in payload, the same switches `python -m app pack` takes:
--   {"day": "2026-10-07", "voices": ["her_reference"], "notes_only": false, "force": false}
create table if not exists public.build_requests (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind         text not null default 'build' check (kind in ('build', 'push_test', 'delete_account', 'pack')),
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  message      text,
  payload      jsonb,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
-- Projects created before 'delete_account' existed: widen the check.
alter table public.build_requests drop constraint if exists build_requests_kind_check;
alter table public.build_requests add constraint build_requests_kind_check
  check (kind in ('build', 'push_test', 'delete_account', 'pack'));
-- Projects created before the admin page existed: add the options column.
alter table public.build_requests add column if not exists payload jsonb;

-- -------------------------------------------------------------- app status
-- One shared row the worker keeps up to date: schedule, last run, voices, push key.
create table if not exists public.app_status (
  id          integer primary key default 1 check (id = 1),
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- --------------------------------------------------------- content reports
-- Readers flagging a summary from the app (Google Play requires a way to report AI-written text).
-- Anyone may add one, signed in or not; nobody but the secret key can read them.
create table if not exists public.content_reports (
  id          bigint generated always as identity primary key,
  user_id     uuid default auth.uid() references auth.users (id) on delete cascade,
  reason      text not null check (reason in ('inaccurate', 'offensive', 'broken', 'other')),
  note        text check (char_length(note) <= 1000),
  headline    text not null check (char_length(headline) <= 500),
  summary     text check (char_length(summary) <= 4000),
  url         text check (char_length(url) <= 2000),
  source      text check (char_length(source) <= 200),
  writer      text check (char_length(writer) <= 100),
  app         text check (char_length(app) <= 40),
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------ row-level security
alter table public.profiles           enable row level security;
alter table public.sources            enable row level security;
alter table public.briefings          enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.build_requests     enable row level security;
alter table public.app_status         enable row level security;
alter table public.content_reports    enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select to authenticated using (id = auth.uid());
drop policy if exists "edit own profile" on public.profiles;
create policy "edit own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "read built-in and own sources" on public.sources;
create policy "read built-in and own sources" on public.sources for select to authenticated
  using (user_id is null or user_id = auth.uid());
drop policy if exists "add own sources" on public.sources;
create policy "add own sources" on public.sources for insert to authenticated
  with check (user_id = auth.uid() and (select count(*) from public.sources where user_id = auth.uid()) < 25);
drop policy if exists "edit own sources" on public.sources;
create policy "edit own sources" on public.sources for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "remove own sources" on public.sources;
create policy "remove own sources" on public.sources for delete to authenticated using (user_id = auth.uid());

drop policy if exists "read own briefings" on public.briefings;
create policy "read own briefings" on public.briefings for select to authenticated using (user_id = auth.uid());

drop policy if exists "own push subscriptions" on public.push_subscriptions;
create policy "own push subscriptions" on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "read own requests" on public.build_requests;
create policy "read own requests" on public.build_requests for select to authenticated using (user_id = auth.uid());
-- An admin sees the whole queue: who asked for what, and how it ended.
drop policy if exists "admins read requests" on public.build_requests;
create policy "admins read requests" on public.build_requests for select to authenticated
  using (public.is_admin());
-- The web admin page is gated the same way. Flag the account that owns it:
--   update public.profiles set is_admin = true where lower(email) = 'vatsakrish@gmail.com';
-- ADMIN_EMAILS on the worker does the same job for the rebuild itself, without the database.
-- 'build' and 'pack' need public.is_admin(); the other two are open to everyone.
drop policy if exists "create requests" on public.build_requests;
create policy "create requests" on public.build_requests for insert to authenticated
  with check (user_id = auth.uid() and status = 'queued' and (kind in ('push_test', 'delete_account') or public.is_admin()));

drop policy if exists "send reports" on public.content_reports;
create policy "send reports" on public.content_reports for insert to anon, authenticated with check (true);

drop policy if exists "read app status" on public.app_status;
create policy "read app status" on public.app_status for select to authenticated using (true);

-- Column-level limits: users may only touch the columns the app needs.
-- (is_admin, feed_token, status and the worker's source bookkeeping stay worker-only.)
revoke all on public.profiles, public.sources, public.briefings, public.push_subscriptions,
              public.build_requests, public.app_status, public.content_reports from anon, authenticated;
grant select on public.profiles, public.sources, public.briefings, public.push_subscriptions,
                public.build_requests, public.app_status to authenticated;
grant update (settings) on public.profiles to authenticated;
grant insert (user_id, name, url, section, enabled) on public.sources to authenticated;
grant insert (reason, note, headline, summary, url, source, writer, app) on public.content_reports to anon, authenticated;grant update (name, section, enabled) on public.sources to authenticated;
grant delete on public.sources to authenticated;
grant insert (endpoint, user_id, p256dh, auth) on public.push_subscriptions to authenticated;
grant delete on public.push_subscriptions to authenticated;
grant insert (user_id, kind) on public.build_requests to authenticated;

-- ---------------------------------------------------------------- storage
-- Public bucket: MP3s live under /<feed_token>/<date>.mp3, voice samples under /previews/ and the
-- landing-page demo (a copy of the admin's briefing plus sample.json) under /showcase/.
-- Only the worker (secret key) can write; anyone with the exact link can stream.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('briefings', 'briefings', true, 26214400, array['audio/mpeg', 'application/json'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ------------------------------------------------- shared story audio (per day)
-- "Generate once, merge per user": the worker voices the day's stories once and every
-- listener hears the same clips, so TTS cost depends on stories × voices, never on the
-- number of users. The app builds a briefing by concatenating only the clips for the
-- sections and counts the user asked for (profiles.settings.stories, e.g.
-- {"top":3,"ai":5,"sports":0}).
--
-- Object layout in the public 'briefings' bucket: /stories/<date>/<section>-<rank>-<voice>.mp3
-- Every clip comes from the same engine and reference clip, so a plain concatenation is
-- already seamless — no re-encoding needed.
create table if not exists public.story_audio (
  date       date     not null,
  section    text     not null,
  rank       smallint not null check (rank between 1 and 20),
  voice      text     not null,
  title      text     not null check (char_length(title) <= 500),
  url        text     check (url is null or char_length(url) <= 2000),
  source     text     check (source is null or char_length(source) <= 200),
  image      text     check (image is null or char_length(image) <= 2000),
  script     text,
  duration   real     not null default 0 check (duration >= 0),  -- seconds
  audio_path text     not null,                                  -- briefings bucket key
  created_at timestamptz not null default now(),
  primary key (date, section, rank, voice)
);
create index if not exists story_audio_date_idx on public.story_audio (date);

-- Added after the first deployments: the story's lead image (the article's og:image).
alter table public.story_audio add column if not exists image text;

alter table public.story_audio enable row level security;
drop policy if exists "read story audio" on public.story_audio;
create policy "read story audio" on public.story_audio for select to authenticated using (true);

-- Everyone reads the shared clips; only the worker (secret key) writes them.
revoke all on public.story_audio from anon, authenticated;
grant select on public.story_audio to authenticated;

-- ----------------------------------------------------------- spoken framing
-- The greeting and the per-section intros are voiced once per day, exactly like the
-- stories, so a brief can open with "Good morning." and say "Here are the top stories."
-- before each section. Same rules as story_audio: shared by everyone, worker-written.
--   greeting_morning | greeting_afternoon | greeting_evening
--   intro_top | intro_ai | intro_tech | intro_politics | intro_entertainment |
--   intro_science | intro_sports | outro
-- plus one marker row per narrator, note_key 'pack_ready', written when a day's clips and framing
-- are all published. It is never spoken: clients only look up the keys above.
-- Object layout: /notes/<date>/<note_key>-<voice>.mp3
create table if not exists public.voice_notes (
  date       date not null,
  voice      text not null,
  note_key   text not null,
  text       text not null,   -- the spoken line, for captions and debugging
  duration   real not null default 0 check (duration >= 0),  -- seconds
  audio_path text not null,
  created_at timestamptz not null default now(),
  primary key (date, voice, note_key)
);
create index if not exists voice_notes_date_idx on public.voice_notes (date);

alter table public.voice_notes enable row level security;
drop policy if exists "read voice notes" on public.voice_notes;
create policy "read voice notes" on public.voice_notes for select to authenticated using (true);

revoke all on public.voice_notes from anon, authenticated;
grant select on public.voice_notes to authenticated;
-- ------------------------------------------------------------- the run log
-- Every morning the pack writes what happened: the day, whether it is whole, one line per
-- narrator, and the reason for anything that failed. The same text is pushed to the admins'
-- phones, but a phone can be asleep, out of data or signed out, so the log is the copy that
-- cannot be missed. The admin page reads the last few days of it.
--
-- Written by the worker (secret key), read by admins only.
create table if not exists public.run_log (
  id         bigserial primary key,
  run_date   date not null,                                    -- the day the report is about
  status     text not null check (status in ('ok', 'incomplete', 'failed')),
  title      text not null check (char_length(title) <= 200),
  body       text,                                             -- the line the admins were pushed
  detail     text,                                             -- error text, retries, timings
  voices     jsonb not null default '[]'::jsonb,               -- [{id,name,ready}] per narrator
  created_at timestamptz not null default now()
);
create index if not exists run_log_created_at_idx on public.run_log (created_at desc);
create index if not exists run_log_run_date_idx on public.run_log (run_date desc);

alter table public.run_log enable row level security;
drop policy if exists "admins read the run log" on public.run_log;
create policy "admins read the run log" on public.run_log for select to authenticated
  using (public.is_admin());

revoke all on public.run_log from anon, authenticated;
grant select on public.run_log to authenticated;

-- ------------------------------------------------------------- account deletion
-- Allows an authenticated user to permanently delete their own account.
-- auth.users cascades to profiles, sources, push_subscriptions, briefings, etc.
create or replace function public.delete_user_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_user_account() from anon;
grant execute on function public.delete_user_account() to authenticated;

