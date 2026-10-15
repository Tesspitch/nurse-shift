-- Phase 6: data-expiration notifications and retention dry run. No data deletion is implemented.

alter table public.user_settings
  add column if not exists expiration_notifications_enabled boolean not null default true;

create table if not exists public.retention_planner_runs (
  run_date date primary key,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.retention_dry_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  expiring_month date not null,
  expires_on date not null,
  shift_count integer not null default 0 check (shift_count >= 0),
  special_ot_count integer not null default 0 check (special_ot_count >= 0),
  day_off_count integer not null default 0 check (day_off_count >= 0),
  financial_item_count integer not null default 0 check (financial_item_count >= 0),
  notification_eligible boolean not null default false,
  deletion_enabled boolean not null default false check (deletion_enabled = false),
  checked_at timestamptz not null default now(),
  unique (user_id, expiring_month)
);

create index if not exists retention_dry_runs_month_idx on public.retention_dry_runs(expiring_month, user_id);
create unique index if not exists notification_rules_expiration_key_idx
  on public.notification_rules(user_id, (schedule_config->>'expiringMonth'), ((schedule_config->>'daysBefore')::integer))
  where notification_type = 'data_expiration';

alter table public.retention_planner_runs enable row level security;
alter table public.retention_dry_runs enable row level security;
revoke all on public.retention_planner_runs, public.retention_dry_runs from anon, authenticated;

