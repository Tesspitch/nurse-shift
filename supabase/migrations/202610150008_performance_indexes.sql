-- Phase 7: indexes justified by V2 cutover, rollback and operational status queries.

create index if not exists notification_jobs_user_active_idx
  on public.notification_jobs(user_id, status, scheduled_for)
  where status in ('shadow', 'pending', 'retry', 'leased');

create index if not exists notification_deliveries_job_completed_idx
  on public.notification_deliveries(job_id, completed_at desc);

