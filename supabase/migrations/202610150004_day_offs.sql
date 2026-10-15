-- Phase 2: day-off status and transactional bulk calendar persistence.

create table if not exists public.day_offs (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  work_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, work_date)
);

create index if not exists day_offs_user_date_idx
  on public.day_offs(user_id, work_date);

alter table public.day_offs enable row level security;
revoke all on public.day_offs from anon, authenticated;

create or replace function public.replace_day_offs(p_user_id uuid, p_items jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  delete from public.day_offs existing
  where existing.user_id = p_user_id
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as entries(item)
      where (item->>'id')::uuid = existing.id
    );

  insert into public.day_offs (id, user_id, work_date)
  select (item->>'id')::uuid,
         p_user_id,
         (item->>'workDate')::date
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as entries(item)
  on conflict (id) do update
  set work_date = excluded.work_date,
      updated_at = now()
  where public.day_offs.user_id = p_user_id;
end;
$$;

revoke all on function public.replace_day_offs(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_day_offs(uuid, jsonb) to service_role;

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
  if p_state ? 'dayOffs' then
    perform public.replace_day_offs(p_user_id, p_state->'dayOffs');
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

update public.shift_types set color = '#F59E0B' where id = 'morning' and color = '#B7791F';
update public.shift_types set color = '#8B5CF6' where id = 'evening' and color = '#9B285B';
update public.shift_types set color = '#2563EB' where id = 'night' and color = '#3559A8';
