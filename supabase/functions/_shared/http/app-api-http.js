export const validationCodes = new Set([
  'INVALID_STATE', 'INVALID_SETTINGS', 'INVALID_STANDARD_HOURS', 'INVALID_CYCLE_START_DAY',
  'INVALID_COLLECTIONS', 'SHIFT_TYPES_REQUIRED', 'INVALID_SHIFT_TYPE', 'INVALID_SHIFT',
  'INVALID_SPECIAL_OT_ITEM', 'INVALID_DAY_OFF', 'INVALID_DAY_OFF_CONFLICT', 'INVALID_FINANCIAL_ITEM',
  'INVALID_REMINDER', 'INVALID_HISTORY_MONTH', 'DUPLICATE_ID', 'PAYLOAD_TOO_LARGE',
  'INVALID_NOTIFICATION_RULE', 'INVALID_SCHEDULE_KIND', 'INVALID_TIMEZONE', 'INVALID_SCHEDULE_TIME',
  'INVALID_SCHEDULE_AT', 'INVALID_SCHEDULE_WEEKDAY', 'INVALID_SCHEDULE_DAY'
]);

export function createHttpResponses(allowedOrigins) {
  const requestOrigin = (request) => (request.headers.get('origin') || '').replace(/\/$/, '');
  const corsHeaders = (request) => {
    const origin = requestOrigin(request);
    return {
      ...(origin && allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-line-id-token, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin'
    };
  };
  const json = (request, body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8' }
  });
  const assertAllowedOrigin = (request) => {
    const origin = requestOrigin(request);
    if (origin && !allowedOrigins.has(origin)) throw new Error('ORIGIN_NOT_ALLOWED');
  };
  const error = (request, cause, requestId) => {
    const message = cause instanceof Error ? cause.message : 'INTERNAL_ERROR';
    if (message === 'ORIGIN_NOT_ALLOWED') return json(request, { error: message }, 403);
    if (message.startsWith('LINE_')) return json(request, { error: message }, 401);
    if (message === 'STATE_VERSION_CONFLICT') return json(request, { error: message }, 409);
    if (message === 'NOTIFICATION_RATE_LIMITED') return json(request, { error: message }, 429);
    if (message === 'LINE_PUSH_FAILED') return json(request, { error: message }, 502);
    if (message === 'PAYLOAD_TOO_LARGE') return json(request, { error: message }, 413);
    if (message === 'UNKNOWN_ACTION') return json(request, { error: message }, 400);
    if (validationCodes.has(message) || cause instanceof SyntaxError) return json(request, { error: cause instanceof SyntaxError ? 'INVALID_JSON' : message }, 400);
    console.error(JSON.stringify({ requestId, error: message }));
    return json(request, { error: 'INTERNAL_ERROR', requestId }, 500);
  };
  return { requestOrigin, corsHeaders, json, assertAllowedOrigin, error };
}
