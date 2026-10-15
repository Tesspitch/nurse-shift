-- Phase 5: additive notification queue. Legacy reminders remain the default path.

create table if not exists public.notification_delivery_modes (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  mode text not null default 'shadow' check (mode in ('legacy', 'shadow', 'v2')),
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  notification_type text not null check (notification_type in ('shift_reminder', 'ot_reminder', 'custom', 'data_expiration')),
  schedule_kind text not null check (schedule_kind in ('one_time', 'daily', 'weekly', 'monthly', 'shift_offset')),
  timezone text not null default 'Asia/Bangkok' check (char_length(timezone) between 1 and 64),
  schedule_config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  generation integer not null default 1 check (generation > 0),
  source_shift_id uuid references public.shifts(id) on delete cascade,
  source_reminder_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((schedule_kind = 'shift_offset') = (source_shift_id is not null and source_reminder_id is not null))
);

create unique index if not exists notification_rules_shift_source_idx
  on public.notification_rules(user_id, source_shift_id, source_reminder_id)
  where schedule_kind = 'shift_offset';
create index if not exists notification_rules_user_idx on public.notification_rules(user_id, enabled);

create table if not exists public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.notification_rules(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  notification_type text not null,
  scheduled_for timestamptz not null,
  status text not null default 'shadow' check (status in ('shadow', 'pending', 'leased', 'retry', 'sent', 'cancelled', 'dead')),
  generation integer not null check (generation > 0),
  idempotency_key text not null unique,
  attempts integer not null default 0 check (attempts between 0 and 5),
  next_attempt_at timestamptz,
  lease_token uuid,
  leased_until timestamptz,
  scheduler_provider text not null default 'database' check (scheduler_provider in ('database', 'external')),
  scheduler_reference text,
  payload jsonb not null default '{}'::jsonb,
  last_error_code text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notification_jobs_due_idx
  on public.notification_jobs(coalesce(next_attempt_at, scheduled_for), id)
  where status in ('pending', 'retry');
create index if not exists notification_jobs_expired_lease_idx
  on public.notification_jobs(leased_until, id)
  where status = 'leased';
create index if not exists notification_jobs_rule_idx on public.notification_jobs(rule_id, generation, status);

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.notification_jobs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  retry_key uuid not null,
  attempt_number integer not null check (attempt_number between 1 and 5),
  status text not null check (status in ('accepted', 'accepted_duplicate', 'retry', 'permanent_failure')),
  http_status integer,
  line_request_id text,
  error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  unique (job_id, attempt_number)
);

create index if not exists notification_deliveries_user_idx on public.notification_deliveries(user_id, completed_at desc);

alter table public.notification_delivery_modes enable row level security;
alter table public.notification_rules enable row level security;
alter table public.notification_jobs enable row level security;
alter table public.notification_deliveries enable row level security;
revoke all on public.notification_delivery_modes, public.notification_rules, public.notification_jobs, public.notification_deliveries from anon, authenticated;

create or replace view public.reminder_candidates
with (security_invoker = true)
as
select
  shift.id as shift_id,
  shift.user_id,
  profile.line_user_id,
  shift_type.name as shift_name,
  shift.work_date,
  shift.start_time,
  ((shift.work_date::timestamp + shift.start_time) at time zone 'Asia/Bangkok') as starts_at,
  (((shift.work_date::timestamp + shift.start_time) at time zone 'Asia/Bangkok') - make_interval(mins => reminder.offset_minutes)) as notify_at,
  reminder.id as reminder_id,
  reminder.offset_minutes
from public.shifts shift
join public.profiles profile on profile.id = shift.user_id
join public.user_settings settings on settings.user_id = shift.user_id and settings.notifications_enabled
join public.shift_types shift_type on shift_type.user_id = shift.user_id and shift_type.id = shift.shift_type_id
join public.reminders reminder on reminder.user_id = shift.user_id and reminder.enabled
left join public.notification_delivery_modes delivery_mode on delivery_mode.user_id = shift.user_id
where coalesce(delivery_mode.mode, 'legacy') <> 'v2';

