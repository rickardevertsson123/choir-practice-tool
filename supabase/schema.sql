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

-- For now: owner/admin console uses service_role (bypasses RLS).
-- Regular app group visibility will be added together with memberships in later steps.


