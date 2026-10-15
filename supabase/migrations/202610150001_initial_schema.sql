create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null unique,
  display_name text not null default 'ผู้ใช้งาน',
  picture_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  onboarding_complete boolean not null default false,
  salary numeric(12,2) not null default 0 check (salary >= 0),
  license_allowance numeric(12,2) not null default 0 check (license_allowance >= 0),
  ot_rate numeric(10,2) not null default 0 check (ot_rate >= 0),
  standard_hours integer not null default 176 check (standard_hours > 0),
  cycle_start_day integer not null default 25 check (cycle_start_day between 1 and 28),
  uncertainty_buffer numeric(10,2) not null default 500 check (uncertainty_buffer >= 0),
  confirmed_cycle date,
  notifications_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.shift_types (
  user_id uuid not null references public.profiles(id) on delete cascade,
  id text not null,
  name text not null check (char_length(name) between 1 and 40),
  start_time time not null,
  end_time time not null,
  premium numeric(10,2) not null default 0 check (premium >= 0),
  color text not null default '#A3416A',
  sort_order integer not null default 0,
  primary key (user_id, id)
);

create table if not exists public.shifts (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  shift_type_id text not null,
  work_date date not null,
  start_time time not null,
  end_time time not null,
  urgent_ot_hours integer not null default 0 check (urgent_ot_hours >= 0),
  note text check (char_length(note) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (user_id, shift_type_id) references public.shift_types(user_id, id)
);

create table if not exists public.financial_items (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('income', 'deduction')),
  label text not null check (char_length(label) between 1 and 80),
  amount numeric(12,2) not null check (amount >= 0),
  work_date date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.reminders (
  user_id uuid not null references public.profiles(id) on delete cascade,
  id text not null,
  offset_minutes integer not null check (offset_minutes > 0),
  enabled boolean not null default true,
  primary key (user_id, id)
);

create table if not exists public.notification_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  shift_id uuid not null references public.shifts(id) on delete cascade,
  reminder_id text not null,
  sent_at timestamptz not null default now(),
  unique (shift_id, reminder_id)
);

create index if not exists shifts_user_date_idx on public.shifts(user_id, work_date);
create index if not exists financial_items_user_date_idx on public.financial_items(user_id, work_date);
create index if not exists notification_logs_shift_idx on public.notification_logs(shift_id);

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.shift_types enable row level security;
alter table public.shifts enable row level security;
alter table public.financial_items enable row level security;
alter table public.reminders enable row level security;
alter table public.notification_logs enable row level security;

revoke all on public.profiles, public.user_settings, public.shift_types, public.shifts, public.financial_items, public.reminders, public.notification_logs from anon, authenticated;

create or replace view public.reminder_candidates
with (security_invoker = true)
as
select
  s.id as shift_id,
  s.user_id,
  p.line_user_id,
  st.name as shift_name,
  s.work_date,
  s.start_time,
  ((s.work_date::timestamp + s.start_time) at time zone 'Asia/Bangkok') as starts_at,
  (((s.work_date::timestamp + s.start_time) at time zone 'Asia/Bangkok') - make_interval(mins => r.offset_minutes)) as notify_at,
  r.id as reminder_id,
  r.offset_minutes
from public.shifts s
join public.profiles p on p.id = s.user_id
join public.user_settings us on us.user_id = s.user_id and us.notifications_enabled
join public.shift_types st on st.user_id = s.user_id and st.id = s.shift_type_id
join public.reminders r on r.user_id = s.user_id and r.enabled;

revoke all on public.reminder_candidates from anon, authenticated;

