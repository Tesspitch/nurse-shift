import { createInitialState } from './seed.js';
import { createGetMonthHistory } from './modules/history/application/get-month-history.js';
import { CachedHistoryRepository } from './infrastructure/history/cached-history-repository.js';

const STORAGE_KEY = 'cost-nurse-state-v1';
const REQUEST_TIMEOUT_MS = 15000;
let lineInitializationPromise;

export class ApiError extends Error {
  constructor(message, code = 'API_ERROR', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeState(state) {
  if (!state || typeof state !== 'object') throw new ApiError('ข้อมูลจากระบบไม่ถูกต้อง กรุณาลองเปิดใหม่', 'INVALID_REMOTE_STATE');
  if (!Array.isArray(state.shifts)) state.shifts = [];
  if (!Array.isArray(state.specialOtItems)) {
    state.specialOtItems = state.shifts
      .filter((shift) => Number(shift.urgentOtHours || 0) > 0)
      .map((shift) => ({
        id: crypto.randomUUID(),
        workDate: shift.workDate,
        hours: Math.floor(Number(shift.urgentOtHours)),
        note: shift.note || ''
      }));
  }
  state.shifts = state.shifts.map((shift) => ({ ...shift, urgentOtHours: 0 }));
  if (!Array.isArray(state.dayOffs)) state.dayOffs = [];
  if (typeof state.settings?.expirationNotificationsEnabled !== 'boolean') state.settings.expirationNotificationsEnabled = true;
  const palette = { '#B7791F': '#F59E0B', '#9B285B': '#8B5CF6', '#3559A8': '#2563EB' };
  state.shiftTypes = (state.shiftTypes || []).map((type) => ({ ...type, color: palette[type.color] || type.color }));
  if (!Array.isArray(state.financialItems)) state.financialItems = [];
  if (!Array.isArray(state.reminders)) state.reminders = [];
  return state;
}

class LocalService {
  constructor(profile = null) {
    this.profile = profile;
    this.historyRepository = new CachedHistoryRepository({ loadMonth: async () => null });
    this.getMonthHistoryUseCase = createGetMonthHistory({ historyRepository: this.historyRepository });
  }

  async bootstrap() {
    const saved = localStorage.getItem(STORAGE_KEY);
    const state = normalizeState(saved ? JSON.parse(saved) : createInitialState());
    state.version = Number(state.version || 0);
    if (this.profile) state.profile = this.profile;
    this.persist(state);
    return state;
  }

  persist(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  async save(state) {
    state.version = Number(state.version || 0) + 1;
    this.persist(state);
    this.historyRepository.clear();
    return clone(state);
  }

  async getMonthHistory(monthKey, state) {
    try {
      return await this.getMonthHistoryUseCase({ monthKey, currentState: state });
    } catch (error) {
      if (error.code === 'INVALID_HISTORY_MONTH') throw new ApiError(error.message, error.code);
      throw error;
    }
  }

  async testNotification() {
    throw new ApiError('ปุ่มทดสอบใช้ได้เมื่อเชื่อมต่อ LINE และ Supabase', 'LOCAL_MODE');
  }

  async deleteAccount() {
    localStorage.removeItem(STORAGE_KEY);
    return { deleted: true };
  }
}

class RemoteService {
  constructor({ baseUrl, publishableKey, idToken = null }) {
    this.endpoint = `${baseUrl.replace(/\/$/, '')}/functions/v1/app-api`;
    this.publishableKey = publishableKey;
    this.idToken = idToken;
    this.historyRepository = new CachedHistoryRepository({
      loadMonth: async (_userId, monthKey) => {
        try {
          return await this.call('month-history', { month: monthKey });
        } catch (error) {
          if (error.code !== 'UNKNOWN_ACTION') throw error;
          return null;
        }
      }
    });
    this.getMonthHistoryUseCase = createGetMonthHistory({ historyRepository: this.historyRepository });
    this.bootstrapRequest = null;
  }

  async call(action, payload = {}) {
    const headers = {
      'Content-Type': 'application/json',
      apikey: this.publishableKey
    };
    if (this.idToken) headers['x-line-id-token'] = this.idToken;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, payload }),
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const messages = {
          STATE_VERSION_CONFLICT: 'ข้อมูลถูกแก้ไขจากอีกอุปกรณ์ ระบบโหลดข้อมูลล่าสุดแล้ว',
          LINE_ID_TOKEN_INVALID: 'การเข้าสู่ระบบ LINE หมดอายุ กรุณาปิดและเปิดใหม่',
          NOTIFICATION_RATE_LIMITED: 'เพิ่งส่งข้อความทดสอบ กรุณารอ 1 นาที',
          LINE_PUSH_FAILED: 'ส่งข้อความไม่สำเร็จ กรุณาตรวจว่าเพิ่มเพื่อน Official Account แล้ว'
        };
        const code = result.error || 'API_ERROR';
        throw new ApiError(messages[code] || 'ระบบบันทึกข้อมูลไม่สำเร็จ กรุณาลองใหม่', code, response.status);
      }
      return result.data;
    } catch (error) {
      if (error.name === 'AbortError') throw new ApiError('เชื่อมต่อนานเกินไป กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่', 'REQUEST_TIMEOUT');
      if (error instanceof ApiError) throw error;
      throw new ApiError(navigator.onLine ? 'เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่' : 'อินเทอร์เน็ตขาดหาย ข้อมูลยังไม่ถูกบันทึก', 'NETWORK_ERROR');
    } finally {
      clearTimeout(timeout);
    }
  }

  bootstrap() {
    if (!this.bootstrapRequest) {
      this.bootstrapRequest = this.call('bootstrap')
        .then(normalizeState)
        .finally(() => { this.bootstrapRequest = null; });
    }
    return this.bootstrapRequest;
  }

  async save(state) {
    const result = await this.call('replace-state', state);
    const saved = result?.settings
      ? normalizeState(result)
      : normalizeState({ ...clone(state), version: Number(result?.version ?? state.version + 1) });
    this.historyRepository.clear();
    return saved;
  }

  async getMonthHistory(monthKey, state) {
    try {
      return await this.getMonthHistoryUseCase({ monthKey, currentState: state });
    } catch (error) {
      if (error.code === 'INVALID_HISTORY_MONTH') throw new ApiError(error.message, error.code);
      throw error;
    }
  }

  testNotification() {
    return this.call('test-notification');
  }

  deleteAccount() {
    return this.call('delete-account');
  }
}

