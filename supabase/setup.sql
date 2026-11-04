-- MPC database setup for Supabase. Run this once: Supabase dashboard > SQL Editor > New query > paste > Run.
-- Safe to run again.

-- Every document (sessions, members, roles, bookings, settings, password hashes ...) is one row.
create table if not exists public.docs (
  col  text  not null,
  id   text  not null,
  data jsonb not null,
  primary key (col, id)
);

-- Change counter and login rate limits.
create table if not exists public.counters (
  key        text primary key,
  n          bigint not null default 0,
  expires_at timestamptz
);

-- The website server uses the secret service key. Nobody else (including the public "anon" key) can touch these tables.
alter table public.docs     enable row level security;
alter table public.counters enable row level security;
revoke all on public.docs     from anon, authenticated;
revoke all on public.counters from anon, authenticated;

-- Adds one to a counter and returns the new value.
create or replace function public.mpc_incr(k text) returns bigint
language sql security definer set search_path = public as $$
  insert into public.counters (key, n) values (k, 1)
  on conflict (key) do update set n = public.counters.n + 1
  returning n;
$$;

-- Counts tries inside a time window: starts again from 1 once the window has passed.
create or replace function public.mpc_hit(k text, secs int) returns bigint
language plpgsql security definer set search_path = public as $$
declare r bigint;
begin
  insert into public.counters (key, n, expires_at) values (k, 1, now() + make_interval(secs => secs))
  on conflict (key) do update set
    n          = case when public.counters.expires_at < now() then 1 else public.counters.n + 1 end,
    expires_at = case when public.counters.expires_at < now() then now() + make_interval(secs => secs) else public.counters.expires_at end
  returning n into r;
  return r;
end;
$$;

revoke execute on function public.mpc_incr(text)      from public, anon, authenticated;
revoke execute on function public.mpc_hit(text, int)  from public, anon, authenticated;
grant  execute on function public.mpc_incr(text)      to service_role;
grant  execute on function public.mpc_hit(text, int)  to service_role;
