-- Keep user-owned roster/payroll data intact. Only disposable operational
-- notification and idempotency history is subject to automatic retention.

create or replace function public.cleanup_operational_data_v1(
  p_reference timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_notification_logs integer := 0;
  v_notification_jobs integer := 0;
  v_webhook_events integer := 0;
  v_dry_runs integer := 0;
  v_planner_runs integer := 0;
  v_today date := (p_reference at time zone 'Asia/Bangkok')::date;
begin
  -- Legacy delivery rows are needed for retry/idempotency only around the
  -- scheduled delivery. Terminal history older than 30 days has no app use.
  delete from public.notification_logs
  where (status = 'sent' and sent_at < p_reference - interval '30 days')
     or (status = 'failed'
         and coalesce(next_attempt_at, claimed_at, sent_at) < p_reference - interval '30 days')
     or (status = 'pending' and claimed_at < p_reference - interval '1 day');
  get diagnostics v_notification_logs = row_count;

  -- Deleting terminal/shadow jobs also removes their delivery attempts through
  -- the existing ON DELETE CASCADE foreign key. Active jobs are never touched.
  delete from public.notification_jobs
  where (status in ('sent', 'cancelled', 'dead')
         and coalesce(completed_at, updated_at) < p_reference - interval '30 days')
     or (status = 'shadow' and scheduled_for < p_reference - interval '30 days');
  get diagnostics v_notification_jobs = row_count;

  -- LINE retries happen shortly after the original webhook. Seven days keeps a
  -- conservative idempotency window without retaining an unlimited event log.
  delete from public.line_webhook_events
  where (status in ('completed', 'failed') and created_at < p_reference - interval '7 days')
     or (status = 'processing' and claimed_at < p_reference - interval '1 day');
  get diagnostics v_webhook_events = row_count;

  -- Dry-run rows are operational evidence only. User-owned historical records
  -- remain untouched and automatic user-data deletion stays disabled.
  delete from public.retention_dry_runs
  where expires_on < v_today - 30;
  get diagnostics v_dry_runs = row_count;

  delete from public.retention_planner_runs
  where run_date < v_today - 90;
  get diagnostics v_planner_runs = row_count;

  return jsonb_build_object(
    'notificationLogs', v_notification_logs,
    'notificationJobs', v_notification_jobs,
    'webhookEvents', v_webhook_events,
    'retentionDryRuns', v_dry_runs,
    'retentionPlannerRuns', v_planner_runs,
    'userDataDeleted', false
  );
end;
$$;

revoke all on function public.cleanup_operational_data_v1(timestamptz) from public, anon, authenticated;
grant execute on function public.cleanup_operational_data_v1(timestamptz) to service_role;

-- Reuse pg_cron when it is already enabled. The job runs at 03:17 Bangkok
-- (20:17 UTC) and does not enable any user-data expiration/deletion feature.
do $$
declare v_job_id bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_namespace where nspname = 'cron') then
    for v_job_id in
      select jobid from cron.job where jobname = 'nurseshift-operational-retention'
    loop
      perform cron.unschedule(v_job_id);
    end loop;
    perform cron.schedule(
      'nurseshift-operational-retention',
      '17 20 * * *',
      'select public.cleanup_operational_data_v1();'
    );
  end if;
end;
$$;
