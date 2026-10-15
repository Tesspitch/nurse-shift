import { calculatePayroll } from './calculations.js';
import { applyBulkPlan, buildBulkPlan, DAY_OFF_TYPE } from './bulk-shifts.js';
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
import { allowedHistoryMonths } from './history.js';

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
let bulkMonth = new Date(calendarMonth);
let bulkActiveType = null;
let bulkSelections = new Map();
let bulkSaving = false;
let historyMonthKey = allowedHistoryMonths()[2];
let historyRequestId = 0;

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
  const specialOtByDate = (state.specialOtItems || []).reduce((groups, item) => {
    if (!groups.has(item.workDate)) groups.set(item.workDate, []);
    groups.get(item.workDate).push(item);
    return groups;
  }, new Map());
  const dayOffDates = new Set((state.dayOffs || []).map((item) => item.workDate));
  $('#calendar-grid').classList.toggle('is-expanded', calendarExpanded);
  $('#calendar-grid').innerHTML = calendarCells(calendarMonth).map((cell) => {
    const shifts = shiftsByDate.get(cell.iso) || [];
    const specialOtItems = specialOtByDate.get(cell.iso) || [];
    const isDayOff = dayOffDates.has(cell.iso);
    const typeItems = shifts.map((shift) => state.shiftTypes.find((type) => type.id === shift.shiftTypeId)).filter(Boolean);
    const labels = `${typeItems.map((type) => `<span style="--dot-color:${type.color}">${escapeHtml(type.name.replace('เวร', ''))}</span>`).join('')}${specialOtItems.length ? '<span class="calendar-special-ot-label" style="--dot-color:#DB2777">OT</span>' : ''}${isDayOff ? '<span style="--dot-color:#16A34A">หยุด</span>' : ''}`;
    const dots = `${typeItems.map((type) => `<i style="--dot-color:${type.color}"></i>`).join('')}${specialOtItems.length ? '<i style="--dot-color:#DB2777"></i>' : ''}${isDayOff ? '<i style="--dot-color:#16A34A"></i>' : ''}`;
    const classes = [!cell.currentMonth && 'is-outside', cell.iso === todayIso && 'is-today', cell.iso === selectedDate && 'is-selected', specialOtItems.length && 'has-special-ot'].filter(Boolean).join(' ');
    return `<button class="calendar-day ${classes}" data-date="${cell.iso}" aria-label="${formatThaiDate(cell.iso)}${typeItems.length ? ` มี ${typeItems.map((type) => type.name).join(' และ')}` : ''}${specialOtItems.length ? ' มี OT พิเศษ' : ''}${isDayOff ? ' เป็นวันหยุด' : ''} แตะเพื่อดูรายละเอียด"><span class="day-number">${cell.day}</span><span class="day-dots">${dots}</span><span class="day-labels">${labels}</span></button>`;
  }).join('');

  $('#shift-legend').innerHTML = `${state.shiftTypes.map((type) => `<span><i style="--dot-color:${type.color}"></i>${escapeHtml(type.name)}</span>`).join('')}<span><i style="--dot-color:#DB2777"></i>OT พิเศษ</span><span><i style="--dot-color:#16A34A"></i>วันหยุด</span>`;
  $('#selected-date-title').textContent = formatThaiDate(selectedDate, true);
  const selectedShifts = (shiftsByDate.get(selectedDate) || []).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const selectedSpecialOt = specialOtByDate.get(selectedDate) || [];
  const selectedDayOff = (state.dayOffs || []).find((item) => item.workDate === selectedDate);
  $('#selected-shifts').innerHTML = selectedShifts.length || selectedSpecialOt.length || selectedDayOff
    ? `<div class="shift-list">${selectedDayOff ? dayOffItemHtml(selectedDayOff) : ''}${selectedShifts.map(shiftItemHtml).join('')}${selectedSpecialOt.map(specialOtItemHtml).join('')}</div>`
    : '<div class="empty-card"><b>วันนี้ยังไม่มีรายการ</b><span>กดปุ่มเพิ่มเวรด้านล่างเพื่อจัดตาราง</span></div>';
}

