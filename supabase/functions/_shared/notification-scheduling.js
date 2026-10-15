const SCHEDULE_KINDS = new Set(['one_time', 'daily', 'weekly', 'monthly', 'shift_offset']);

function assertTime(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('INVALID_SCHEDULE_TIME');
}

export function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function validateNotificationRule(rule) {
  if (!rule || typeof rule !== 'object' || !SCHEDULE_KINDS.has(rule.scheduleKind)) throw new Error('INVALID_SCHEDULE_KIND');
  if (!isValidTimeZone(rule.timezone || 'Asia/Bangkok')) throw new Error('INVALID_TIMEZONE');
  const config = rule.scheduleConfig || {};
  if (rule.scheduleKind === 'one_time') {
    if (!config.at || !Number.isFinite(Date.parse(config.at))) throw new Error('INVALID_SCHEDULE_AT');
  } else if (rule.scheduleKind === 'daily') {
    assertTime(config.time);
  } else if (rule.scheduleKind === 'weekly') {
    assertTime(config.time);
    if (!Number.isInteger(config.weekday) || config.weekday < 0 || config.weekday > 6) throw new Error('INVALID_SCHEDULE_WEEKDAY');
  } else if (rule.scheduleKind === 'monthly') {
    assertTime(config.time);
    if (!Number.isInteger(config.day) || config.day < 1 || config.day > 31) throw new Error('INVALID_SCHEDULE_DAY');
  } else if (!config.at || !Number.isFinite(Date.parse(config.at))) {
    throw new Error('INVALID_SHIFT_OFFSET_AT');
  }
  return true;
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function localDateTimeToUtc(year, month, day, hour, minute, timeZone) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = desired;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = localParts(new Date(candidate), timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second || 0);
    const delta = desired - represented;
    candidate += delta;
    if (delta === 0) break;
  }
  const verified = localParts(new Date(candidate), timeZone);
  if (verified.year !== year || verified.month !== month || verified.day !== day || verified.hour !== hour || verified.minute !== minute) {
    return null;
  }
  return new Date(candidate);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function nextRunAt(rule, after = new Date()) {
  validateNotificationRule(rule);
  const afterDate = after instanceof Date ? after : new Date(after);
  const config = rule.scheduleConfig;
  if (rule.scheduleKind === 'one_time' || rule.scheduleKind === 'shift_offset') {
    const candidate = new Date(config.at);
    return candidate > afterDate ? candidate : null;
  }

  const timeZone = rule.timezone || 'Asia/Bangkok';
  const [hour, minute] = config.time.split(':').map(Number);
  const start = localParts(afterDate, timeZone);
  for (let offset = 0; offset <= 400; offset += 1) {
    const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    if (rule.scheduleKind === 'weekly' && cursor.getUTCDay() !== config.weekday) continue;
    if (rule.scheduleKind === 'monthly' && day !== Math.min(config.day, daysInMonth(year, month))) continue;
    const candidate = localDateTimeToUtc(year, month, day, hour, minute, timeZone);
    if (candidate && candidate > afterDate) return candidate;
  }
  return null;
}

export function notificationIdempotencyKey(ruleId, generation, scheduledFor) {
  const instant = scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor);
  if (!ruleId || !Number.isInteger(generation) || Number.isNaN(instant.getTime())) throw new Error('INVALID_IDEMPOTENCY_INPUT');
  return `${ruleId}:${generation}:${instant.toISOString()}`;
}

export function classifyLineResponse(status, acceptedRequestId = '') {
  if (status >= 200 && status < 300) return { outcome: 'accepted', requestId: acceptedRequestId || null };
  if (status === 409 && acceptedRequestId) return { outcome: 'accepted_duplicate', requestId: acceptedRequestId };
  if (status === 408 || status === 429 || status >= 500) return { outcome: 'retry' };
  return { outcome: 'permanent_failure' };
}

export function retryDelayMs(attempt, jitter = 0) {
  const delays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > delays.length) return null;
  const boundedJitter = Math.max(0, Math.min(1, Number(jitter) || 0));
  return delays[attempt - 1] + Math.floor(boundedJitter * 30_000);
}

export function canProcessJob(job, requestedGeneration) {
  return Boolean(job
    && ['pending', 'retry', 'leased'].includes(job.status)
    && job.ruleEnabled !== false
    && Number(job.generation) === Number(requestedGeneration)
    && Number(job.ruleGeneration) === Number(requestedGeneration));
}

