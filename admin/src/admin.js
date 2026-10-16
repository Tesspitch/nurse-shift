const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const sessionKey = 'nurseshift-admin-session';
const $ = (selector, root = document) => root.querySelector(selector);
let users = [];
let feedback = [];

function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
function formatDate(value) { return value ? new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '-'; }
function setError(message) { $('#admin-error').textContent = message; $('#admin-error').hidden = !message; }
function setSession(session) { sessionStorage.setItem(sessionKey, JSON.stringify(session)); }
function getSession() { try { return JSON.parse(sessionStorage.getItem(sessionKey) || 'null'); } catch { return null; } }
async function signIn(email, password) {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error_description || 'เข้าสู่ระบบไม่สำเร็จ');
  setSession(result);
}
async function adminCall(action, payload = {}) {
  const session = getSession();
  if (!session?.access_token) throw new Error('กรุณาเข้าสู่ระบบใหม่');
  const response = await fetch(`${supabaseUrl}/functions/v1/admin-api`, { method: 'POST', headers: { apikey: publishableKey, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error === 'ADMIN_ACCESS_REQUIRED' ? 'บัญชีนี้ยังไม่มีสิทธิ์ผู้ดูแล' : result.error || 'ดำเนินการไม่สำเร็จ');
  return result.data;
}
function renderUsers() {
  const query = $('#user-search').value.trim().toLowerCase();
  const rows = users.filter((user) => `${user.display_name || ''} ${user.line_user_id || ''}`.toLowerCase().includes(query));
  $('#users-empty').hidden = rows.length > 0;
  $('#users-body').innerHTML = rows.map((user) => `<tr><td><div class="user-cell"><div class="avatar">${user.picture_url ? `<img class="avatar" src="${escapeHtml(user.picture_url)}" alt="">` : escapeHtml((user.display_name || 'ผ').slice(0, 1))}</div><div><b>${escapeHtml(user.display_name || 'ไม่ระบุชื่อ')}</b><div class="muted">${escapeHtml(user.line_user_id || user.id)}</div></div></div></td><td>${user.shiftCount || 0}</td><td><span class="status ${user.status}">${user.status === 'blocked' ? 'ระงับ' : 'ใช้งาน'}</span></td><td class="muted">${formatDate(user.updated_at)}</td><td><button class="table-action" data-user-id="${user.id}">ดูรายละเอียด</button></td></tr>`).join('');
}
async function loadUsers() { users = await adminCall('list-users'); renderUsers(); }
function renderFeedback() {
  const labels = { suggestion: 'ข้อเสนอแนะ', bug: 'ปัญหา', question: 'คำถาม', other: 'อื่น ๆ' };
  const statusLabels = { open: 'ใหม่', in_progress: 'กำลังดำเนินการ', resolved: 'แก้ไขแล้ว', closed: 'ปิดแล้ว' };
  $('#feedback-list').innerHTML = feedback.length ? feedback.map((item) => `<article class="feedback-card"><div class="feedback-meta"><span>${escapeHtml(item.profiles?.display_name || item.user_id)} · ${labels[item.category] || item.category}</span><span>${formatDate(item.created_at)}</span></div><h3>${escapeHtml(statusLabels[item.status] || item.status)}</h3><p>${escapeHtml(item.message)}</p><div class="feedback-controls"><select data-feedback-status="${item.id}">${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${value === item.status ? 'selected' : ''}>${label}</option>`).join('')}</select><input data-feedback-note="${item.id}" value="${escapeHtml(item.admin_note || '')}" placeholder="หมายเหตุผู้ดูแล"><button class="secondary" data-feedback-save="${item.id}">บันทึก</button></div></article>`).join('') : '<div class="empty">ยังไม่มีข้อเสนอแนะ</div>';
}
async function loadFeedback() { feedback = await adminCall('list-feedback'); renderFeedback(); }
function renderShiftCalendar(shifts, month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const byDate = new Map();
  shifts.forEach((shift) => { const list = byDate.get(shift.work_date) || []; list.push(shift); byDate.set(shift.work_date, list); });
  const cells = [];
  for (let index = 0; index < offset; index += 1) cells.push('<div class="calendar-day is-empty"></div>');
  for (let day = 1; day <= days; day += 1) {
    const date = `${year}-${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const entries = (byDate.get(date) || []).map((shift) => `<span class="calendar-shift">${escapeHtml(shift.shift_types?.name || shift.shift_type_id)} <small>${escapeHtml(String(shift.start_time).slice(0, 5))}–${escapeHtml(String(shift.end_time).slice(0, 5))}</small></span>`).join('');
    cells.push(`<div class="calendar-day"><b>${day}</b>${entries || '<span class="calendar-empty">—</span>'}</div>`);
  }
  return `<div class="calendar-toolbar"><button class="secondary" data-calendar-prev>‹</button><strong>${new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric' }).format(new Date(Date.UTC(year, monthNumber - 1, 1)))}</strong><button class="secondary" data-calendar-next>›</button></div><div class="calendar-weekdays">${['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'].map((day) => `<span>${day}</span>`).join('')}</div><div class="shift-calendar">${cells.join('')}</div>`;
}
async function openUser(userId) {
  const data = await adminCall('get-user', { id: userId });
  const profile = data.profile;
  const currentMonth = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit' }).format(new Date());
  let calendarMonth = currentMonth;
  $('#user-detail').innerHTML = `<p class="eyebrow">User detail</p><h2>${escapeHtml(profile.display_name || 'ไม่ระบุชื่อ')}</h2><p class="muted">${escapeHtml(profile.line_user_id || profile.id)}</p><div class="detail-grid"><div class="detail-stat"><span>เวรทั้งหมด</span><b>${data.shifts.length}</b></div><div class="detail-stat"><span>ข้อเสนอแนะ</span><b>${data.feedback.length}</b></div><div class="detail-stat"><span>สร้างบัญชี</span><b>${formatDate(profile.created_at)}</b></div></div><div class="control-form"><select id="user-status"><option value="active">ใช้งาน</option><option value="blocked">ระงับ</option></select><input id="user-note" maxlength="500" placeholder="หมายเหตุผู้ดูแล"><button class="primary" id="save-user-status">บันทึกสถานะ</button></div><h3>ปฏิทินเวร</h3><div id="user-shift-calendar">${renderShiftCalendar(data.shifts, currentMonth)}</div>`;
  $('#user-status').value = users.find((item) => item.id === userId)?.status || 'active';
  $('#user-note').value = users.find((item) => item.id === userId)?.adminNote || '';
  $('#save-user-status').addEventListener('click', async () => { await adminCall('set-user-status', { id: userId, status: $('#user-status').value, note: $('#user-note').value }); $('#user-dialog').close(); await loadUsers(); });
  $('#user-shift-calendar').addEventListener('click', (event) => { const direction = event.target.closest('[data-calendar-prev]') ? -1 : event.target.closest('[data-calendar-next]') ? 1 : 0; if (!direction) return; const next = new Date(`${calendarMonth}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + direction); calendarMonth = next.toISOString().slice(0, 7); $('#user-shift-calendar').innerHTML = renderShiftCalendar(data.shifts, calendarMonth); });
  $('#user-dialog').showModal();
}
function showApp() { $('#admin-login').hidden = true; $('#admin-app').hidden = false; Promise.all([loadUsers(), loadFeedback()]).catch((error) => setError(error.message)); }
$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#login-error').hidden = true; try { const form = new FormData(event.currentTarget); await signIn(form.get('email'), form.get('password')); showApp(); } catch (error) { $('#login-error').textContent = error.message; $('#login-error').hidden = false; } });
$('#logout').addEventListener('click', () => { sessionStorage.removeItem(sessionKey); location.reload(); });
$('#user-search').addEventListener('input', renderUsers);
$('#users-body').addEventListener('click', (event) => { const button = event.target.closest('[data-user-id]'); if (button) openUser(button.dataset.userId).catch((error) => setError(error.message)); });
$('#close-user-dialog').addEventListener('click', () => $('#user-dialog').close());
$('#refresh-feedback').addEventListener('click', () => loadFeedback().catch((error) => setError(error.message)));
document.querySelector('.admin-tabs').addEventListener('click', (event) => { const button = event.target.closest('[data-tab]'); if (!button) return; document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('is-active', item === button)); document.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== button.dataset.tab; }); });
$('#feedback-list').addEventListener('click', async (event) => { const button = event.target.closest('[data-feedback-save]'); if (!button) return; const id = button.dataset.feedbackSave; await adminCall('update-feedback', { id, status: $(`[data-feedback-status="${id}"]`).value, adminNote: $(`[data-feedback-note="${id}"]`).value }); await loadFeedback(); });
if (getSession()) showApp();