function renderHistorySelector() {
  const months = allowedHistoryMonths();
  if (!months.includes(historyMonthKey)) historyMonthKey = months[2];
  $('#history-month-selector').innerHTML = months.map((monthKey) => {
    const label = thaiMonthYear(fromIsoDate(`${monthKey}-01`));
    return `<button class="history-month-button ${monthKey === historyMonthKey ? 'is-active' : ''}" type="button" data-history-month="${monthKey}" aria-pressed="${monthKey === historyMonthKey}">${escapeHtml(label)}</button>`;
  }).join('');
}

function renderHistoryCalendar(history) {
  const monthDate = fromIsoDate(`${history.monthKey}-01`);
  const shiftsByDate = history.shifts.reduce((groups, shift) => {
    if (!groups.has(shift.workDate)) groups.set(shift.workDate, []);
    groups.get(shift.workDate).push(shift);
    return groups;
  }, new Map());
  const specialOtDates = new Set(history.specialOtItems.map((item) => item.workDate));
  const dayOffDates = new Set(history.dayOffs.map((item) => item.workDate));
  $('#history-calendar-title').textContent = thaiMonthYear(monthDate);
  $('#history-calendar-grid').innerHTML = calendarCells(monthDate).map((cell) => {
    const types = (shiftsByDate.get(cell.iso) || []).map((shift) => state.shiftTypes.find((type) => type.id === shift.shiftTypeId)).filter(Boolean);
    const labels = `${types.map((type) => `<span style="--dot-color:${type.color}">${escapeHtml(type.name.replace('เวร', ''))}</span>`).join('')}${specialOtDates.has(cell.iso) ? '<span style="--dot-color:#DB2777">OT</span>' : ''}${dayOffDates.has(cell.iso) ? '<span style="--dot-color:#16A34A">หยุด</span>' : ''}`;
    return `<div class="calendar-day ${cell.currentMonth ? '' : 'is-outside'}" aria-label="${formatThaiDate(cell.iso)}"><span class="day-number">${cell.day}</span><span class="day-labels">${labels}</span></div>`;
  }).join('');
  $('#history-legend').innerHTML = `${state.shiftTypes.map((type) => `<span><i style="--dot-color:${type.color}"></i>${escapeHtml(type.name)}</span>`).join('')}<span><i style="--dot-color:#DB2777"></i>OT พิเศษ</span><span><i style="--dot-color:#16A34A"></i>วันหยุด</span>`;
}

function renderHistory(history) {
  const monthLabel = thaiMonthYear(fromIsoDate(`${history.monthKey}-01`));
  $('#history-net').textContent = money(history.net);
  $('#history-month-label').textContent = `${monthLabel} · คำนวณจากอัตราปัจจุบัน`;
  $('#history-worked-hours').textContent = `${numberFormat.format(history.workedHours)} ชม.`;
  $('#history-ot-hours').textContent = `${numberFormat.format(history.totalOtHours)} ชม.`;
  $('#history-shift-total').textContent = `${history.shifts.length} เวร`;
  $('#history-day-off-total').textContent = `${history.dayOffs.length} วัน`;
  renderHistoryCalendar(history);
  const rows = [
    ['ฐานเงินเดือน', state.settings.salary],
    ['ค่าใบประกอบ', state.settings.licenseAllowance],
    [`ค่าเวร (${history.shifts.length} เวร)`, history.shiftIncome],
    [`OT ปกติ ${numberFormat.format(history.normalOtHours)} ชม.`, history.normalOtIncome],
    [`OT พิเศษ ${numberFormat.format(history.specialOtHours)} ชม.`, history.specialOtIncome],
    ['รายรับเพิ่มเติม', history.otherIncome],
    ['รายการหัก', -history.deductions, 'deduction'],
    ['ยอดสุทธิ', history.net, 'total']
  ];
  $('#history-breakdown').innerHTML = rows.map(([label, value, className = '']) => `<div class="breakdown-row ${className}"><span>${escapeHtml(label)}</span><b>${value < 0 ? '−' : ''}${money(Math.abs(value))}</b></div>`).join('');
  $('#history-shift-counts').innerHTML = state.shiftTypes.map((type) => `<span class="history-count"><i style="--type-color:${type.color}"></i>${escapeHtml(type.name)} <b>${history.shiftCounts[type.id] || 0}</b></span>`).join('');
  $('#history-empty').innerHTML = history.hasActivity ? '' : '<div class="empty-card"><b>เดือนนี้ยังไม่มีรายการ</b><span>ไม่พบเวร วันหยุด OT พิเศษ หรือรายการรายรับรายจ่าย</span></div>';
}

