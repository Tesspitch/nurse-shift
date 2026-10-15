import { classifyLineResponse } from './notification-scheduling.js';

export async function sendLinePush({ to, messages, retryKey, channelAccessToken, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (!channelAccessToken) return { outcome: 'permanent_failure', status: 0, errorCode: 'LINE_TOKEN_MISSING' };
  if (!to || !Array.isArray(messages) || messages.length < 1 || !retryKey) {
    return { outcome: 'permanent_failure', status: 0, errorCode: 'INVALID_LINE_REQUEST' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${channelAccessToken}`,
        'Content-Type': 'application/json',
        'X-Line-Retry-Key': retryKey
      },
      body: JSON.stringify({ to, messages }),
      signal: controller.signal
    });
    const requestId = response.status === 409
      ? response.headers.get('x-line-accepted-request-id') || ''
      : response.headers.get('x-line-request-id') || '';
    return { ...classifyLineResponse(response.status, requestId), status: response.status };
  } catch (error) {
    return {
      outcome: 'retry',
      status: 0,
      errorCode: error?.name === 'AbortError' ? 'LINE_TIMEOUT' : 'LINE_NETWORK_ERROR'
    };
  } finally {
    clearTimeout(timeout);
  }
}