revoke all on public.reminder_candidates from anon, authenticated;

create or replace function public.notification_job_key(p_rule_id uuid, p_generation integer, p_scheduled_for timestamptz)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select p_rule_id::text || ':' || p_generation::text || ':' || to_char(p_scheduled_for at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

revoke all on function public.notification_job_key(uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.notification_job_key(uuid, integer, timestamptz) to service_role;

create or replace function public.sync_shift_notification_jobs_v2(p_user_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.notification_delivery_modes(user_id, mode)
  values (p_user_id, 'shadow')
  on conflict (user_id) do nothing;

  update public.notification_rules rule
  set enabled = false,
      generation = generation + 1,
      updated_at = now()
  where rule.user_id = p_user_id
    and rule.schedule_kind = 'shift_offset'
    and rule.enabled
    and not exists (
      select 1
      from public.shifts shift
      join public.reminders reminder on reminder.user_id = shift.user_id
      join public.user_settings settings on settings.user_id = shift.user_id
      where shift.user_id = p_user_id
        and shift.id = rule.source_shift_id
        and reminder.id = rule.source_reminder_id
        and reminder.enabled
        and settings.notifications_enabled
    );

  insert into public.notification_rules (
    user_id, notification_type, schedule_kind, timezone, schedule_config,
    enabled, source_shift_id, source_reminder_id
  )
  select shift.user_id,
         'shift_reminder',
         'shift_offset',
         'Asia/Bangkok',
         jsonb_build_object(
           'at', to_char((((shift.work_date::timestamp + shift.start_time) at time zone 'Asia/Bangkok') - make_interval(mins => reminder.offset_minutes)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'offsetMinutes', reminder.offset_minutes,
           'shiftName', shift_type.name,
           'workDate', shift.work_date,
           'startTime', shift.start_time
         ),
         settings.notifications_enabled and reminder.enabled,
         shift.id,
         reminder.id
  from public.shifts shift
  join public.shift_types shift_type on shift_type.user_id = shift.user_id and shift_type.id = shift.shift_type_id
  join public.reminders reminder on reminder.user_id = shift.user_id
  join public.user_settings settings on settings.user_id = shift.user_id
  where shift.user_id = p_user_id
  on conflict (user_id, source_shift_id, source_reminder_id) where schedule_kind = 'shift_offset'
  do update set
    generation = case
      when public.notification_rules.schedule_config is distinct from excluded.schedule_config
        or public.notification_rules.enabled is distinct from excluded.enabled
      then public.notification_rules.generation + 1
      else public.notification_rules.generation
    end,
    schedule_config = excluded.schedule_config,
    enabled = excluded.enabled,
    updated_at = now();

  update public.notification_jobs job
  set status = 'cancelled', lease_token = null, leased_until = null, updated_at = now()
  from public.notification_rules rule
  where job.rule_id = rule.id
    and rule.user_id = p_user_id
    and job.status in ('shadow', 'pending', 'retry', 'leased')
    and (not rule.enabled or job.generation <> rule.generation);

  insert into public.notification_jobs (
    rule_id, user_id, notification_type, scheduled_for, status, generation, idempotency_key, payload
  )
  select rule.id,
         rule.user_id,
         rule.notification_type,
         (rule.schedule_config->>'at')::timestamptz,
         case when mode.mode = 'v2' then 'pending' else 'shadow' end,
         rule.generation,
         public.notification_job_key(rule.id, rule.generation, (rule.schedule_config->>'at')::timestamptz),
         rule.schedule_config - 'at'
  from public.notification_rules rule
  join public.notification_delivery_modes mode on mode.user_id = rule.user_id
  where rule.user_id = p_user_id
    and rule.schedule_kind = 'shift_offset'
    and rule.enabled
    and (rule.schedule_config->>'at')::timestamptz > now() - interval '30 minutes'
  on conflict (idempotency_key) do nothing;
end;
$$;

revoke all on function public.sync_shift_notification_jobs_v2(uuid) from public, anon, authenticated;
grant execute on function public.sync_shift_notification_jobs_v2(uuid) to service_role;

create or replace function public.set_notification_delivery_mode_v2(p_user_id uuid, p_mode text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_mode not in ('legacy', 'shadow', 'v2') then raise exception 'INVALID_DELIVERY_MODE'; end if;
  insert into public.notification_delivery_modes(user_id, mode, updated_at)
  values (p_user_id, p_mode, now())
  on conflict (user_id) do update set mode = excluded.mode, updated_at = now();

  if p_mode = 'v2' then
    update public.notification_jobs job
    set status = 'pending', last_error_code = null, updated_at = now()
    from public.notification_rules rule
    where job.rule_id = rule.id and job.user_id = p_user_id
      and (job.status = 'shadow' or (job.status = 'cancelled' and job.last_error_code = 'DELIVERY_MODE_ROLLBACK'))
      and rule.enabled and rule.generation = job.generation
      and not exists (
        select 1 from public.notification_logs legacy
        where legacy.shift_id = rule.source_shift_id
          and legacy.reminder_id = rule.source_reminder_id
          and legacy.status = 'sent'
      );
  else
    update public.notification_jobs
    set status = 'cancelled', lease_token = null, leased_until = null,
        last_error_code = 'DELIVERY_MODE_ROLLBACK', updated_at = now()
    where user_id = p_user_id and status in ('pending', 'retry', 'leased');
  end if;
end;
$$;

revoke all on function public.set_notification_delivery_mode_v2(uuid, text) from public, anon, authenticated;
grant execute on function public.set_notification_delivery_mode_v2(uuid, text) to service_role;

create or replace function public.upsert_notification_rule_v2(
  p_user_id uuid,
  p_rule_id uuid,
  p_notification_type text,
  p_schedule_kind text,
  p_timezone text,
  p_schedule_config jsonb,
  p_scheduled_for timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_rule public.notification_rules;
  v_mode text;
begin
  if p_schedule_kind not in ('one_time', 'daily', 'weekly', 'monthly')
     or p_notification_type not in ('shift_reminder', 'ot_reminder', 'custom', 'data_expiration')
     or p_scheduled_for <= now() then
    raise exception 'INVALID_NOTIFICATION_RULE';
  end if;

  insert into public.notification_delivery_modes(user_id, mode)
  values (p_user_id, 'shadow') on conflict (user_id) do nothing;

  insert into public.notification_rules(id, user_id, notification_type, schedule_kind, timezone, schedule_config)
  values (coalesce(p_rule_id, gen_random_uuid()), p_user_id, p_notification_type, p_schedule_kind, p_timezone, p_schedule_config)
  on conflict (id) do update
  set notification_type = excluded.notification_type,
      schedule_kind = excluded.schedule_kind,
      timezone = excluded.timezone,
      schedule_config = excluded.schedule_config,
      enabled = true,
      generation = public.notification_rules.generation + 1,
      updated_at = now()
  where public.notification_rules.user_id = p_user_id
  returning * into v_rule;

  if v_rule.id is null then raise exception 'NOTIFICATION_RULE_NOT_FOUND'; end if;

  update public.notification_jobs
  set status = 'cancelled', lease_token = null, leased_until = null, updated_at = now()
  where rule_id = v_rule.id and generation <> v_rule.generation and status in ('shadow', 'pending', 'retry', 'leased');

  select mode into v_mode from public.notification_delivery_modes where user_id = p_user_id;
  insert into public.notification_jobs(rule_id, user_id, notification_type, scheduled_for, status, generation, idempotency_key, payload)
  values (v_rule.id, p_user_id, p_notification_type, p_scheduled_for,
          case when v_mode = 'v2' then 'pending' else 'shadow' end,
          v_rule.generation, public.notification_job_key(v_rule.id, v_rule.generation, p_scheduled_for),
          coalesce(p_schedule_config->'payload', '{}'::jsonb))
  on conflict (idempotency_key) do nothing;
  return v_rule.id;
end;
$$;

revoke all on function public.upsert_notification_rule_v2(uuid, uuid, text, text, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.upsert_notification_rule_v2(uuid, uuid, text, text, text, jsonb, timestamptz) to service_role;

create or replace function public.cancel_notification_rule_v2(p_user_id uuid, p_rule_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare v_changed uuid;
begin
  update public.notification_rules
  set enabled = false, generation = generation + 1, updated_at = now()
  where id = p_rule_id and user_id = p_user_id and enabled
  returning id into v_changed;
  if v_changed is null then return false; end if;
  update public.notification_jobs
  set status = 'cancelled', lease_token = null, leased_until = null, updated_at = now()
  where rule_id = p_rule_id and status in ('shadow', 'pending', 'retry', 'leased');
  return true;
end;
$$;

revoke all on function public.cancel_notification_rule_v2(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_notification_rule_v2(uuid, uuid) to service_role;

create or replace function public.claim_notification_jobs_v2(
  p_limit integer default 20,
  p_job_id uuid default null,
  p_generation integer default null,
  p_recovery boolean default false
)
returns table (
  job_id uuid, rule_id uuid, user_id uuid, generation integer, notification_type text,
  scheduled_for timestamptz, payload jsonb, lease_token uuid, attempts integer, line_user_id text,
  schedule_kind text, timezone text, schedule_config jsonb
)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_limit < 1 or p_limit > 100 then raise exception 'INVALID_CLAIM_LIMIT'; end if;

  if p_recovery then
    update public.notification_jobs
    set status = 'dead', lease_token = null, leased_until = null,
        last_error_code = 'MAX_ATTEMPTS_EXCEEDED', completed_at = now(), updated_at = now()
    where status = 'leased' and leased_until < now() and attempts >= 5;
    update public.notification_jobs
    set status = 'retry', next_attempt_at = now(), lease_token = null, leased_until = null,
        last_error_code = 'LEASE_EXPIRED', updated_at = now()
    where status = 'leased' and leased_until < now() and attempts < 5;
  end if;

  return query
  with claimable as (
    select job.id
    from public.notification_jobs job
    join public.notification_rules rule on rule.id = job.rule_id
    join public.notification_delivery_modes mode on mode.user_id = job.user_id and mode.mode = 'v2'
    where job.status in ('pending', 'retry')
      and coalesce(job.next_attempt_at, job.scheduled_for) <= now()
      and rule.enabled and rule.generation = job.generation
      and (p_job_id is null or job.id = p_job_id)
      and (p_generation is null or job.generation = p_generation)
    order by coalesce(job.next_attempt_at, job.scheduled_for), job.id
    for update of job skip locked
    limit p_limit
  ), claimed as (
    update public.notification_jobs job
    set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
        leased_until = now() + interval '5 minutes', updated_at = now()
    from claimable
    where job.id = claimable.id
    returning job.*
  )
  select claimed.id, claimed.rule_id, claimed.user_id, claimed.generation, claimed.notification_type,
         claimed.scheduled_for, claimed.payload, claimed.lease_token, claimed.attempts, profile.line_user_id,
         rule.schedule_kind, rule.timezone, rule.schedule_config
  from claimed
  join public.notification_rules rule on rule.id = claimed.rule_id
  join public.profiles profile on profile.id = claimed.user_id;
end;
$$;

revoke all on function public.claim_notification_jobs_v2(integer, uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.claim_notification_jobs_v2(integer, uuid, integer, boolean) to service_role;

create or replace function public.finish_notification_job_v2(
  p_job_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_retry_key uuid,
  p_http_status integer default null,
  p_line_request_id text default null,
  p_error_code text default null,
  p_retry_at timestamptz default null,
  p_next_scheduled_for timestamptz default null
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare v_job public.notification_jobs;
declare v_rule public.notification_rules;
declare v_mode text;
begin
  if p_outcome not in ('accepted', 'accepted_duplicate', 'retry', 'permanent_failure') then
    raise exception 'INVALID_DELIVERY_OUTCOME';
  end if;

  select * into v_job from public.notification_jobs
  where id = p_job_id and status = 'leased' and lease_token = p_lease_token
  for update;
  if v_job.id is null then return false; end if;
  select * into v_rule from public.notification_rules where id = v_job.rule_id;

  insert into public.notification_deliveries(
    job_id, user_id, retry_key, attempt_number, status, http_status, line_request_id, error_code
  ) values (
    v_job.id, v_job.user_id, p_retry_key, v_job.attempts, p_outcome, p_http_status,
    nullif(left(p_line_request_id, 120), ''), nullif(left(p_error_code, 80), '')
  ) on conflict (job_id, attempt_number) do nothing;

  update public.notification_jobs
  set status = case
        when p_outcome in ('accepted', 'accepted_duplicate') then 'sent'
        when p_outcome = 'retry' and attempts < 5 and p_retry_at is not null then 'retry'
        else 'dead'
      end,
      next_attempt_at = case when p_outcome = 'retry' and attempts < 5 then p_retry_at else null end,
      lease_token = null,
      leased_until = null,
      last_error_code = nullif(left(p_error_code, 80), ''),
      completed_at = case when p_outcome in ('accepted', 'accepted_duplicate', 'permanent_failure') or attempts >= 5 then now() else null end,
      updated_at = now()
  where id = v_job.id;

  if p_outcome in ('accepted', 'accepted_duplicate') and v_rule.schedule_kind = 'shift_offset' then
    insert into public.notification_logs(
      user_id, shift_id, reminder_id, status, attempts, claimed_at, sent_at, next_attempt_at, last_error
    ) values (
      v_job.user_id, v_rule.source_shift_id, v_rule.source_reminder_id, 'sent', 1, now(), now(), null, null
    )
    on conflict (shift_id, reminder_id) do update
    set status = 'sent', sent_at = now(), next_attempt_at = null, last_error = null;
  end if;

  if p_outcome in ('accepted', 'accepted_duplicate') and p_next_scheduled_for is not null
     and v_rule.enabled and v_rule.generation = v_job.generation then
    select mode into v_mode from public.notification_delivery_modes where user_id = v_job.user_id;
    insert into public.notification_jobs(rule_id, user_id, notification_type, scheduled_for, status, generation, idempotency_key, payload)
    values (v_job.rule_id, v_job.user_id, v_job.notification_type, p_next_scheduled_for,
            case when v_mode = 'v2' then 'pending' else 'shadow' end,
            v_job.generation, public.notification_job_key(v_job.rule_id, v_job.generation, p_next_scheduled_for), v_job.payload)
    on conflict (idempotency_key) do nothing;
  end if;
  return true;
end;
$$;

revoke all on function public.finish_notification_job_v2(uuid, uuid, text, uuid, integer, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.finish_notification_job_v2(uuid, uuid, text, uuid, integer, text, text, timestamptz, timestamptz) to service_role;

-- Preserve the public API contract while materialising V2 shadow jobs after every state mutation.
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
declare v_current_version bigint;
declare v_next_version bigint;
begin
  select state_version into v_current_version from public.user_settings where user_id = p_user_id for update;
  if v_current_version is null or v_current_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'STATE_VERSION_CONFLICT';
  end if;
  perform public.replace_user_state(p_user_id, p_state);
  if p_state ? 'specialOtItems' then perform public.replace_special_ot_items(p_user_id, p_state->'specialOtItems'); end if;
  if p_state ? 'dayOffs' then perform public.replace_day_offs(p_user_id, p_state->'dayOffs'); end if;
  update public.user_settings set state_version = state_version + 1, updated_at = now()
  where user_id = p_user_id returning state_version into v_next_version;
  perform public.sync_shift_notification_jobs_v2(p_user_id);
  return v_next_version;
end;
$$;

revoke all on function public.replace_user_state_v2(uuid, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.replace_user_state_v2(uuid, jsonb, bigint) to service_role;
