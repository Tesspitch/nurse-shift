import { createClient } from 'npm:@supabase/supabase-js@2.112.3';
import { createAdminRepository } from '../_shared/infrastructure/supabase/admin-repository.js';
import { createFeedbackRepository } from '../_shared/infrastructure/supabase/feedback-repository.js';

const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  secretKeys.default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);
const adminRepository = createAdminRepository(supabase);
const feedbackRepository = createFeedbackRepository(supabase);
const allowedOrigins = new Set((Deno.env.get('ADMIN_WEB_ORIGINS') || 'https://costnurse.vercel.app,http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean));

function response(body: unknown, status = 200, request?: Request) {
  const origin = request?.headers.get('origin') || '';
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (allowedOrigins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type');
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Vary', 'Origin');
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(error: unknown, request: Request) {
  const message = error instanceof Error ? error.message : 'ADMIN_API_ERROR';
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) || 500 : 500;
  const safeErrors = new Set(['ADMIN_ACCESS_REQUIRED', 'INVALID_ACTION', 'INVALID_USER_ID', 'INVALID_STATUS', 'INVALID_FEEDBACK_ID']);
  return response({ error: safeErrors.has(message) ? message : 'ADMIN_API_ERROR' }, status, request);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return response({ ok: true }, 200, request);
  if (request.method !== 'POST') return response({ error: 'METHOD_NOT_ALLOWED' }, 405, request);
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return response({ error: 'AUTH_REQUIRED' }, 401, request);
  try {
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) return response({ error: 'AUTH_REQUIRED' }, 401, request);
    await adminRepository.assertAdmin(authData.user.id);
    const { action, payload = {} } = await request.json();
    if (action === 'list-users') return response({ data: await adminRepository.listUsers() }, 200, request);
    if (action === 'get-user') {
      const userId = String(payload.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(userId)) throw Object.assign(new Error('INVALID_USER_ID'), { status: 400 });
      return response({ data: await adminRepository.getUser(userId) }, 200, request);
    }
    if (action === 'set-user-status') {
      const userId = String(payload.id || '');
      const status = String(payload.status || '');
      if (!/^[0-9a-f-]{36}$/i.test(userId)) throw Object.assign(new Error('INVALID_USER_ID'), { status: 400 });
      if (!['active', 'blocked'].includes(status)) throw Object.assign(new Error('INVALID_STATUS'), { status: 400 });
      return response({ data: await adminRepository.setUserStatus(userId, status, String(payload.note || '').slice(0, 500)) }, 200, request);
    }
    if (action === 'list-feedback') return response({ data: await feedbackRepository.list() }, 200, request);
    if (action === 'update-feedback') {
      const id = String(payload.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw Object.assign(new Error('INVALID_FEEDBACK_ID'), { status: 400 });
      if (!['open', 'in_progress', 'resolved', 'closed'].includes(String(payload.status))) throw Object.assign(new Error('INVALID_STATUS'), { status: 400 });
      return response({ data: await feedbackRepository.update(id, { status: payload.status, adminNote: payload.adminNote }) }, 200, request);
    }
    throw Object.assign(new Error('INVALID_ACTION'), { status: 400 });
  } catch (error) {
    return errorResponse(error, request);
  }
});