async function loadHistory() {
  const requestId = ++historyRequestId;
  renderHistorySelector();
  $('#history-loading').hidden = false;
  $('#history-error').hidden = true;
  $('#history-content').hidden = true;
  try {
    const history = await dataService.getMonthHistory(historyMonthKey, state);
    if (requestId !== historyRequestId) return;
    renderHistory(history);
    $('#history-loading').hidden = true;
    $('#history-content').hidden = false;
  } catch (error) {
    if (requestId !== historyRequestId) return;
    $('#history-loading').hidden = true;
    $('#history-error').hidden = false;
    $('#history-error-message').textContent = error.message || 'กรุณาลองใหม่';
  }
}

function shiftItemHtml(shift) {
  const type = state.shiftTypes.find((item) => item.id === shift.shiftTypeId);
  return `<article class="shift-item"><i class="shift-bar" style="--type-color:${type?.color || '#a3416a'}"></i><div class="content"><b>${escapeHtml(type?.name || 'เวร')}</b><span>${shift.startTime}–${shift.endTime} น. · ${plainMoney(type?.premium || 0)}</span></div><button class="delete-button" data-delete-shift="${shift.id}" aria-label="ลบ ${escapeHtml(type?.name || 'เวร')}"><svg><use href="#i-trash"/></svg></button></article>`;
}

function specialOtItemHtml(item) {
  return `<article class="shift-item"><i class="shift-bar" style="--type-color:#DB2777"></i><div class="content"><b>OT พิเศษ ${numberFormat.format(item.hours)} ชม.</b><span>${escapeHtml(item.note || 'ไม่มีหมายเหตุ')}</span></div><button class="text-button" type="button" data-edit-special-ot="${item.id}">แก้ไข</button><button class="delete-button" type="button" data-delete-special-ot="${item.id}" aria-label="ลบ OT พิเศษ"><svg><use href="#i-trash"/></svg></button></article>`;
}

function dayOffItemHtml(item) {
  return `<article class="shift-item day-off-item"><i class="shift-bar" style="--type-color:#16A34A"></i><div class="content"><b>วันหยุด</b><span>0 ชั่วโมง · ไม่มีค่าเวรและไม่หักเงินเดือน</span></div><button class="delete-button" data-delete-day-off="${item.id}" aria-label="ยกเลิกวันหยุด"><svg><use href="#i-trash"/></svg></button></article>`;
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
      <div class="shift-type-fields">
        <label class="field"><span>เวลาเริ่ม</span><input type="time" data-type-field="startTime" value="${type.startTime}"></label>
        <label class="field"><span>เวลาสิ้นสุด</span><input type="time" data-type-field="endTime" value="${type.endTime}"></label>
        <label class="field"><span>ค่าเพิ่มต่อเวร</span><span class="input-affix"><input type="number" min="0" data-type-field="premium" value="${type.premium}" inputmode="decimal"><b>บาท</b></span></label>
      </div>
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
  renderHistorySelector();
  if ($('[data-screen="history"]').classList.contains('is-active')) loadHistory();
}

const screenMeta = {
  home: ['รอบปัจจุบัน', 'ภาพรวมของฉัน'],
  calendar: ['ตารางเวร', 'ปฏิทินของฉัน'],
  history: ['ย้อนหลัง 3 เดือน', 'ตารางเวรและรายได้'],
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
  if (name === 'history') loadHistory();
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
  bulkMonth = new Date(fromIsoDate(date || todayIso).getFullYear(), fromIsoDate(date || todayIso).getMonth(), 1);
  bulkActiveType = state.shiftTypes[0]?.id || DAY_OFF_TYPE;
  bulkSelections = new Map([...state.shiftTypes.map((type) => [type.id, new Set()]), [DAY_OFF_TYPE, new Set()]]);
  bulkSaving = false;
  renderBulkSheet();
  openSheet($('#shift-sheet'));
}

function bulkTypeMeta(typeId) {
  if (typeId === DAY_OFF_TYPE) return { id: DAY_OFF_TYPE, name: 'วันหยุด', color: '#16A34A' };
  return state.shiftTypes.find((type) => type.id === typeId);
}

