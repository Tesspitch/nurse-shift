import { createInitialState } from './seed.js';

const STORAGE_KEY = 'cost-nurse-state-v1';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class LocalService {
  constructor(profile = null) {
    this.profile = profile;
  }

  async bootstrap() {
    const saved = localStorage.getItem(STORAGE_KEY);
    const state = saved ? JSON.parse(saved) : createInitialState();
    if (this.profile) state.profile = this.profile;
    this.persist(state);
    return state;
  }

  persist(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  async save(state) {
    this.persist(state);
    return clone(state);
  }
}

class RemoteService {
  constructor({ baseUrl, publishableKey, idToken = null }) {
    this.endpoint = `${baseUrl.replace(/\/$/, '')}/functions/v1/app-api`;
    this.publishableKey = publishableKey;
    this.idToken = idToken;
  }

  async call(action, payload = {}) {
    const headers = {
      'Content-Type': 'application/json',
      apikey: this.publishableKey
    };
    if (this.idToken) headers['x-line-id-token'] = this.idToken;

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, payload })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'ไม่สามารถเชื่อมต่อระบบได้');
    return result.data;
  }

  bootstrap() {
    return this.call('bootstrap');
  }

  save(state) {
    return this.call('replace-state', state);
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
  return {
    idToken,
    profile: {
      displayName: lineProfile.displayName,
      pictureUrl: lineProfile.pictureUrl || ''
    }
  };
}

export async function createService() {
  const line = await initializeLine();
  const mockMode = import.meta.env.VITE_MOCK_MODE !== 'false';
  const baseUrl = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!mockMode && baseUrl && publishableKey) {
    return { service: new RemoteService({ baseUrl, publishableKey, idToken: line?.idToken }), mode: 'connected' };
  }
  return { service: new LocalService(line?.profile), mode: 'local' };
}
