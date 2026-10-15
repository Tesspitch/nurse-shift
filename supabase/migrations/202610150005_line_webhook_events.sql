-- Phase 4: idempotent LINE webhook processing. No existing data is changed.

create table if not exists public.line_webhook_events (
  event_id text primary key,
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  attempts integer not null default 1 check (attempts between 1 and 5),
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists line_webhook_events_cleanup_idx on public.line_webhook_events(created_at);

alter table public.line_webhook_events enable row level security;
revoke all on public.line_webhook_events from public, anon, authenticated;

create or replace function public.claim_line_webhook_event(p_event_id text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_claimed text;
begin
  if p_event_id is null or char_length(p_event_id) < 1 or char_length(p_event_id) > 200 then
    return false;
  end if;

  insert into public.line_webhook_events (event_id)
  values (p_event_id)
  on conflict (event_id) do update
  set status = 'processing',
      attempts = public.line_webhook_events.attempts + 1,
      claimed_at = now(),
      completed_at = null,
      last_error = null
  where (public.line_webhook_events.status = 'failed'
         or (public.line_webhook_events.status = 'processing'
             and public.line_webhook_events.claimed_at < now() - interval '2 minutes'))
    and public.line_webhook_events.attempts < 5
  returning event_id into v_claimed;

  return v_claimed is not null;
end;
$$;

revoke all on function public.claim_line_webhook_event(text) from public, anon, authenticated;
grant execute on function public.claim_line_webhook_event(text) to service_role;