create or replace function public.sync_data_expiration_preference_v2(p_user_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare v_enabled boolean;
begin
  select notifications_enabled and expiration_notifications_enabled into v_enabled
  from public.user_settings where user_id = p_user_id;
  if coalesce(v_enabled, false) then return; end if;

  update public.notification_rules
  set enabled = false, generation = generation + 1, updated_at = now()
  where user_id = p_user_id and notification_type = 'data_expiration' and enabled;

  update public.notification_jobs job
  set status = 'cancelled', lease_token = null, leased_until = null,
      last_error_code = 'EXPIRATION_NOTIFICATION_DISABLED', updated_at = now()
  from public.notification_rules rule
  where job.rule_id = rule.id and rule.user_id = p_user_id
    and rule.notification_type = 'data_expiration'
    and job.status in ('shadow', 'pending', 'retry', 'leased');
end;
$$;

revoke all on function public.sync_data_expiration_preference_v2(uuid) from public, anon, authenticated;
grant execute on function public.sync_data_expiration_preference_v2(uuid) to service_role;

create or replace function public.materialize_data_expiration_jobs_v2(
  p_reference timestamptz default now(),
  p_user_id uuid default null,
  p_force boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_local_date date := (p_reference at time zone 'Asia/Bangkok')::date;
  v_run_date date := (p_reference at time zone 'Asia/Bangkok')::date;
  v_expiring_month date := (date_trunc('month', (p_reference at time zone 'Asia/Bangkok')) - interval '2 months')::date;
  v_expiring_end date := (date_trunc('month', (p_reference at time zone 'Asia/Bangkok')) - interval '1 month')::date;
  v_expiry_date date := (date_trunc('month', (p_reference at time zone 'Asia/Bangkok')) + interval '1 month')::date;
  v_claimed_date date;
  v_user record;
  v_days integer;
  v_scheduled_for timestamptz;
  v_rule_id uuid;
  v_generation integer;
  v_mode text;
  v_config jsonb;
  v_planned integer := 0;
  v_users integer := 0;
begin
  if p_user_id is null and not p_force then
    insert into public.retention_planner_runs(run_date) values (v_run_date)
    on conflict (run_date) do nothing returning run_date into v_claimed_date;
    if v_claimed_date is null then return jsonb_build_object('skipped', true, 'reason', 'ALREADY_PLANNED_TODAY'); end if;
  end if;

  for v_user in
    select profile.id as user_id,
           profile.line_user_id,
           settings.notifications_enabled,
           settings.expiration_notifications_enabled,
           (select count(*) from public.shifts item where item.user_id = profile.id and item.work_date >= v_expiring_month and item.work_date < v_expiring_end)::integer as shift_count,
           (select count(*) from public.special_ot_items item where item.user_id = profile.id and item.work_date >= v_expiring_month and item.work_date < v_expiring_end)::integer as special_ot_count,
           (select count(*) from public.day_offs item where item.user_id = profile.id and item.work_date >= v_expiring_month and item.work_date < v_expiring_end)::integer as day_off_count,
           (select count(*) from public.financial_items item where item.user_id = profile.id and item.work_date >= v_expiring_month and item.work_date < v_expiring_end)::integer as financial_item_count
    from public.profiles profile
    join public.user_settings settings on settings.user_id = profile.id
    where p_user_id is null or profile.id = p_user_id
  loop
    if v_user.shift_count + v_user.special_ot_count + v_user.day_off_count + v_user.financial_item_count = 0 then continue; end if;
    v_users := v_users + 1;

    insert into public.retention_dry_runs(
      user_id, expiring_month, expires_on, shift_count, special_ot_count, day_off_count,
      financial_item_count, notification_eligible, deletion_enabled, checked_at
    ) values (
      v_user.user_id, v_expiring_month, v_expiry_date, v_user.shift_count, v_user.special_ot_count,
      v_user.day_off_count, v_user.financial_item_count,
      v_user.notifications_enabled and v_user.expiration_notifications_enabled and length(v_user.line_user_id) > 0,
      false, now()
    ) on conflict (user_id, expiring_month) do update
    set expires_on = excluded.expires_on,
        shift_count = excluded.shift_count,
        special_ot_count = excluded.special_ot_count,
        day_off_count = excluded.day_off_count,
        financial_item_count = excluded.financial_item_count,
        notification_eligible = excluded.notification_eligible,
        deletion_enabled = false,
        checked_at = now();

    if not (v_user.notifications_enabled and v_user.expiration_notifications_enabled and length(v_user.line_user_id) > 0) then continue; end if;
    insert into public.notification_delivery_modes(user_id, mode) values (v_user.user_id, 'shadow') on conflict (user_id) do nothing;
    select mode into v_mode from public.notification_delivery_modes where user_id = v_user.user_id;

    foreach v_days in array array[7, 3, 1]
    loop
      v_scheduled_for := (((v_expiry_date - v_days)::timestamp + time '09:00') at time zone 'Asia/Bangkok');
      if v_scheduled_for <= p_reference then continue; end if;
      v_config := jsonb_build_object(
        'at', to_char(v_scheduled_for at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'expiringMonth', to_char(v_expiring_month, 'YYYY-MM'),
        'expiryDate', to_char(v_expiry_date, 'YYYY-MM-DD'),
        'daysBefore', v_days,
        'payload', jsonb_build_object(
          'expiringMonth', to_char(v_expiring_month, 'YYYY-MM'),
          'expiryDate', to_char(v_expiry_date, 'YYYY-MM-DD'),
          'daysBefore', v_days
        )
      );

      select id, generation into v_rule_id, v_generation
      from public.notification_rules
      where user_id = v_user.user_id and notification_type = 'data_expiration'
        and schedule_config->>'expiringMonth' = to_char(v_expiring_month, 'YYYY-MM')
        and (schedule_config->>'daysBefore')::integer = v_days;

      if v_rule_id is null then
        insert into public.notification_rules(user_id, notification_type, schedule_kind, timezone, schedule_config)
        values (v_user.user_id, 'data_expiration', 'one_time', 'Asia/Bangkok', v_config)
        returning id, generation into v_rule_id, v_generation;
      else
        update public.notification_rules
        set enabled = true,
            generation = case when enabled then generation else generation + 1 end,
            schedule_config = v_config,
            updated_at = now()
        where id = v_rule_id
        returning generation into v_generation;
      end if;

      insert into public.notification_jobs(
        rule_id, user_id, notification_type, scheduled_for, status, generation, idempotency_key, payload
      ) values (
        v_rule_id, v_user.user_id, 'data_expiration', v_scheduled_for,
        case when v_mode = 'v2' then 'pending' else 'shadow' end,
        v_generation, public.notification_job_key(v_rule_id, v_generation, v_scheduled_for), v_config->'payload'
      ) on conflict (idempotency_key) do nothing;
      v_planned := v_planned + 1;
      v_rule_id := null;
    end loop;
  end loop;

  if p_user_id is null then update public.retention_planner_runs set completed_at = now() where run_date = v_run_date; end if;
  return jsonb_build_object(
    'skipped', false, 'expiringMonth', to_char(v_expiring_month, 'YYYY-MM'),
    'expiresOn', to_char(v_expiry_date, 'YYYY-MM-DD'), 'eligibleUsers', v_users, 'plannedJobs', v_planned,
    'deletionEnabled', false
  );
end;
$$;

revoke all on function public.materialize_data_expiration_jobs_v2(timestamptz, uuid, boolean) from public, anon, authenticated;
grant execute on function public.materialize_data_expiration_jobs_v2(timestamptz, uuid, boolean) to service_role;

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
  update public.user_settings
  set expiration_notifications_enabled = coalesce((p_state->'settings'->>'expirationNotificationsEnabled')::boolean, true),
      state_version = state_version + 1,
      updated_at = now()
  where user_id = p_user_id returning state_version into v_next_version;
  perform public.sync_shift_notification_jobs_v2(p_user_id);
  perform public.sync_data_expiration_preference_v2(p_user_id);
  if coalesce((p_state->'settings'->>'notificationsEnabled')::boolean, true)
     and coalesce((p_state->'settings'->>'expirationNotificationsEnabled')::boolean, true) then
    perform public.materialize_data_expiration_jobs_v2(now(), p_user_id, true);
  end if;
  return v_next_version;
end;
$$;

revoke all on function public.replace_user_state_v2(uuid, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.replace_user_state_v2(uuid, jsonb, bigint) to service_role;
