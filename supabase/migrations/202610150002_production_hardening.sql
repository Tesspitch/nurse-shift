-- Production hardening: optimistic concurrency, reminder delivery state and test-message throttling.

alter table public.user_settings
  add column if not exists state_version bigint not null default 0 check (state_version >= 0);

alter table public.profiles
  add column if not exists last_test_notification_at timestamptz;

alter table public.notification_logs
  alter column sent_at drop not null,
  alter column sent_at drop default;

alter table public.notification_logs
  add column if not exists status text not null default 'sent' check (status in ('pending', 'sent', 'failed')),
  add column if not exists attempts integer not null default 1 check (attempts between 0 and 3),
  add column if not exists claimed_at timestamptz,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists last_error text;

update public.notification_logs
set status = 'sent', attempts = greatest(attempts, 1)
where sent_at is not null;

create index if not exists notification_logs_retry_idx
  on public.notification_logs(status, next_attempt_at)
  where status in ('pending', 'failed');

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

create or replace function public.claim_notification_delivery(
  p_user_id uuid,
  p_shift_id uuid,
  p_reminder_id text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_claimed uuid;
begin
  insert into public.notification_logs (
    user_id, shift_id, reminder_id, status, attempts, claimed_at, sent_at, next_attempt_at, last_error
  ) values (
    p_user_id, p_shift_id, p_reminder_id, 'pending', 1, now(), null, null, null
  )
  on conflict (shift_id, reminder_id) do update
  set status = 'pending',
      attempts = public.notification_logs.attempts + 1,
      claimed_at = now(),
      next_attempt_at = null,
      last_error = null
  where public.notification_logs.status = 'failed'
        and public.notification_logs.attempts < 3
        and public.notification_logs.next_attempt_at <= now()
     or public.notification_logs.status = 'pending'
        and public.notification_logs.attempts < 3
        and public.notification_logs.claimed_at < now() - interval '10 minutes'
  returning id into v_claimed;

  return v_claimed is not null;
end;
$$;

revoke all on function public.claim_notification_delivery(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_notification_delivery(uuid, uuid, text) to service_role;

create or replace function public.claim_test_notification(p_user_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_claimed uuid;
begin
  update public.profiles
  set last_test_notification_at = now(), updated_at = now()
  where id = p_user_id
    and (last_test_notification_at is null or last_test_notification_at < now() - interval '1 minute')
  returning id into v_claimed;
  return v_claimed is not null;
end;
$$;

revoke all on function public.claim_test_notification(uuid) from public, anon, authenticated;
grant execute on function public.claim_test_notification(uuid) to service_role;
