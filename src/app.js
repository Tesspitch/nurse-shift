import { calculatePayroll, findOverlaps } from './calculations.js';
import {
  calendarCells,
  formatDateInput,
  formatThaiDate,
  fromIsoDate,
  maskDateInput,
  parseDateInput,
  shiftMonth,
  thaiMonthYear,
  toIsoDate
} from './date.js';
import { createService } from './service.js';
import { readNavigationIntent } from './navigation.js';
import { createBackup, createCsv, reminderLabel, restoreBackup } from './data-transfer.js';

const numberFormat = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });
const currencyFormat = new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const todayIso = toIsoDate(new Date());
let selectedDate = todayIso;
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let calendarExpanded = false;
let state;
let dataService;
let serviceMode = 'local';
let toastTimer;
let pendingNavigation = null;
let lineFriendship = null;
let settingsPanel = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (value) => currencyFormat.format(Number(value || 0)).replace('฿', '฿');
const plainMoney = (value) => `${numberFormat.format(Number(value || 0))} บาท`;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showToast(message) {
  clearTimeout(toastTimer);
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2400);
}

function cycleText(cycle) {
  return `${formatThaiDate(cycle.start)} – ${formatThaiDate(cycle.end)}`;
}

function currentPayroll() {
  return calculatePayroll(state, new Date());
}

async function commit(change, successMessage) {
  const previous = structuredClone(state);
  change();
  renderAll();
  try {
    state = await dataService.save(state);
    renderAll();
    if (successMessage) showToast(successMessage);
    return true;
  } catch (error) {
    if (error.code === 'STATE_VERSION_CONFLICT') {
      try {
        state = await dataService.bootstrap();
      } catch {
        state = previous;
      }
    } else {
      state = previous;
    }
    renderAll();
    showToast(error.message || 'บันทึกไม่สำเร็จ กรุณาลองใหม่');
    return false;
  }
}

function setProfile() {
  const profile = state.profile || { displayName: 'ผู้ใช้งาน', pictureUrl: '' };
  const badge = $('#profile-badge');
  if (profile.pictureUrl) {
    badge.innerHTML = `<img src="${escapeHtml(profile.pictureUrl)}" alt="รูปของ ${escapeHtml(profile.displayName)}">`;
  } else {
    badge.innerHTML = `<span>${escapeHtml(profile.displayName.charAt(0) || 'ผ')}</span>`;
  }
}

function renderHome(payroll) {
  $('#cycle-label').textContent = `รอบ ${cycleText(payroll.cycle)}`;
  $('#summary-status').textContent = payroll.confirmed ? 'ข้อมูลครบแล้ว' : 'ประมาณการ';
  $('#net-display').textContent = payroll.confirmed
    ? money(payroll.net)
    : `${money(payroll.estimateLow)}–${numberFormat.format(payroll.estimateHigh)}`;
  $('#net-help').textContent = payroll.confirmed
    ? 'ยืนยันข้อมูลรอบนี้แล้ว'
    : `ช่วงประมาณการรวมค่าเผื่อ ±${numberFormat.format(state.settings.uncertaintyBuffer)} บาท`;
  $('#worked-hours').textContent = `${numberFormat.format(payroll.workedHours)} / ${numberFormat.format(state.settings.standardHours)} ชม.`;
  $('#ot-hours').textContent = `${numberFormat.format(payroll.automaticOtHours + payroll.specialOtHours)} ชม.`;

  const upcoming = state.shifts
    .filter((shift) => `${shift.workDate}T${shift.startTime}` >= `${todayIso}T00:00`)
    .sort((a, b) => `${a.workDate}T${a.startTime}`.localeCompare(`${b.workDate}T${b.startTime}`))[0];
  const nextShift = $('#next-shift');
  if (!upcoming) {
    nextShift.innerHTML = '<div class="empty-card"><b>ยังไม่มีเวรถัดไป</b><span>แตะ “เพิ่มเวร” เพื่อเริ่มบันทึกตาราง</span></div>';
  } else {
    const type = state.shiftTypes.find((item) => item.id === upcoming.shiftTypeId);
    const date = fromIsoDate(upcoming.workDate);
    nextShift.innerHTML = `
      <div class="next-card">
        <div class="date-tile"><b>${date.getDate()}</b><span>${new Intl.DateTimeFormat('th-TH', { month: 'short' }).format(date)}</span></div>
        <div class="content"><b>${escapeHtml(type?.name || 'เวร')}</b><span>${upcoming.startTime}–${upcoming.endTime} น.</span></div>
        <span class="premium-tag">+${numberFormat.format(type?.premium || 0)}</span>
      </div>`;
  }

  $('#home-breakdown').innerHTML = breakdownRows(payroll, false);
}