async function initializeLine() {
  const liffId = import.meta.env.VITE_LIFF_ID;
  if (!liffId || !window.liff) return null;
  await window.liff.init({ liffId });
  if (!window.liff.isLoggedIn()) {
    window.liff.login({ redirectUri: window.location.href });
    return new Promise(() => {});
  }
  const idToken = window.liff.getIDToken();
  if (!idToken) throw new Error('LINE ไม่ได้ส่ง ID token กรุณาเปิด scope openid ใน LIFF');
  const lineProfile = await window.liff.getProfile();
  let friendship = null;
  try {
    friendship = await window.liff.getFriendship();
  } catch {
    // Friendship is unavailable when the LIFF app is not linked to an OA.
  }
  return {
    idToken,
    isFriend: friendship?.friendFlag ?? null,
    profile: {
      displayName: lineProfile.displayName,
      pictureUrl: lineProfile.pictureUrl || ''
    }
  };
}

function initializeLineOnce() {
  if (!lineInitializationPromise) lineInitializationPromise = initializeLine();
  return lineInitializationPromise;
}

export async function createService() {
  const line = await initializeLineOnce();
  const mockMode = import.meta.env.VITE_MOCK_MODE !== 'false';
  const baseUrl = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!mockMode && baseUrl && publishableKey) {
    if (!line?.idToken) throw new ApiError('กรุณาเปิดระบบผ่าน LINE เพื่อยืนยันบัญชี', 'LINE_LOGIN_REQUIRED');
    return { service: new RemoteService({ baseUrl, publishableKey, idToken: line.idToken }), mode: 'connected', isFriend: line.isFriend };
  }
  return { service: new LocalService(line?.profile), mode: 'local', isFriend: line?.isFriend ?? null };
}
