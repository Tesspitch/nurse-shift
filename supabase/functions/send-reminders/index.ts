import { createClient } from 'npm:@supabase/supabase-js@2.112.3';
import { sendLinePush } from '../_shared/line-delivery.js';
import { nextRunAt, retryDelayMs } from '../_shared/notification-scheduling.js';
import { verifySchedulerInvocation } from '../_shared/scheduler-adapter.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  secretKeys.default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);

function thaiDate(value: string) {
  const date = new Date(`${value}T00:00:00+07:00`);
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(date);
}

function leadText(offsetMinutes: number) {
  if (offsetMinutes % 1440 === 0) return `ก่อน ${offsetMinutes / 1440} วัน`;
  if (offsetMinutes % 60 === 0) return `ก่อน ${offsetMinutes / 60} ชั่วโมง`;
  return `ก่อน ${offsetMinutes} นาที`;
}

function legacyRetryAt(attempts: number) {
  if (attempts >= 3) return null;
  return new Date(Date.now() + (attempts === 1 ? 5 : 10) * 60_000).toISOString();
}

function v2Message(job: Record<string, unknown>) {
  const payload = (job.payload || {}) as Record<string, unknown>;
  if (job.notification_type === 'shift_reminder') {
    return `แจ้งเตือนเวร (${leadText(Number(payload.offsetMinutes || 0))})\n${String(payload.shiftName || 'เวรของคุณ')}\n${thaiDate(String(payload.workDate))} เวลา ${String(payload.startTime || '').slice(0, 5)} น.`;
  }
  return String(payload.message || 'คุณมีการแจ้งเตือนจาก NurseShift');
}

async function isAuthorized(request: Request, body: string) {
  const cronSecret = Deno.env.get('REMINDER_CRON_SECRET') || '';
  if (cronSecret && request.headers.get('x-cron-secret') === cronSecret) return true;
  return verifySchedulerInvocation({
    body,
    timestamp: request.headers.get('x-scheduler-timestamp') || '',
    signature: request.headers.get('x-scheduler-signature') || '',
    secret: Deno.env.get('SCHEDULER_SIGNING_SECRET') || ''
  });
}

async function runLegacy() {
  const now = new Date();
  const { data: candidates, error } = await supabase.from('reminder_candidates').select('*')
    .gte('notify_at', new Date(now.getTime() - 30 * 60_000).toISOString())
    .lt('notify_at', new Date(now.getTime() + 4 * 60_000).toISOString());
  if (error) throw new Error(`REMINDER_QUERY_FAILED:${error.code}`);
  let claimed = 0;
  let sent = 0;
  let failed = 0;
  for (const candidate of candidates ?? []) {
    const { data: didClaim, error: claimError } = await supabase.rpc('claim_notification_delivery', {
      p_user_id: candidate.user_id, p_shift_id: candidate.shift_id, p_reminder_id: candidate.reminder_id
    });
    if (claimError || !didClaim) { if (claimError) failed += 1; continue; }
    claimed += 1;
    const { data: delivery } = await supabase.from('notification_logs').select('id, attempts')
      .eq('shift_id', candidate.shift_id).eq('reminder_id', candidate.reminder_id).single();
    const attempts = Number(delivery?.attempts || 1);
    const retryKey = String(delivery?.id || crypto.randomUUID());
    const result = await sendLinePush({
      to: candidate.line_user_id,
      messages: [{ type: 'text', text: `แจ้งเตือนเวร (${leadText(candidate.offset_minutes)})\n${candidate.shift_name}\n${thaiDate(candidate.work_date)} เวลา ${String(candidate.start_time).slice(0, 5)} น.` }],
      retryKey,
      channelAccessToken: Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') || ''
    });
    if (result.outcome === 'accepted' || result.outcome === 'accepted_duplicate') {
      const { error: updateError } = await supabase.from('notification_logs')
        .update({ status: 'sent', sent_at: new Date().toISOString(), next_attempt_at: null, last_error: null })
        .eq('shift_id', candidate.shift_id).eq('reminder_id', candidate.reminder_id).eq('status', 'pending');
      if (updateError) failed += 1; else sent += 1;
    } else {
      failed += 1;
      await supabase.from('notification_logs').update({
        status: 'failed',
        next_attempt_at: result.outcome === 'retry' ? legacyRetryAt(attempts) : null,
        last_error: String(result.errorCode || `LINE_${result.status}`).slice(0, 80)
      }).eq('shift_id', candidate.shift_id).eq('reminder_id', candidate.reminder_id).eq('status', 'pending');
    }
  }
  return { mode: 'legacy', checked: candidates?.length ?? 0, claimed, sent, failed };
}