function breakdownRows(payroll, includeTotal = true) {
  const rows = [
    ['ฐานเงินเดือน', state.settings.salary],
    ['ค่าใบประกอบ', state.settings.licenseAllowance],
    [`ค่าเวร (${payroll.shifts.length} เวร)`, payroll.shiftPremium],
    [`OT ${numberFormat.format(payroll.automaticOtHours + payroll.specialOtHours)} ชม.`, payroll.otIncome],
    ['รายรับเพิ่มเติม', payroll.otherIncome],
    ['รายการหัก', -payroll.deductions, 'deduction']
  ];
  if (includeTotal) rows.push(['ยอดสุทธิ', payroll.net, 'total']);
  return rows.map(([label, value, className = '']) => `
    <div class="breakdown-row ${className}"><span>${escapeHtml(label)}</span><b>${value < 0 ? '−' : ''}${money(Math.abs(value))}</b></div>
  `).join('');
}

function renderCalendar() {
  $('#calendar-title').textContent = thaiMonthYear(calendarMonth);
  $('#calendar-toggle').setAttribute('aria-pressed', String(calendarExpanded));
  $('#calendar-toggle span').textContent = calendarExpanded ? 'ย่อ' : 'ขยาย';

  const shiftsByDate = state.shifts.reduce((groups, shift) => {
    if (!groups.has(shift.workDate)) groups.set(shift.workDate, []);
    groups.get(shift.workDate).push(shift);
    return groups;
  }, new Map());
  const specialOtByDate = state.specialOtItems.reduce((groups, item) => {
    if (!groups.has(item.workDate)) groups.set(item.workDate, []);
    groups.get(item.workDate).push(item);
    return groups;
  }, new Map());
  $('#calendar-grid').classList.toggle('is-expanded', calendarExpanded);
  $('#calendar-grid').innerHTML = calendarCells(calendarMonth).map((cell) => {
    const shifts = shiftsByDate.get(cell.iso) || [];
    const specialOtItems = specialOtByDate.get(cell.iso) || [];
    const typeItems = shifts.map((shift) => state.shiftTypes.find((type) => type.id === shift.shiftTypeId)).filter(Boolean);
    const labels = `${typeItems.map((type) => `<span style="--dot-color:${type.color}">${escapeHtml(type.name.replace('เวร', ''))}</span>`).join('')}${specialOtItems.length ? '<span style="--dot-color:#DB2777">OT</span>' : ''}`;
    const dots = `${typeItems.map((type) => `<i style="--dot-color:${type.color}"></i>`).join('')}${specialOtItems.length ? '<i style="--dot-color:#DB2777"></i>' : ''}`;
    const classes = [!cell.currentMonth && 'is-outside', cell.iso === todayIso && 'is-today', cell.iso === selectedDate && 'is-selected'].filter(Boolean).join(' ');
    return `<button class="calendar-day ${classes}" data-date="${cell.iso}" aria-label="${formatThaiDate(cell.iso)}${typeItems.length ? ` มี ${typeItems.map((type) => type.name).join(' และ')}` : ''}${specialOtItems.length ? ' มี OT พิเศษ' : ''} แตะเพื่อเพิ่มเวร"><span class="day-number">${cell.day}</span><span class="day-dots">${dots}</span><span class="day-labels">${labels}</span></button>`;
  }).join('');

  $('#shift-legend').innerHTML = `${state.shiftTypes.map((type) => `<span><i style="--dot-color:${type.color}"></i>${escapeHtml(type.name)}</span>`).join('')}<span><i style="--dot-color:#DB2777"></i>OT พิเศษ</span>`;
  $('#selected-date-title').textContent = formatThaiDate(selectedDate, true);
  const selectedShifts = (shiftsByDate.get(selectedDate) || []).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const selectedSpecialOt = specialOtByDate.get(selectedDate) || [];
  $('#selected-shifts').innerHTML = selectedShifts.length || selectedSpecialOt.length
    ? `<div class="shift-list">${selectedShifts.map(shiftItemHtml).join('')}${selectedSpecialOt.map(specialOtItemHtml).join('')}</div>`
    : '<div class="empty-card"><b>วันนี้ยังไม่มีเวร</b><span>แตะวันที่หรือปุ่มเพิ่มเวรเพื่อบันทึก</span></div>';
}

function shiftItemHtml(shift) {
  const type = state.shiftTypes.find((item) => item.id === shift.shiftTypeId);
  return `<article class="shift-item"><i class="shift-bar" style="--type-color:${type?.color || '#a3416a'}"></i><div class="content"><b>${escapeHtml(type?.name || 'เวร')}</b><span>${shift.startTime}–${shift.endTime} น. · ${plainMoney(type?.premium || 0)}</span></div><button class="delete-button" data-delete-shift="${shift.id}" aria-label="ลบ ${escapeHtml(type?.name || 'เวร')}"><svg><use href="#i-trash"/></svg></button></article>`;
}

function specialOtItemHtml(item) {
  return `<article class="shift-item"><i class="shift-bar" style="--type-color:#DB2777"></i><div class="content"><b>OT พิเศษ ${numberFormat.format(item.hours)} ชม.</b><span>${escapeHtml(item.note || 'ไม่มีหมายเหตุ')}</span></div><button class="text-button" type="button" data-edit-special-ot="${item.id}">แก้ไข</button><button class="delete-button" type="button" data-delete-special-ot="${item.id}" aria-label="ลบ OT พิเศษ"><svg><use href="#i-trash"/></svg></button></article>`;
}