function renderBulkSheet() {
  const allTypes = [...state.shiftTypes, { id: DAY_OFF_TYPE, name: 'วันหยุด', color: '#16A34A' }];
  $('#bulk-type-options').innerHTML = allTypes.map((type) => {
    const count = bulkSelections.get(type.id)?.size || 0;
    return `<button class="bulk-type-button ${type.id === bulkActiveType ? 'is-active' : ''}" style="--type-color:${type.color}" type="button" data-bulk-type="${type.id}" aria-pressed="${type.id === bulkActiveType}"><i></i><span>${escapeHtml(type.name)}</span><small>${count}</small></button>`;
  }).join('');
  $('#bulk-calendar-title').textContent = thaiMonthYear(bulkMonth);
  const activeColor = bulkTypeMeta(bulkActiveType)?.color || '#A3416A';
  $('#bulk-calendar-grid').innerHTML = calendarCells(bulkMonth).map((cell) => {
    const activeSelected = bulkSelections.get(bulkActiveType)?.has(cell.iso);
    const otherType = allTypes.find((type) => type.id !== bulkActiveType && bulkSelections.get(type.id)?.has(cell.iso));
    const classes = [!cell.currentMonth && 'is-outside', cell.iso === todayIso && 'is-today', activeSelected && 'is-bulk-selected', otherType && 'has-other-selection'].filter(Boolean).join(' ');
    return `<button class="calendar-day ${classes}" style="--selection-color:${activeColor};--other-selection-color:${otherType?.color || activeColor}" type="button" data-bulk-date="${cell.iso}" aria-pressed="${Boolean(activeSelected)}" aria-label="${formatThaiDate(cell.iso)} ${activeSelected ? 'เลือกแล้ว' : 'ยังไม่เลือก'} สำหรับ ${escapeHtml(bulkTypeMeta(bulkActiveType)?.name || 'เวร')}"><span class="day-number">${cell.day}</span></button>`;
  }).join('');

  const plan = buildBulkPlan(state, bulkSelections);
  const previewRows = allTypes.map((type) => {
    const dates = [...(bulkSelections.get(type.id) || [])].sort();
    return dates.length ? `<div class="bulk-preview-row"><b>${escapeHtml(type.name)}</b><span>${dates.length} วัน · ${dates.map((date) => formatThaiDate(date)).join(', ')}</span></div>` : '';
  }).join('');
  const warnings = [];
  if (plan.duplicates.length) warnings.push(`ข้ามรายการซ้ำ ${plan.duplicates.length} รายการ`);
  if (plan.overlaps.length) warnings.push(`พบเวลาซ้อน ${plan.overlaps.length} รายการ (ระบบนับชั่วโมงช่วงซ้อนเพียงครั้งเดียว)`);
  if (plan.dayOffShiftConflicts.length) warnings.push(`วันหยุดจะแทนที่เวรเดิม ${plan.dayOffShiftConflicts.length} วัน โดยต้องยืนยันก่อนบันทึก`);
  if (plan.shiftDayOffConflicts.length) warnings.push(`เวรใหม่จะแทนที่วันหยุดเดิม ${plan.shiftDayOffConflicts.length} วัน โดยต้องยืนยันก่อนบันทึก`);
  $('#bulk-preview').innerHTML = previewRows || '<span class="bulk-hint">ยังไม่ได้เลือกวันที่</span>';
  if (warnings.length) $('#bulk-preview').insertAdjacentHTML('beforeend', `<div class="bulk-preview-warning">${warnings.map(escapeHtml).join('<br>')}</div>`);
  const saveButton = $('#bulk-save');
  const pendingCount = plan.shifts.length + plan.dayOffs.length;
  saveButton.disabled = bulkSaving || pendingCount === 0;
  saveButton.textContent = bulkSaving ? 'กำลังบันทึก…' : `บันทึกทั้งหมด${pendingCount ? ` (${pendingCount})` : ''}`;
}

