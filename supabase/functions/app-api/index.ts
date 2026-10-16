import { createClient } from 'npm:@supabase/supabase-js@2.112.3';
import { createAppApiActions } from '../_shared/application/app-api-actions.js';
import { createGetMonthHistory } from '../_shared/application/get-month-history.js';
import { createHttpResponses } from '../_shared/http/app-api-http.js';
import { createLineIdentityGateway } from '../_shared/infrastructure/line/line-identity-gateway.js';
import { createLinePushGateway } from '../_shared/infrastructure/line/line-push-gateway.js';
import { createHistoryRepository } from '../_shared/infrastructure/supabase/history-repository.js';
import { createNotificationRuleRepository } from '../_shared/infrastructure/supabase/notification-rule-repository.js';
import { createUserStateRepository } from '../_shared/infrastructure/supabase/user-state-repository.js';

const DEFAULT_ORIGINS = ['https://costnurse.vercel.app', 'http://localhost:5173', 'http://127.0.0.1:5173'];
const allowedOrigins = new Set((Deno.env.get('ALLOWED_WEB_ORIGINS') || DEFAULT_ORIGINS.join(','))
  .split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean));
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  secretKeys.default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);

const http = createHttpResponses(allowedOrigins);
const identityGateway = createLineIdentityGateway({ channelId: Deno.env.get('LINE_LOGIN_CHANNEL_ID') });
const userStateRepository = createUserStateRepository(supabase);
const handleAction = createAppApiActions({
  userStateRepository,
  historyUseCase: createGetMonthHistory({ historyRepository: createHistoryRepository(supabase) }),
  notificationRuleRepository: createNotificationRuleRepository(supabase),
  linePushGateway: createLinePushGateway({ channelAccessToken: Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') })
});

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    if (http.requestOrigin(request) && !allowedOrigins.has(http.requestOrigin(request))) return http.json(request, { error: 'ORIGIN_NOT_ALLOWED' }, 403);
    return new Response('ok', { headers: http.corsHeaders(request) });
  }
  if (request.method !== 'POST') return http.json(request, { error: 'METHOD_NOT_ALLOWED' }, 405);
  const requestId = crypto.randomUUID();
  try {
    http.assertAllowedOrigin(request);
    if (Number(request.headers.get('content-length') || 0) > 1_000_000) throw new Error('PAYLOAD_TOO_LARGE');
    const lineUser = await identityGateway.authenticate(request);
    const profile = await userStateRepository.ensureProfile(lineUser);
    const rawBody = await request.text();
    if (rawBody.length > 1_000_000) throw new Error('PAYLOAD_TOO_LARGE');
    const { action, payload = {} } = JSON.parse(rawBody || '{}');
    return http.json(request, { data: await handleAction({ action, payload, profile, lineUser }) });
  } catch (error) {
    return http.error(request, error, requestId);
  }
});