function renderFinance(payroll) {
  $('#finance-net').textContent = payroll.confirmed ? money(payroll.net) : `${money(payroll.estimateLow)}–${numberFormat.format(payroll.estimateHigh)}`;
  $('#finance-cycle').textContent = `รอบ ${cycleText(payroll.cycle)}`;
  $('#finance-breakdown').innerHTML = breakdownRows(payroll);
  $('#confirm-cycle').checked = payroll.confirmed;
  $('#financial-items').innerHTML = payroll.items.length
    ? payroll.items.map((item) => `<article class="financial-item ${item.kind === 'deduction' ? 'is-deduction' : ''}"><div class="content"><b>${escapeHtml(item.label)}</b><span>${formatThaiDate(item.workDate)}</span></div><b class="amount">${item.kind === 'deduction' ? '−' : '+'}${money(item.amount)}</b><button class="delete-button" data-delete-item="${item.id}" aria-label="ลบ ${escapeHtml(item.label)}"><svg><use href="#i-trash"/></svg></button></article>`).join('')
    : '<div class="empty-card"><b>ยังไม่มีรายการเพิ่ม</b><span>เพิ่มภาษี ประกันสังคม รายรับ หรือรายจ่ายอื่นได้เอง</span></div>';
  $('#special-ot-items').innerHTML = payroll.specialOtItems.length
    ? `<div class="shift-list">${payroll.specialOtItems.map((item) => `<article class="shift-item"><i class="shift-bar" style="--type-color:#DB2777"></i><div class="content"><b>${formatThaiDate(item.workDate)} · ${numberFormat.format(item.hours)} ชม.</b><span>${escapeHtml(item.note || 'ไม่มีหมายเหตุ')}</span></div><button class="text-button" type="button" data-edit-special-ot="${item.id}">แก้ไข</button><button class="delete-button" type="button" data-delete-special-ot="${item.id}" aria-label="ลบ OT พิเศษ"><svg><use href="#i-trash"/></svg></button></article>`).join('')}</div>`
    : '<div class="empty-card"><b>ยังไม่มี OT พิเศษ</b><span>เพิ่มชั่วโมงจากเหตุการณ์นอกเวรได้โดยไม่ต้องเลือกประเภทเวร</span></div>';
}

function renderSettings() {
  const form = $('#settings-form');
  for (const name of ['salary', 'licenseAllowance', 'otRate', 'standardHours', 'cycleStartDay']) form.elements[name].value = state.settings[name];
  form.elements.notificationsEnabled.checked = state.settings.notificationsEnabled;
  $('#settings-profile-name').textContent = state.profile.displayName || 'ข้อมูลจากบัญชี LINE';
  $('#settings-profile-display-name').textContent = state.profile.displayName || 'ผู้ใช้งาน';
  $('#settings-notification-summary').textContent = state.settings.notificationsEnabled ? `เปิด · ${state.reminders.filter((item) => item.enabled).length} เวลา` : 'ปิดใช้งาน';
  const profilePicture = $('#settings-profile-picture');
  profilePicture.innerHTML = state.profile.pictureUrl
    ? `<img src="${escapeHtml(state.profile.pictureUrl)}" alt="รูปของ ${escapeHtml(state.profile.displayName)}">`
    : `<span>${escapeHtml(state.profile.displayName?.charAt(0) || 'ผ')}</span>`;
  $('#shift-type-settings').innerHTML = state.shiftTypes.map((type) => `
    <div class="shift-type-setting" data-type-id="${type.id}">
      <div class="type-name"><i style="--type-color:${type.color}"></i>${escapeHtml(type.name)}</div>
      <label class="field"><span>เริ่ม</span><input type="time" data-type-field="startTime" value="${type.startTime}"></label>
      <label class="field"><span>สิ้นสุด</span><input type="time" data-type-field="endTime" value="${type.endTime}"></label>
      <label class="field"><span>ค่าเพิ่ม (บาท)</span><input type="number" min="0" data-type-field="premium" value="${type.premium}" inputmode="decimal"></label>
    </div>`).join('');
  $('#reminder-settings').innerHTML = state.reminders.length
    ? state.reminders.map((reminder) => `<div class="reminder-row"><span>${reminderLabel(reminder.offsetMinutes)}</span><span class="reminder-controls"><label class="switch" aria-label="${reminder.enabled ? 'ปิด' : 'เปิด'} ${reminderLabel(reminder.offsetMinutes)}"><input type="checkbox" data-reminder-id="${reminder.id}" ${reminder.enabled ? 'checked' : ''}><i></i></label><button class="delete-button" type="button" data-delete-reminder="${reminder.id}" aria-label="ลบ ${reminderLabel(reminder.offsetMinutes)}"><svg><use href="#i-trash"/></svg></button></span></div>`).join('')
    : '<div class="empty-card"><b>ยังไม่มีเวลาแจ้งเตือน</b><span>เพิ่มเวลาที่ต้องการด้านล่าง</span></div>';
  const status = $('#line-status');
  status.classList.toggle('is-warning', serviceMode !== 'connected' || lineFriendship === false);
  status.querySelector('span').textContent = serviceMode !== 'connected'
    ? 'โหมดทดสอบในเครื่อง ยังไม่ส่งข้อความ LINE'
    : lineFriendship === false
      ? 'ยังไม่ได้เพิ่ม Official Account เป็นเพื่อน จึงรับการแจ้งเตือนไม่ได้'
      : lineFriendship === true
        ? 'เชื่อมต่อ LINE และเพิ่ม Official Account แล้ว'
        : 'เชื่อมต่อ LINE แล้ว กดส่งข้อความทดสอบเพื่อยืนยัน';
  $('#add-line-friend').hidden = serviceMode !== 'connected' || lineFriendship === true;
  $('#profile-connection-status').textContent = serviceMode !== 'connected'
    ? 'โหมดทดสอบในเครื่อง'
    : lineFriendship === false ? 'ยังไม่ได้เพิ่มเพื่อน' : 'เชื่อมต่อ LINE แล้ว';
  $('#notification-options').disabled = !state.settings.notificationsEnabled;
  $('#mode-note').textContent = serviceMode === 'connected'
    ? 'เชื่อมต่อ LINE และ Supabase แล้ว ข้อมูลจะถูกบันทึกในบัญชีของคุณ'
    : 'ขณะนี้เป็นโหมดทดสอบในเครื่อง ข้อมูลเก็บไว้ในเบราว์เซอร์นี้เท่านั้น';
  applySettingsView();
}