function toggleBulkDate(workDate) {
  const activeDates = bulkSelections.get(bulkActiveType);
  if (activeDates.has(workDate)) {
    activeDates.delete(workDate);
  } else {
    activeDates.add(workDate);
    if (bulkActiveType === DAY_OFF_TYPE) {
      state.shiftTypes.forEach((type) => bulkSelections.get(type.id).delete(workDate));
    } else {
      bulkSelections.get(DAY_OFF_TYPE).delete(workDate);
    }
  }
  renderBulkSheet();
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

function bindEvents() {
  $$('[data-nav]').forEach((button) => button.addEventListener('click', () => showScreen(button.dataset.nav)));
  $$('[data-go]').forEach((button) => button.addEventListener('click', () => showScreen(button.dataset.go)));
  $('#profile-badge').addEventListener('click', () => openSettingsSection('profile'));
  $$('[data-settings-open]').forEach((button) => button.addEventListener('click', () => openSettingsSection(button.dataset.settingsOpen)));
  $('#settings-back').addEventListener('click', showSettingsMenu);
  $$('[data-action="open-shift"]').forEach((button) => button.addEventListener('click', () => {
    showScreen('calendar');
    openShiftSheet(selectedDate || todayIso);
  }));
  $$('[data-action="open-special-ot"]').forEach((button) => button.addEventListener('click', () => openSpecialOtSheet(selectedDate || todayIso)));
  $$('[data-action="open-finance"]').forEach((button) => button.addEventListener('click', openFinanceSheet));
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
  });
  $('#history-month-selector').addEventListener('click', (event) => {
    const button = event.target.closest('[data-history-month]');
    if (!button || button.dataset.historyMonth === historyMonthKey) return;
    historyMonthKey = button.dataset.historyMonth;
    loadHistory();
  });
  $('#history-retry').addEventListener('click', loadHistory);

  $('#bulk-type-options').addEventListener('click', (event) => {
    const button = event.target.closest('[data-bulk-type]');
    if (!button || bulkSaving) return;
    bulkActiveType = button.dataset.bulkType;
    renderBulkSheet();
  });
  $('#bulk-calendar-grid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-bulk-date]');
    if (!button || bulkSaving) return;
    toggleBulkDate(button.dataset.bulkDate);
  });
  $('#bulk-previous-month').addEventListener('click', () => { bulkMonth = shiftMonth(bulkMonth, -1); renderBulkSheet(); });
  $('#bulk-next-month').addEventListener('click', () => { bulkMonth = shiftMonth(bulkMonth, 1); renderBulkSheet(); });
  $('#bulk-save').addEventListener('click', async () => {
    if (bulkSaving) return;
    const plan = buildBulkPlan(state, bulkSelections);
    if (!plan.shifts.length && !plan.dayOffs.length) {
      showToast(plan.duplicates.length ? 'รายการที่เลือกมีอยู่แล้วทั้งหมด' : 'กรุณาเลือกอย่างน้อย 1 วัน');
      return;
    }
    const conflicts = [];
    if (plan.dayOffShiftConflicts.length) conflicts.push(`เปลี่ยน ${plan.dayOffShiftConflicts.length} วันที่มีเวรอยู่ให้เป็นวันหยุด`);
    if (plan.shiftDayOffConflicts.length) conflicts.push(`ยกเลิกวันหยุดเดิม ${plan.shiftDayOffConflicts.length} วันเพื่อเพิ่มเวร`);
    if (conflicts.length && !window.confirm(`${conflicts.join('\n')}\n\nOT พิเศษจะยังคงอยู่ ยืนยันดำเนินการหรือไม่?`)) return;
    bulkSaving = true;
    renderBulkSheet();
    const saved = await commit(() => applyBulkPlan(state, plan), `บันทึกตาราง ${plan.shifts.length + plan.dayOffs.length} รายการแล้ว`);
    bulkSaving = false;
    if (saved) {
      const dates = [...plan.shifts.map((item) => item.workDate), ...plan.dayOffs.map((item) => item.workDate)].sort();
      if (dates[0]) selectedDate = dates[0];
      calendarMonth = new Date(fromIsoDate(selectedDate).getFullYear(), fromIsoDate(selectedDate).getMonth(), 1);
      closeSheets();
    } else {
      renderBulkSheet();
    }
  });

  $('#selected-shifts').addEventListener('click', async (event) => {
    const shiftButton = event.target.closest('[data-delete-shift]');
    if (shiftButton) {
      await commit(() => { state.shifts = state.shifts.filter((shift) => shift.id !== shiftButton.dataset.deleteShift); }, 'ลบเวรแล้ว');
      return;
    }
    const dayOffButton = event.target.closest('[data-delete-day-off]');
    if (dayOffButton) {
      await commit(() => { state.dayOffs = state.dayOffs.filter((item) => item.id !== dayOffButton.dataset.deleteDayOff); }, 'ยกเลิกวันหยุดแล้ว');
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
      renderCalendar();
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
