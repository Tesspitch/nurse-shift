import { createClient } from 'npm:@supabase/supabase-js@2.112.3';
import { createLineWebhookProcessor } from '../_shared/application/line-webhook-processor.js';
import { verifyLineSignature } from '../_shared/line-bot.js';
import { createLineMessagingGateway } from '../_shared/infrastructure/line/line-messaging-gateway.js';
import { createLineUserDataRepository } from '../_shared/infrastructure/supabase/line-user-data-repository.js';
import { createWebhookEventRepository } from '../_shared/infrastructure/supabase/webhook-event-repository.js';

const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  secretKeys.default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);
const channelSecret = Deno.env.get('LINE_MESSAGING_CHANNEL_SECRET') ?? '';
const channelAccessToken = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') ?? '';
const liffUrl = (Deno.env.get('LINE_LIFF_URL') || 'https://liff.line.me/2012030979-CQQzGFWo').replace(/\/$/, '');
const webhookProcessor = createLineWebhookProcessor({
  webhookEventRepository: createWebhookEventRepository(supabase),
  lineUserDataRepository: createLineUserDataRepository(supabase),
  lineMessagingGateway: createLineMessagingGateway({ channelAccessToken }),
  liffUrl,
  richMenuPage2Id: Deno.env.get('LINE_RICH_MENU_PAGE_2_ID')
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!channelSecret || !channelAccessToken) return json({ error: 'SERVER_CONFIGURATION_ERROR' }, 500);
  if (Number(request.headers.get('content-length') || 0) > 1_000_000) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);

  const rawBody = await request.text();
  if (rawBody.length > 1_000_000) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
  const signature = request.headers.get('x-line-signature') || '';
  if (!(await verifyLineSignature(rawBody, signature, channelSecret))) return json({ error: 'INVALID_SIGNATURE' }, 401);

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: 'INVALID_JSON' }, 400);
  }

  try {
    await Promise.all((body.events || []).map(webhookProcessor.processEvent));
    return json({ ok: true });
  } catch {
    return json({ error: 'EVENT_PROCESSING_FAILED' }, 500);
  }
});
