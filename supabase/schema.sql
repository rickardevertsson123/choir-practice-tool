-- Minimal schema for app-managed users/groups (owner moderation uses these tables).
-- Apply in Supabase Dashboard → SQL Editor.

-- Needed for gen_random_uuid()
create extension if not exists pgcrypto;

-- PROFILES (one row per auth user)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_reason text
);

alter table public.profiles enable row level security;

-- Users can read/update their own profile (email is copied from auth for convenience).
create policy "profiles_select_own"
on public.profiles for select
using (auth.uid() = id);

create policy "profiles_upsert_own"
on public.profiles for insert
with check (auth.uid() = id);

create policy "profiles_update_own"
on public.profiles for update
using (auth.uid() = id)
with check (auth.uid() = id);

-- GROUPS
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  -- Future: group “cover” image (stored in Supabase Storage) + markdown content
  cover_image_path text,
  description_md text,
  contact_md text,
  disabled_at timestamptz,
  disabled_reason text
);

alter table public.groups enable row level security;

-- If you applied an older schema already, ensure new columns exist:
alter table public.groups
  add column if not exists cover_image_path text,
  add column if not exists description_md text,
  add column if not exists contact_md text;

-- GROUP MEMBERSHIPS
create table if not exists public.group_memberships (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('admin', 'member')),
  status text not null check (status in ('active', 'pending', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

alter table public.group_memberships enable row level security;

-- RLS: a user can see their own memberships.
create policy "memberships_select_own"
on public.group_memberships for select
using (auth.uid() = user_id);

-- RLS: allow creating a group if the user is not disabled.
create policy "groups_insert_if_not_disabled"
on public.groups for insert
with check (
  auth.uid() = created_by
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.disabled_at is null
  )
);

-- RLS: allow the creator to see their created group row (needed immediately after insert).
create policy "groups_select_creator"
on public.groups for select
using (created_by = auth.uid());

-- RLS: allow selecting groups that the user is a member of (any status).
create policy "groups_select_member"
on public.groups for select
using (
  exists (
    select 1 from public.group_memberships m
    where m.group_id = groups.id and m.user_id = auth.uid()
  )
);

-- RLS: allow updating group metadata (cover/description) if you're an active admin in that group.
create policy "groups_update_admin"
on public.groups for update
using (
  exists (
    select 1 from public.group_memberships m
    where m.group_id = groups.id
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
)
with check (
  exists (
    select 1 from public.group_memberships m
    where m.group_id = groups.id
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
);

-- RLS: allow inserting membership for yourself when creating a group (admin active).
create policy "memberships_insert_own"
on public.group_memberships for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.disabled_at is null
  )
);

-- For now: owner/admin console uses service_role (bypasses RLS for moderation).

-- GROUP INVITES (join links)
create table if not exists public.group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.group_invites enable row level security;

-- Minimal RLS (we mostly use server-side service role for now):
-- - admins can list their group's invites
create policy "invites_select_admin"
on public.group_invites for select
using (
  exists (
    select 1 from public.group_memberships m
    where m.group_id = group_invites.group_id
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
);

-- - admins can insert invites for their group
create policy "invites_insert_admin"
on public.group_invites for insert
with check (
  exists (
    select 1 from public.group_memberships m
    where m.group_id = group_invites.group_id
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
);

-- STORAGE: group cover images (bucket: group-covers)
-- Bucket naming convention: "<groupId>/cover.webp"
-- Note: if you prefer, create the bucket via Supabase Dashboard instead.
insert into storage.buckets (id, name, public)
values ('group-covers', 'group-covers', false)
on conflict (id) do nothing;

-- Active members can READ.
create policy "group_covers_read_active_members"
on storage.objects for select
using (
  bucket_id = 'group-covers'
  and exists (
    select 1 from public.group_memberships m
    where m.group_id::text = split_part(name, '/', 1)
      and m.user_id = auth.uid()
      and m.status = 'active'
  )
);

-- Active admins can WRITE.
create policy "group_covers_write_admin_insert"
on storage.objects for insert
with check (
  bucket_id = 'group-covers'
  and exists (
    select 1 from public.group_memberships m
    where m.group_id::text = split_part(name, '/', 1)
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
);

create policy "group_covers_write_admin_update"
on storage.objects for update
using (
  bucket_id = 'group-covers'
  and exists (
    select 1 from public.group_memberships m
    where m.group_id::text = split_part(name, '/', 1)
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
)
with check (
  bucket_id = 'group-covers'
  and exists (
    select 1 from public.group_memberships m
    where m.group_id::text = split_part(name, '/', 1)
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
);

create policy "group_covers_write_admin_delete"
on storage.objects for delete
using (
  bucket_id = 'group-covers'
  and exists (
    select 1 from public.group_memberships m
    where m.group_id::text = split_part(name, '/', 1)
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
);

-- GROUP SCORES (repertoire)
create table if not exists public.group_scores (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  storage_path text not null,
  filename text not null,
  display_name text,
  expires_at timestamptz,
  content_type text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.group_scores enable row level security;

-- If you applied an older schema already, ensure new columns exist:
alter table public.group_scores
  add column if not exists display_name text,
  add column if not exists expires_at timestamptz;

-- Active members can list scores for their groups.
create policy "group_scores_select_active_members"
on public.group_scores for select
using (
  exists (
    select 1 from public.group_memberships m
    where m.group_id = group_scores.group_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  )
);

-- Active admins can insert scores to their groups.
create policy "group_scores_insert_admin"
on public.group_scores for insert
with check (
  created_by = auth.uid()
  and exists (
    select 1 from public.group_memberships m
    where m.group_id = group_scores.group_id
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
);

-- Active admins can delete scores from their groups.
create policy "group_scores_delete_admin"
on public.group_scores for delete
using (
  exists (
    select 1 from public.group_memberships m
    where m.group_id = group_scores.group_id
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
);

-- STORAGE: group score files (bucket: group-scores)
-- Object naming convention: "<groupId>/<uuid>.<mxl|musicxml|xml>"
insert into storage.buckets (id, name, public)
values ('group-scores', 'group-scores', false)
on conflict (id) do nothing;

-- Active members can READ score files.
create policy "group_scores_files_read_active_members"
on storage.objects for select
using (
  bucket_id = 'group-scores'
  and exists (
    select 1 from public.group_memberships m
    where m.group_id::text = split_part(name, '/', 1)
      and m.user_id = auth.uid()
      and m.status = 'active'
  )
);

-- Active admins can WRITE score files.
create policy "group_scores_files_write_admin_insert"
on storage.objects for insert
with check (
  bucket_id = 'group-scores'
  and exists (
    select 1 from public.group_memberships m
    where m.group_id::text = split_part(name, '/', 1)
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
);

create policy "group_scores_files_write_admin_update"
on storage.objects for update
using (
  bucket_id = 'group-scores'
  and exists (
    select 1 from public.group_memberships m
    where m.group_id::text = split_part(name, '/', 1)
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
)
with check (
  bucket_id = 'group-scores'
  and exists (
    select 1 from public.group_memberships m
    where m.group_id::text = split_part(name, '/', 1)
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
);

create policy "group_scores_files_write_admin_delete"
on storage.objects for delete
using (
  bucket_id = 'group-scores'
  and exists (
    select 1 from public.group_memberships m
    where m.group_id::text = split_part(name, '/', 1)
      and m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  )
);