create or replace function public.replace_user_state(p_user_id uuid, p_state jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.user_settings
  set onboarding_complete = coalesce((p_state->'settings'->>'onboardingComplete')::boolean, false),
      salary = coalesce((p_state->'settings'->>'salary')::numeric, 0),
      license_allowance = coalesce((p_state->'settings'->>'licenseAllowance')::numeric, 0),
      ot_rate = coalesce((p_state->'settings'->>'otRate')::numeric, 0),
      standard_hours = coalesce((p_state->'settings'->>'standardHours')::integer, 176),
      cycle_start_day = coalesce((p_state->'settings'->>'cycleStartDay')::integer, 25),
      uncertainty_buffer = coalesce((p_state->'settings'->>'uncertaintyBuffer')::numeric, 500),
      confirmed_cycle = nullif(p_state->'settings'->>'confirmedCycle', '')::date,
      notifications_enabled = coalesce((p_state->'settings'->>'notificationsEnabled')::boolean, true),
      updated_at = now()
  where user_id = p_user_id;

  insert into public.shift_types (user_id, id, name, start_time, end_time, premium, color, sort_order)
  select p_user_id,
         item->>'id',
         item->>'name',
         (item->>'startTime')::time,
         (item->>'endTime')::time,
         coalesce((item->>'premium')::numeric, 0),
         coalesce(item->>'color', '#A3416A'),
         ordinality::integer
  from jsonb_array_elements(p_state->'shiftTypes') with ordinality as entries(item, ordinality)
  on conflict (user_id, id) do update
  set name = excluded.name,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      premium = excluded.premium,
      color = excluded.color,
      sort_order = excluded.sort_order;

  delete from public.notification_logs logs
  where logs.user_id = p_user_id
    and exists (
      select 1
      from public.shifts existing,
           jsonb_array_elements(coalesce(p_state->'shifts', '[]'::jsonb)) as entries(item)
      where existing.id = logs.shift_id
        and existing.id = (item->>'id')::uuid
        and (
          existing.shift_type_id is distinct from item->>'shiftTypeId'
          or existing.work_date is distinct from (item->>'workDate')::date
          or existing.start_time is distinct from (item->>'startTime')::time
          or existing.end_time is distinct from (item->>'endTime')::time
        )
    );

  delete from public.shifts existing
  where existing.user_id = p_user_id
    and not exists (
      select 1 from jsonb_array_elements(coalesce(p_state->'shifts', '[]'::jsonb)) as entries(item)
      where (item->>'id')::uuid = existing.id
    );

  insert into public.shifts (id, user_id, shift_type_id, work_date, start_time, end_time, urgent_ot_hours, note)
  select (item->>'id')::uuid,
         p_user_id,
         item->>'shiftTypeId',
         (item->>'workDate')::date,
         (item->>'startTime')::time,
         (item->>'endTime')::time,
         coalesce((item->>'urgentOtHours')::integer, 0),
         nullif(item->>'note', '')
  from jsonb_array_elements(coalesce(p_state->'shifts', '[]'::jsonb)) as entries(item)
  on conflict (id) do update
  set shift_type_id = excluded.shift_type_id,
      work_date = excluded.work_date,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      urgent_ot_hours = excluded.urgent_ot_hours,
      note = excluded.note,
      updated_at = now()
  where public.shifts.user_id = p_user_id;

  delete from public.shift_types existing
  where existing.user_id = p_user_id
    and not exists (
      select 1 from jsonb_array_elements(p_state->'shiftTypes') as entries(item)
      where item->>'id' = existing.id
    );

  delete from public.financial_items existing
  where existing.user_id = p_user_id
    and not exists (
      select 1 from jsonb_array_elements(coalesce(p_state->'financialItems', '[]'::jsonb)) as entries(item)
      where (item->>'id')::uuid = existing.id
    );

  insert into public.financial_items (id, user_id, kind, label, amount, work_date)
  select (item->>'id')::uuid,
         p_user_id,
         item->>'kind',
         item->>'label',
         coalesce((item->>'amount')::numeric, 0),
         (item->>'workDate')::date
  from jsonb_array_elements(coalesce(p_state->'financialItems', '[]'::jsonb)) as entries(item)
  on conflict (id) do update
  set kind = excluded.kind,
      label = excluded.label,
      amount = excluded.amount,
      work_date = excluded.work_date
  where public.financial_items.user_id = p_user_id;

  delete from public.notification_logs logs
  where logs.user_id = p_user_id
    and exists (
      select 1
      from public.reminders existing,
           jsonb_array_elements(coalesce(p_state->'reminders', '[]'::jsonb)) as entries(item)
      where existing.user_id = p_user_id
        and existing.id = logs.reminder_id
        and existing.id = item->>'id'
        and existing.offset_minutes is distinct from (item->>'offsetMinutes')::integer
    );

  delete from public.reminders existing
  where existing.user_id = p_user_id
    and not exists (
      select 1 from jsonb_array_elements(coalesce(p_state->'reminders', '[]'::jsonb)) as entries(item)
      where item->>'id' = existing.id
    );

  insert into public.reminders (user_id, id, offset_minutes, enabled)
  select p_user_id,
         item->>'id',
         (item->>'offsetMinutes')::integer,
         coalesce((item->>'enabled')::boolean, true)
  from jsonb_array_elements(coalesce(p_state->'reminders', '[]'::jsonb)) as entries(item)
  on conflict (user_id, id) do update
  set offset_minutes = excluded.offset_minutes,
      enabled = excluded.enabled;
end;
$$;

revoke all on function public.replace_user_state(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_user_state(uuid, jsonb) to service_role;
