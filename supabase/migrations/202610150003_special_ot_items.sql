-- Phase 1: separate Special OT from shifts without losing legacy urgent OT values.

create table if not exists public.special_ot_items (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  work_date date not null,
  hours integer not null check (hours between 1 and 24),
  note text check (char_length(note) <= 120),
  origin_shift_id uuid unique references public.shifts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists special_ot_items_user_date_idx
  on public.special_ot_items(user_id, work_date);

alter table public.special_ot_items enable row level security;
revoke all on public.special_ot_items from anon, authenticated;

insert into public.special_ot_items (id, user_id, work_date, hours, note, origin_shift_id)
select s.id, s.user_id, s.work_date, s.urgent_ot_hours, s.note, s.id
from public.shifts s
where s.urgent_ot_hours > 0
on conflict (id) do nothing;

create or replace function public.replace_special_ot_items(p_user_id uuid, p_items jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  delete from public.special_ot_items existing
  where existing.user_id = p_user_id
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as entries(item)
      where (item->>'id')::uuid = existing.id
    );

  insert into public.special_ot_items (id, user_id, work_date, hours, note)
  select (item->>'id')::uuid,
         p_user_id,
         (item->>'workDate')::date,
         (item->>'hours')::integer,
         nullif(item->>'note', '')
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as entries(item)
  on conflict (id) do update
  set work_date = excluded.work_date,
      hours = excluded.hours,
      note = excluded.note,
      updated_at = now()
  where public.special_ot_items.user_id = p_user_id;
end;
$$;

revoke all on function public.replace_special_ot_items(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_special_ot_items(uuid, jsonb) to service_role;

create or replace function public.replace_user_state_v2(
  p_user_id uuid,
  p_state jsonb,
  p_expected_version bigint
)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current_version bigint;
  v_next_version bigint;
begin
  select state_version
  into v_current_version
  from public.user_settings
  where user_id = p_user_id
  for update;

  if v_current_version is null or v_current_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'STATE_VERSION_CONFLICT';
  end if;

  perform public.replace_user_state(p_user_id, p_state);
  if p_state ? 'specialOtItems' then
    perform public.replace_special_ot_items(p_user_id, p_state->'specialOtItems');
  end if;

  update public.user_settings
  set state_version = state_version + 1,
      updated_at = now()
  where user_id = p_user_id
  returning state_version into v_next_version;

  return v_next_version;
end;
$$;

revoke all on function public.replace_user_state_v2(uuid, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.replace_user_state_v2(uuid, jsonb, bigint) to service_role;
