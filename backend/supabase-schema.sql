-- Laptop Guardian Supabase storage schema
-- Run this entire file in Supabase Dashboard > SQL Editor > New query.

create table if not exists public.lg_records (
  collection text not null check (collection in ('users', 'devices', 'events', 'commands')),
  record_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (collection, record_id)
);

alter table public.lg_records enable row level security;
revoke all on table public.lg_records from anon, authenticated;
grant all on table public.lg_records to service_role;

create or replace function public.lg_replace_collection(p_collection text, p_records jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_collection not in ('users', 'devices', 'events', 'commands') then
    raise exception 'Invalid Laptop Guardian collection';
  end if;
  if jsonb_typeof(p_records) <> 'array' then
    raise exception 'Records must be a JSON array';
  end if;

  insert into public.lg_records (collection, record_id, payload, updated_at)
  select p_collection, item->>'id', item, now()
  from jsonb_array_elements(p_records) as records(item)
  where coalesce(item->>'id', '') <> ''
  on conflict (collection, record_id)
  do update set payload = excluded.payload, updated_at = now();

  delete from public.lg_records r
  where r.collection = p_collection
    and not exists (
      select 1
      from jsonb_array_elements(p_records) as records(item)
      where item->>'id' = r.record_id
    );
end;
$$;

revoke all on function public.lg_replace_collection(text, jsonb) from public, anon, authenticated;
grant execute on function public.lg_replace_collection(text, jsonb) to service_role;
