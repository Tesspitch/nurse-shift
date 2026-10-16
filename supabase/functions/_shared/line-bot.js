import { bangkokMonthRange } from './domain/bangkok-calendar.js';
import { calculatePayrollSummary } from './domain/payroll.js';
import { workedHoursWithoutOverlap } from './domain/shift-time.js';

export const BOT_ACTIONS = new Set(['next_shift', 'monthly_income', 'ot_summary', 'day_off', 'monthly_shifts', 'help']);

export function parsePostbackAction(data = '') {
  const action = new URLSearchParams(data).get('action') || '';
  return BOT_ACTIONS.has(action) ? action : null;
}

export function isRichMenuNavigationPostback(data = '') {
  const action = new URLSearchParams(data).get('action') || '';
  return action === 'switch_quick_info' || action === 'switch_main';
}

export function canShowActionInSource(action, sourceType) {
  return action !== 'monthly_income' || sourceType === 'user';
}

export async function verifyLineSignature(rawBody, signature, channelSecret, subtle = crypto.subtle) {
  if (!signature || !channelSecret) return false;
  const encoder = new TextEncoder();
  const key = await subtle.importKey('raw', encoder.encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
  if (expected.length !== signature.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return difference === 0;
}

export { bangkokMonthRange, workedHoursWithoutOverlap };

export function calculateBotMonthSummary({ settings, shiftTypes = [], shifts = [], specialOtItems = [], dayOffs = [], financialItems = [] }) {
  return calculatePayrollSummary({ settings, shiftTypes, shifts, specialOtItems, dayOffs, financialItems });
}
