-- =========================================================================
-- Pinpoint — shared backend setup for Supabase
-- -------------------------------------------------------------------------
-- HOW TO USE: Supabase Dashboard → SQL Editor → New query → paste ALL of
-- this file → click "Run". You should see "Success. No rows returned".
--
-- It is safe to run this file more than once (for example after an update).
--
-- Creates:
--   • projects table   (one row per review project)
--   • comments table   (one row per pin/comment), with live updates on
--   • review-files     storage bucket for the uploaded HTML/PDF/DOCX/PPTX
--   • access rules so ONLY signed-in people with a company email address
--     (or an address you add to the guest list) can see or change anything
--   • a guard that refuses sign-ups from anyone else
--
-- >>> YOUR COMPANY DOMAIN is set in ONE place: team_domain() right below.
-- >>> PEOPLE OUTSIDE THAT DOMAIN (a client, your boss's personal address…):
--     add them to the guest list AFTER running this file, with one line in
--     the SQL Editor:
--       insert into public.allowed_emails (email) values ('name@example.com');
--     To remove someone:
--       delete from public.allowed_emails where email = 'name@example.com';
--     To see the list:
--       select * from public.allowed_emails;
-- =========================================================================

-- ---------- Who is allowed in ----------
create or replace function public.team_domain()
returns text
language sql
immutable
as $$
  select 'sureshield.ai'
$$;

-- Guest list: individual addresses allowed in besides the company domain.
-- Row-level security is on with no policies, so the app itself can't read
-- or change this list — only you, from the Supabase dashboard.
create table if not exists public.allowed_emails (
  email    text primary key,
  note     text,
  added_at timestamptz not null default now()
);
alter table public.allowed_emails enable row level security;

create or replace function public.email_is_allowed(addr text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(addr, '') ilike ('%@' || public.team_domain())
      or exists (select 1 from public.allowed_emails a where lower(a.email) = lower(coalesce(addr, '')))
$$;

create or replace function public.is_team_member()
returns boolean
language sql
stable
as $$
  select public.email_is_allowed(auth.jwt() ->> 'email')
$$;

-- Refuse to create accounts for anyone not allowed in. This also stops
-- strangers from using up your project's sign-in email allowance.
create or replace function public.block_outside_signups()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.email_is_allowed(new.email) then
    raise exception 'This email is not on the Pinpoint access list';
  end if;
  return new;
end
$$;

drop trigger if exists block_outside_signups on auth.users;
create trigger block_outside_signups
  before insert on auth.users
  for each row execute function public.block_outside_signups();

-- ---------- Tables ----------
create table if not exists public.projects (
  id          text primary key,
  name        text not null,
  file_name   text not null,
  file_type   text not null check (file_type in ('html','pdf','docx','pptx')),
  file_path   text not null,                 -- path inside the review-files bucket
  created_by  text default (auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.comments (
  id               text primary key,
  project_id       text not null references public.projects(id) on delete cascade,
  number           integer,                  -- assigned automatically (see trigger)
  x                double precision not null,
  y                double precision not null,
  page             integer,
  anchor           text,                     -- how x/y are measured: 'html' | 'page' | 'content'
  text             text not null,
  author           text,
  author_email     text default (auth.jwt() ->> 'email'),
  author_id        text,                     -- per-browser id, tells reviewers on a shared link apart
  element_selector text,
  status           text not null default 'open' check (status in ('open','resolved')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- (for anyone who ran an earlier version of this file)
alter table public.comments add column if not exists anchor text;
alter table public.comments add column if not exists author_email text;
alter table public.comments add column if not exists author_id text;
alter table public.comments alter column author_email set default (auth.jwt() ->> 'email');
alter table public.projects alter column created_by set default (auth.jwt() ->> 'email');

create index if not exists comments_project_idx on public.comments (project_id, number);

-- ---------- Comment numbering (no duplicate numbers when two people comment at once) ----------
create or replace function public.assign_comment_number()
returns trigger
language plpgsql
as $$
begin
  if new.number is null then
    perform pg_advisory_xact_lock(hashtext(new.project_id));
    select coalesce(max(number), 0) + 1
      into new.number
      from public.comments
     where project_id = new.project_id;
  end if;
  return new;
end
$$;

drop trigger if exists comments_assign_number on public.comments;
create trigger comments_assign_number
  before insert on public.comments
  for each row execute function public.assign_comment_number();

-- ---------- Keep updated_at fresh (drives the dashboard "Updated" date) ----------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch
  before update on public.projects
  for each row execute function public.touch_updated_at();

drop trigger if exists comments_touch on public.comments;
create trigger comments_touch
  before update on public.comments
  for each row execute function public.touch_updated_at();

create or replace function public.touch_project_from_comment()
returns trigger
language plpgsql
as $$
begin
  update public.projects
     set updated_at = now()
   where id = coalesce(new.project_id, old.project_id);
  return null;
end
$$;

drop trigger if exists comments_touch_project on public.comments;
create trigger comments_touch_project
  after insert or update or delete on public.comments
  for each row execute function public.touch_project_from_comment();

-- ---------- Row-level security: company accounts only ----------
alter table public.projects enable row level security;
alter table public.comments enable row level security;

drop policy if exists "team can do everything" on public.projects;
create policy "team can do everything" on public.projects
  for all to authenticated
  using (public.is_team_member())
  with check (public.is_team_member());

drop policy if exists "team can do everything" on public.comments;
create policy "team can do everything" on public.comments
  for all to authenticated
  using (public.is_team_member())
  with check (public.is_team_member());

-- ---------- Realtime: push changes to every open browser ----------
alter table public.comments replica identity full;   -- so deletes carry the full row
alter table public.projects replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.comments;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.projects;
  exception when duplicate_object then null;
  end;
end
$$;

-- ---------- File storage ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('review-files', 'review-files', false, 52428800)   -- 50 MB, the free-plan maximum
on conflict (id) do nothing;

drop policy if exists "team reads review files"   on storage.objects;
drop policy if exists "team uploads review files" on storage.objects;
drop policy if exists "team updates review files" on storage.objects;
drop policy if exists "team deletes review files" on storage.objects;

create policy "team reads review files" on storage.objects
  for select to authenticated
  using (bucket_id = 'review-files' and public.is_team_member());

create policy "team uploads review files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'review-files' and public.is_team_member());

create policy "team updates review files" on storage.objects
  for update to authenticated
  using (bucket_id = 'review-files' and public.is_team_member());

create policy "team deletes review files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'review-files' and public.is_team_member());