async function runV2({ jobId = null, generation = null, recovery = false }: { jobId?: string | null; generation?: number | null; recovery?: boolean }) {
  const { data: jobs, error } = await supabase.rpc('claim_notification_jobs_v2', {
    p_limit: jobId ? 1 : 20, p_job_id: jobId, p_generation: generation, p_recovery: recovery
  });
  if (error) throw new Error(`V2_CLAIM_FAILED:${error.code}`);
  let sent = 0;
  let retried = 0;
  let dead = 0;
  for (const job of jobs ?? []) {
    const retryKey = String(job.job_id);
    const delivery = await sendLinePush({
      to: job.line_user_id,
      messages: [{ type: 'text', text: v2Message(job) }],
      retryKey,
      channelAccessToken: Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') || ''
    });
    const delay = delivery.outcome === 'retry' ? retryDelayMs(Number(job.attempts), Math.random()) : null;
    const retryAt = delay == null ? null : new Date(Date.now() + delay).toISOString();
    const next = delivery.outcome.startsWith('accepted')
      ? nextRunAt({ scheduleKind: job.schedule_kind, timezone: job.timezone, scheduleConfig: job.schedule_config }, new Date(job.scheduled_for))
      : null;
    const { data: finished, error: finishError } = await supabase.rpc('finish_notification_job_v2', {
      p_job_id: job.job_id,
      p_lease_token: job.lease_token,
      p_outcome: delivery.outcome,
      p_retry_key: retryKey,
      p_http_status: delivery.status || null,
      p_line_request_id: delivery.requestId || null,
      p_error_code: delivery.errorCode || (delivery.outcome === 'retry' ? `LINE_${delivery.status}` : null),
      p_retry_at: retryAt,
      p_next_scheduled_for: next?.toISOString() || null
    });
    if (finishError || !finished) {
      console.error(JSON.stringify({ event: 'V2_FINISH_REJECTED', jobId: job.job_id, code: finishError?.code || 'STALE_LEASE' }));
      continue;
    }
    if (delivery.outcome.startsWith('accepted')) sent += 1;
    else if (delivery.outcome === 'retry' && retryAt) retried += 1;
    else dead += 1;
  }
  return { mode: recovery ? 'v2-recovery' : jobId ? 'v2-job' : 'v2-batch', claimed: jobs?.length ?? 0, sent, retried, dead };
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const rawBody = await request.text();
  if (!(await isAuthorized(request, rawBody))) return jsonResponse({ error: 'UNAUTHORIZED' }, 401);
  try {
    const body = JSON.parse(rawBody || '{}');
    if (body.mode === 'v2-job'
      && (!/^[0-9a-fA-F-]{36}$/.test(String(body.jobId || '')) || !Number.isInteger(Number(body.generation)) || Number(body.generation) < 1)) {
      return jsonResponse({ error: 'INVALID_JOB_CALLBACK' }, 400);
    }
    const result: Record<string, unknown> = body.mode === 'v2-batch'
      ? await runV2({})
      : body.mode === 'v2-job'
        ? await runV2({ jobId: String(body.jobId || ''), generation: Number(body.generation) })
        : body.mode === 'v2-recovery'
          ? await runV2({ recovery: true })
          : await runLegacy();
    const hasFailures = Number(result.failed || 0) + Number(result.dead || 0) > 0;
    return jsonResponse(result, hasFailures ? 207 : 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'INTERNAL_ERROR';
    console.error(JSON.stringify({ event: 'REMINDER_WORKER_FAILED', code: message.split(':')[0] }));
    return jsonResponse({ error: message.split(':')[0] }, 500);
  }
});
