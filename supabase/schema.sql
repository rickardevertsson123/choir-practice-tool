-- Minimal schema for app-managed users/groups (owner moderation uses these tables).
-- Apply in Supabase Dashboard → SQL Editor.

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
  disabled_at timestamptz,
  disabled_reason text
);

alter table public.groups enable row level security;

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


