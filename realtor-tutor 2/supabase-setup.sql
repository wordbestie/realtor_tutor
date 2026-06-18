-- Run this once in the Supabase SQL editor.
-- Tracks who has paid. Only the server (service role) can write to it;
-- a logged-in user may read only their own row.

create table if not exists public.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  has_access boolean not null default false,
  stripe_customer text,
  updated_at timestamptz not null default now()
);

alter table public.entitlements enable row level security;

-- Users can read their own entitlement (the front-end checks this).
create policy "read own entitlement"
  on public.entitlements for select
  using (auth.uid() = user_id);

-- No insert/update/delete policies => browsers cannot grant themselves access.
-- The Netlify webhook uses the service role key, which bypasses RLS.