function renderSlip(payroll) {
  $('#slip-created').textContent = `สร้างเมื่อ ${formatThaiDate(new Date())}`;
  $('#slip-name').textContent = state.profile.displayName;
  $('#slip-cycle').textContent = `รอบ ${cycleText(payroll.cycle)}`;
  $('#slip-rows').innerHTML = [
    ['ฐานเงินเดือน', state.settings.salary],
    ['ค่าใบประกอบ', state.settings.licenseAllowance],
    [`ค่าเวร ${payroll.shifts.length} เวร`, payroll.shiftPremium],
    [`OT อัตโนมัติ ${payroll.automaticOtHours} ชม.`, payroll.automaticOtHours * state.settings.otRate],
    [`OT พิเศษ ${payroll.specialOtHours} ชม.`, payroll.specialOtHours * state.settings.otRate],
    ['รายรับเพิ่มเติม', payroll.otherIncome],
    ['รายการหัก', -payroll.deductions]
  ].map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value < 0 ? '−' : ''}${money(Math.abs(value))}</td></tr>`).join('');
  $('#slip-net').textContent = payroll.confirmed ? money(payroll.net) : `${money(payroll.estimateLow)}–${numberFormat.format(payroll.estimateHigh)}`;
}

function downloadBlob(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadPdf(button) {
  const originalText = button.innerHTML;
  button.disabled = true;
  button.textContent = 'กำลังสร้าง PDF…';
  const slip = $('#printable-slip');
  try {
    renderSlip(currentPayroll());
    slip.classList.add('is-capturing');
    await document.fonts.ready;
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
    const canvas = await html2canvas(slip, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
    const filename = `nurseshift-${currentPayroll().cycle.start}-${currentPayroll().cycle.end}.pdf`;
    const file = new File([pdf.output('blob')], filename, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'สรุปรายได้ NurseShift' });
      showToast('สร้าง PDF พร้อมแชร์แล้ว');
    } else {
      pdf.save(filename);
      showToast('ดาวน์โหลด PDF แล้ว');
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    showToast('สร้าง PDF ไม่สำเร็จ กรุณาลองใหม่');
  } finally {
    slip.classList.remove('is-capturing');
    button.disabled = false;
    button.innerHTML = originalText;
  }
}

function renderAll() {
  const payroll = currentPayroll();
  setProfile();
  renderHome(payroll);
  renderCalendar();
  renderFinance(payroll);
  renderSettings();
  renderSlip(payroll);
}

const screenMeta = {
  home: ['รอบปัจจุบัน', 'ภาพรวมของฉัน'],
  calendar: ['ตารางเวร', 'ปฏิทินของฉัน'],
  finance: ['สรุปส่วนบุคคล', 'รายได้และรายจ่าย'],
  settings: ['ปรับให้เหมาะกับคุณ', 'ตั้งค่าระบบ']
};

const settingsMeta = {
  profile: ['บัญชีของคุณ', 'โปรไฟล์ของฉัน'],
  income: ['รายได้หลัก', 'อัตราคำนวณ'],
  'shift-types': ['ตารางเวร', 'ประเภทเวร'],
  notifications: ['การแจ้งเตือน', 'แจ้งเตือนผ่าน LINE'],
  privacy: ['ข้อมูลของคุณ', 'ข้อมูลและความเป็นส่วนตัว']
};

function applySettingsView() {
  const menu = $('#settings-menu');
  const form = $('#settings-form');
  if (!menu || !form) return;
  menu.hidden = Boolean(settingsPanel);
  form.hidden = !settingsPanel;
  $$('.settings-section').forEach((section) => section.classList.toggle('is-active', section.dataset.settingsSection === settingsPanel));
  const meta = settingsMeta[settingsPanel];
  if (meta) {
    $('#settings-detail-eyebrow').textContent = meta[0];
    $('#settings-detail-title').textContent = meta[1];
  }
  $('#save-settings').hidden = !['income', 'shift-types', 'notifications'].includes(settingsPanel);
}

function showSettingsMenu() {
  settingsPanel = null;
  applySettingsView();
  $('#screen-eyebrow').textContent = screenMeta.settings[0];
  $('#screen-title').textContent = screenMeta.settings[1];
}

function openSettingsSection(name) {
  if (!settingsMeta[name]) return;
  settingsPanel = name;
  showScreen('settings', true);
  applySettingsView();
}

function showScreen(name, preserveSettings = false) {
  if (!screenMeta[name]) return;
  if (name === 'settings' && !preserveSettings) settingsPanel = null;
  $$('.screen').forEach((screen) => screen.classList.toggle('is-active', screen.dataset.screen === name));
  $$('[data-nav]').forEach((button) => button.classList.toggle('is-active', button.dataset.nav === name));
  const [eyebrow, title] = screenMeta[name];
  $('#screen-eyebrow').textContent = eyebrow;
  $('#screen-title').textContent = title;
  if (name === 'settings') applySettingsView();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function applyNavigationIntent() {
  if (!pendingNavigation || !state.settings.onboardingComplete) return;

  if (pendingNavigation.action === 'add-shift') {
    showScreen('calendar');
    openShiftSheet(todayIso);
  } else if (pendingNavigation.screen) {
    showScreen(pendingNavigation.screen);
  }

  pendingNavigation = null;
}

function populateShiftTypeSelect(selectedId = state.shiftTypes[0]?.id) {
  $('#shift-type-select').innerHTML = state.shiftTypes.map((type) => `<option value="${type.id}" ${type.id === selectedId ? 'selected' : ''}>${escapeHtml(type.name)} · +${numberFormat.format(type.premium)} บาท</option>`).join('');
}

function updateShiftTimes(typeId) {
  const type = state.shiftTypes.find((item) => item.id === typeId);
  if (!type) return;
  const form = $('#shift-form');
  form.elements.startTime.value = type.startTime;
  form.elements.endTime.value = type.endTime;
}

function openSheet(sheet) {
  $('#modal-backdrop').hidden = false;
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSheets() {
  $('#modal-backdrop').hidden = true;
  $$('.bottom-sheet').forEach((sheet) => { sheet.hidden = true; });
  document.body.style.overflow = '';
}

function openShiftSheet(date = selectedDate) {
  const form = $('#shift-form');
  form.reset();
  form.elements.id.value = '';
  form.elements.workDate.value = formatDateInput(date);
  $('#shift-native-date').value = date;
  $('#shift-sheet-title').textContent = 'เพิ่มเวร';
  populateShiftTypeSelect();
  updateShiftTimes(form.elements.shiftTypeId.value);
  openSheet($('#shift-sheet'));
  updateOverlapWarning();
}

function openSpecialOtSheet(date = selectedDate, item = null) {
  const form = $('#special-ot-form');
  form.reset();
  form.elements.id.value = item?.id || '';
  form.elements.workDate.value = formatDateInput(item?.workDate || date || todayIso);
  form.elements.hours.value = item?.hours || 1;
  form.elements.note.value = item?.note || '';
  $('#special-ot-native-date').value = item?.workDate || date || todayIso;
  $('#special-ot-sheet-title').textContent = item ? 'แก้ไข OT พิเศษ' : 'เพิ่ม OT พิเศษ';
  openSheet($('#special-ot-sheet'));
}

function openFinanceSheet() {
  const form = $('#finance-form');
  form.reset();
  form.elements.workDate.value = formatDateInput(selectedDate || todayIso);
  $('#finance-native-date').value = selectedDate || todayIso;
  openSheet($('#finance-sheet'));
}

function shiftCandidateFromForm() {
  const form = $('#shift-form');
  const workDate = parseDateInput(form.elements.workDate.value);
  if (!workDate) return null;
  return {
    id: form.elements.id.value || null,
    workDate,
    shiftTypeId: form.elements.shiftTypeId.value,
    startTime: form.elements.startTime.value,
    endTime: form.elements.endTime.value,
    urgentOtHours: 0,
    note: form.elements.note.value.trim()
  };
}

function updateOverlapWarning() {
  const candidate = shiftCandidateFromForm();
  const warning = $('#overlap-warning');
  if (!candidate || !candidate.startTime || !candidate.endTime) {
    warning.hidden = true;
    return;
  }
  const overlaps = findOverlaps(candidate, state.shifts);
  warning.hidden = overlaps.length === 0;
  if (overlaps.length) {
    const names = overlaps.map((shift) => state.shiftTypes.find((type) => type.id === shift.shiftTypeId)?.name || 'เวรอื่น');
    $('#overlap-message').textContent = `ซ้อนกับ ${names.join(', ')} คุณยังบันทึกต่อได้`;
  }
}

function bindEvents() {
  $$('[data-nav]').forEach((button) => button.addEventListener('click', () => showScreen(button.dataset.nav)));
  $$('[data-go]').forEach((button) => button.addEventListener('click', () => showScreen(button.dataset.go)));
  $('#profile-badge').addEventListener('click', () => openSettingsSection('profile'));
  $$('[data-settings-open]').forEach((button) => button.addEventListener('click', () => openSettingsSection(button.dataset.settingsOpen)));
  $('#settings-back').addEventListener('click', showSettingsMenu);
  $$('[data-action="open-shift"]').forEach((button) => button.addEventListener('click', () => openShiftSheet(todayIso)));
  $$('[data-action="open-special-ot"]').forEach((button) => button.addEventListener('click', () => openSpecialOtSheet(selectedDate || todayIso)));
  $$('[data-action="open-finance"]').forEach((button) => button.addEventListener('click', openFinanceSheet));
  $$('[data-action="open-selected-shift"]').forEach((button) => button.addEventListener('click', () => openShiftSheet(selectedDate)));
  $$('[data-close-sheet]').forEach((button) => button.addEventListener('click', closeSheets));
  $('#modal-backdrop').addEventListener('click', closeSheets);

  $('#previous-month').addEventListener('click', () => { calendarMonth = shiftMonth(calendarMonth, -1); renderCalendar(); });
  $('#next-month').addEventListener('click', () => { calendarMonth = shiftMonth(calendarMonth, 1); renderCalendar(); });
  $('#calendar-toggle').addEventListener('click', () => { calendarExpanded = !calendarExpanded; renderCalendar(); });
  $('#calendar-grid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-date]');
    if (!button) return;
    selectedDate = button.dataset.date;
    calendarMonth = new Date(fromIsoDate(selectedDate).getFullYear(), fromIsoDate(selectedDate).getMonth(), 1);
    renderCalendar();
    openShiftSheet(selectedDate);
  });

  $('#selected-shifts').addEventListener('click', async (event) => {
    const shiftButton = event.target.closest('[data-delete-shift]');
    if (shiftButton) {
      await commit(() => { state.shifts = state.shifts.filter((shift) => shift.id !== shiftButton.dataset.deleteShift); }, 'ลบเวรแล้ว');
      return;
    }
    const editButton = event.target.closest('[data-edit-special-ot]');
    if (editButton) {
      openSpecialOtSheet(selectedDate, state.specialOtItems.find((item) => item.id === editButton.dataset.editSpecialOt));
      return;
    }
    const deleteButton = event.target.closest('[data-delete-special-ot]');
    if (deleteButton) await commit(() => { state.specialOtItems = state.specialOtItems.filter((item) => item.id !== deleteButton.dataset.deleteSpecialOt); }, 'ลบ OT พิเศษแล้ว');
  });
  $('#financial-items').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-item]');
    if (!button) return;
    await commit(() => { state.financialItems = state.financialItems.filter((item) => item.id !== button.dataset.deleteItem); }, 'ลบรายการแล้ว');
  });
  $('#special-ot-items').addEventListener('click', async (event) => {
    const editButton = event.target.closest('[data-edit-special-ot]');
    if (editButton) {
      const item = state.specialOtItems.find((entry) => entry.id === editButton.dataset.editSpecialOt);
      if (item) openSpecialOtSheet(item.workDate, item);
      return;
    }
    const deleteButton = event.target.closest('[data-delete-special-ot]');
    if (deleteButton) await commit(() => { state.specialOtItems = state.specialOtItems.filter((item) => item.id !== deleteButton.dataset.deleteSpecialOt); }, 'ลบ OT พิเศษแล้ว');
  });
  $('#reminder-settings').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-reminder]');
    if (!button) return;
    await commit(() => { state.reminders = state.reminders.filter((reminder) => reminder.id !== button.dataset.deleteReminder); }, 'ลบเวลาแจ้งเตือนแล้ว');
  });

  $('#add-reminder').addEventListener('click', async () => {
    const amount = Number($('#reminder-amount').value);
    const multiplier = Number($('#reminder-unit').value);
    const offsetMinutes = amount * multiplier;
    if (!Number.isInteger(amount) || amount < 1 || !Number.isInteger(offsetMinutes) || offsetMinutes < 5 || offsetMinutes > 43200) {
      showToast('ตั้งเวลาได้ตั้งแต่ 5 นาทีถึง 30 วัน');
      return;
    }
    if (state.reminders.some((reminder) => reminder.offsetMinutes === offsetMinutes)) {
      showToast('มีเวลาแจ้งเตือนนี้อยู่แล้ว');
      return;
    }
    await commit(() => {
      state.reminders.push({ id: `reminder-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`, offsetMinutes, enabled: true });
      state.reminders.sort((a, b) => b.offsetMinutes - a.offsetMinutes);
    }, `เพิ่มแจ้งเตือน${reminderLabel(offsetMinutes)}แล้ว`);
  });

  $('#test-notification').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (lineFriendship === false) {
      showToast('กรุณาเพิ่ม Official Account เป็นเพื่อนก่อนทดสอบ');
      return;
    }
    button.disabled = true;
    try {
      await dataService.testNotification();
      lineFriendship = true;
      renderSettings();
      showToast('ส่งข้อความทดสอบแล้ว กรุณาตรวจใน LINE');
    } catch (error) {
      showToast(error.message || 'ส่งข้อความทดสอบไม่สำเร็จ');
    } finally {
      button.disabled = false;
    }
  });

  $('#shift-type-select').addEventListener('change', (event) => { updateShiftTimes(event.target.value); updateOverlapWarning(); });
  $('#shift-form').addEventListener('input', (event) => {
    if (event.target.name === 'workDate') {
      event.target.value = maskDateInput(event.target.value);
      const parsed = parseDateInput(event.target.value);
      if (parsed) $('#shift-native-date').value = parsed;
    }
    updateOverlapWarning();
  });
  $('#shift-native-date').addEventListener('change', (event) => {
    if (!event.target.value) return;
    $('#shift-form').elements.workDate.value = formatDateInput(event.target.value);
    updateOverlapWarning();
  });
  $('#finance-form [name="workDate"]').addEventListener('input', (event) => {
    event.target.value = maskDateInput(event.target.value);
    const parsed = parseDateInput(event.target.value);
    if (parsed) $('#finance-native-date').value = parsed;
  });
  $('#finance-native-date').addEventListener('change', (event) => {
    if (event.target.value) $('#finance-form').elements.workDate.value = formatDateInput(event.target.value);
  });
  $('#special-ot-form [name="workDate"]').addEventListener('input', (event) => {
    event.target.value = maskDateInput(event.target.value);
    const parsed = parseDateInput(event.target.value);
    if (parsed) $('#special-ot-native-date').value = parsed;
  });
  $('#special-ot-native-date').addEventListener('change', (event) => {
    if (event.target.value) $('#special-ot-form').elements.workDate.value = formatDateInput(event.target.value);
  });
  $('#settings-form [name="notificationsEnabled"]').addEventListener('change', (event) => {
    $('#notification-options').disabled = !event.target.checked;
    $('#settings-notification-summary').textContent = event.target.checked ? `เปิด · ${state.reminders.filter((item) => item.enabled).length} เวลา` : 'ปิดใช้งาน';
  });

  $('#shift-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const shift = shiftCandidateFromForm();
    if (!shift) {
      showToast('กรุณากรอกวันที่ให้ถูกต้อง เช่น 18/10/2569');
      return;
    }
    shift.id = shift.id || crypto.randomUUID();
    const saved = await commit(() => { state.shifts.push(shift); }, 'บันทึกเวรแล้ว');
    if (saved) {
      selectedDate = shift.workDate;
      calendarMonth = new Date(fromIsoDate(selectedDate).getFullYear(), fromIsoDate(selectedDate).getMonth(), 1);
      closeSheets();
    }
  });

  $('#special-ot-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const workDate = parseDateInput(form.elements.workDate.value);
    const hours = Number(form.elements.hours.value);
    if (!workDate) {
      showToast('กรุณากรอกวันที่ให้ถูกต้อง เช่น 18/10/2569');
      return;
    }
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
      showToast('OT พิเศษต้องเป็นจำนวนเต็ม 1–24 ชั่วโมง');
      return;
    }
    const item = { id: form.elements.id.value || crypto.randomUUID(), workDate, hours, note: form.elements.note.value.trim() };
    const saved = await commit(() => {
      const index = state.specialOtItems.findIndex((entry) => entry.id === item.id);
      if (index >= 0) state.specialOtItems[index] = item;
      else state.specialOtItems.push(item);
    }, form.elements.id.value ? 'แก้ไข OT พิเศษแล้ว' : 'บันทึก OT พิเศษแล้ว');
    if (saved) {
      selectedDate = workDate;
      calendarMonth = new Date(fromIsoDate(workDate).getFullYear(), fromIsoDate(workDate).getMonth(), 1);
      closeSheets();
    }
  });

  $('#finance-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const workDate = parseDateInput(form.elements.workDate.value);
    if (!workDate) {
      showToast('กรุณากรอกวันที่ให้ถูกต้อง เช่น 18/10/2569');
      return;
    }
    const item = {
      id: crypto.randomUUID(),
      kind: form.elements.kind.value,
      label: form.elements.label.value.trim(),
      amount: Number(form.elements.amount.value),
      workDate
    };
    const saved = await commit(() => { state.financialItems.push(item); }, 'บันทึกรายการแล้ว');
    if (saved) closeSheets();
  });

  $('#confirm-cycle').addEventListener('change', async (event) => {
    const cycleStart = currentPayroll().cycle.start;
    await commit(() => { state.settings.confirmedCycle = event.target.checked ? cycleStart : null; }, event.target.checked ? 'ยืนยันข้อมูลรอบนี้แล้ว' : 'ยกเลิกการยืนยันแล้ว');
  });

  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(['salary', 'licenseAllowance', 'otRate', 'standardHours', 'cycleStartDay'].map((name) => [name, Number(form.elements[name].value)]));
    if ([values.salary, values.licenseAllowance, values.otRate].some((value) => !Number.isFinite(value) || value < 0)
        || !Number.isInteger(values.standardHours) || values.standardHours < 1 || values.standardHours > 744
        || !Number.isInteger(values.cycleStartDay) || values.cycleStartDay < 1 || values.cycleStartDay > 28) {
      showToast('กรุณาตรวจสอบอัตราคำนวณและรอบเงินเดือน');
      return;
    }
    await commit(() => {
      Object.assign(state.settings, values);
      state.settings.notificationsEnabled = form.elements.notificationsEnabled.checked;
      $$('.shift-type-setting').forEach((row) => {
        const type = state.shiftTypes.find((item) => item.id === row.dataset.typeId);
        $$('[data-type-field]', row).forEach((input) => { type[input.dataset.typeField] = input.dataset.typeField === 'premium' ? Number(input.value) : input.value; });
      });
      $$('[data-reminder-id]').forEach((input) => {
        const reminder = state.reminders.find((item) => item.id === input.dataset.reminderId);
        reminder.enabled = input.checked;
      });
    }, 'บันทึกการตั้งค่าแล้ว');
  });

  $('#onboarding-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const saved = await commit(() => {
      for (const name of ['salary', 'licenseAllowance', 'otRate', 'standardHours', 'cycleStartDay']) state.settings[name] = Number(form.elements[name].value);
      state.settings.onboardingComplete = true;
    });
    if (saved) {
      $('#onboarding').hidden = true;
      $('#app-shell').hidden = false;
      applyNavigationIntent();
      showToast('ตั้งค่าเรียบร้อย เริ่มเพิ่มเวรได้เลย');
    }
  });

  $('#export-csv').addEventListener('click', () => {
    const payroll = currentPayroll();
    downloadBlob(`\ufeff${createCsv(state, payroll)}`, `nurseshift-${payroll.cycle.start}-${payroll.cycle.end}.csv`, 'text/csv;charset=utf-8');
    showToast('ส่งออก CSV แล้ว');
  });
  $('#export-backup').addEventListener('click', () => {
    downloadBlob(JSON.stringify(createBackup(state), null, 2), `nurseshift-backup-${todayIso}.json`, 'application/json;charset=utf-8');
    showToast('ดาวน์โหลดข้อมูลสำรองแล้ว');
  });
  $('#import-backup').addEventListener('click', () => {
    $('#backup-file').value = '';
    $('#backup-file').click();
  });
  $('#backup-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 1_000_000) throw new Error('ไฟล์ข้อมูลสำรองใหญ่เกิน 1 MB');
      const restored = restoreBackup(state, JSON.parse(await file.text()));
      if (!window.confirm('นำเข้าข้อมูลนี้แทนข้อมูลปัจจุบันทั้งหมดหรือไม่?')) return;
      await commit(() => { state = restored; }, 'นำเข้าข้อมูลสำรองแล้ว');
    } catch (error) {
      showToast(error.message || 'นำเข้าข้อมูลไม่สำเร็จ');
    }
  });
  $('#delete-account').addEventListener('click', async (event) => {
    if (!window.confirm('ลบตารางเวร รายได้ การตั้งค่า และประวัติแจ้งเตือนทั้งหมดอย่างถาวรหรือไม่?')) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await dataService.deleteAccount();
      showToast('ลบข้อมูลทั้งหมดแล้ว');
      setTimeout(() => {
        if (window.liff?.isInClient()) window.liff.closeWindow();
        else window.location.reload();
      }, 900);
    } catch (error) {
      showToast(error.message || 'ลบข้อมูลไม่สำเร็จ');
      button.disabled = false;
    }
  });
  $('#print-slip').addEventListener('click', (event) => downloadPdf(event.currentTarget));
}

async function initialize() {
  bindEvents();
  try {
    const result = await createService();
    pendingNavigation = readNavigationIntent(window.location.search);
    dataService = result.service;
    serviceMode = result.mode;
    lineFriendship = result.isFriend;
    state = await dataService.bootstrap();
    renderAll();
    $('#loading').hidden = true;
    if (state.settings.onboardingComplete) {
      $('#app-shell').hidden = false;
      applyNavigationIntent();
    }
    else $('#onboarding').hidden = false;
  } catch (error) {
    $('#loading').innerHTML = `<div class="empty-card"><b>เปิดระบบไม่สำเร็จ</b><span>${escapeHtml(error.message)}</span></div>`;
  }
}

initialize();
