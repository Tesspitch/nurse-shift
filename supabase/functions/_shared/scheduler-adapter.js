function hex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function signSchedulerBody(body, timestamp, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
}

export async function verifySchedulerInvocation({ body, timestamp, signature, secret, now = Date.now() }) {
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > 5 * 60_000) return false;
  const expected = await signSchedulerBody(body, timestamp, secret);
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return mismatch === 0;
}

export function createSchedulerAdapter({ provider = 'database', endpoint = '', token = '', fetchImpl = fetch } = {}) {
  if (provider === 'database') {
    return {
      provider,
      async register(job) { return { provider, reference: `database:${job.id}` }; },
      async cancel() { return { cancelled: true }; }
    };
  }
  if (provider !== 'external' || !endpoint || !token) throw new Error('SCHEDULER_NOT_CONFIGURED');
  return {
    provider,
    async register(job) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, generation: job.generation, scheduledFor: job.scheduledFor })
      });
      if (!response.ok) throw new Error('SCHEDULER_REGISTRATION_FAILED');
      const result = await response.json();
      return { provider, reference: String(result.id || '') };
    },
    async cancel(reference) {
      const response = await fetchImpl(`${endpoint}/${encodeURIComponent(reference)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok && response.status !== 404) throw new Error('SCHEDULER_CANCELLATION_FAILED');
      return { cancelled: true };
    }
  };
}
