-- Stop treating an expected optimistic-concurrency conflict as PostgreSQL's
-- retryable serialization failure (40001). The API still maps the stable
-- STATE_VERSION_CONFLICT message to HTTP 409.
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
  select state_version into v_current_version
  from public.user_settings
  where user_id = p_user_id
  for update;

  if v_current_version is null or v_current_version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'STATE_VERSION_CONFLICT';
  end if;

  perform public.replace_user_state(p_user_id, p_state);
  if p_state ? 'specialOtItems' then perform public.replace_special_ot_items(p_user_id, p_state->'specialOtItems'); end if;
  if p_state ? 'dayOffs' then perform public.replace_day_offs(p_user_id, p_state->'dayOffs'); end if;

  update public.user_settings
  set expiration_notifications_enabled = coalesce((p_state->'settings'->>'expirationNotificationsEnabled')::boolean, true),
      state_version = state_version + 1,
      updated_at = now()
  where user_id = p_user_id
  returning state_version into v_next_version;

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

-- The production users are still on legacy/shadow delivery. A one-minute V2
-- poll therefore performs permanent idle work. Keep one five-minute legacy
-- worker (the minimum reminder granularity supported by the UI) and remove the
-- inactive V2 poll/recovery jobs until a controlled V2 cutover is approved.
do $$
declare v_job_id bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_namespace where nspname = 'cron') then
    return;
  end if;

  for v_job_id in
    select jobid from cron.job
    where jobname in (
      'send-nurse-shift-reminders',
      'send-nurse-shift-reminders-v2',
      'recover-nurse-shift-reminders-v2'
    )
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  if exists (select 1 from vault.decrypted_secrets where name = 'project_url')
     and exists (select 1 from vault.decrypted_secrets where name = 'publishable_key')
     and exists (select 1 from vault.decrypted_secrets where name = 'reminder_cron_secret') then
    perform cron.schedule(
      'send-nurse-shift-reminders',
      '*/5 * * * *',
      $command$
        select net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-reminders',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'),
            'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminder_cron_secret')
          ),
          body := '{}'::jsonb
        );
      $command$
    );
  end if;
end;
$$;
