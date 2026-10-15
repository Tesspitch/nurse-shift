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
    state = previous;
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
  $('#ot-hours').textContent = `${numberFormat.format(payroll.automaticOtHours + payroll.urgentOtHours)} ชม.`;

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
        <div class="content"><b>${escapeHtml(type?.name || 'เวร')}</b><span>${upcoming.startTime}–${upcoming.endTime} น.${upcoming.urgentOtHours ? ` · OT เพิ่ม ${upcoming.urgentOtHours} ชม.` : ''}</span></div>
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
    [`OT ${numberFormat.format(payroll.automaticOtHours + payroll.urgentOtHours)} ชม.`, payroll.otIncome],
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
  $('#calendar-grid').classList.toggle('is-expanded', calendarExpanded);
  $('#calendar-grid').innerHTML = calendarCells(calendarMonth).map((cell) => {
    const shifts = shiftsByDate.get(cell.iso) || [];
    const typeItems = shifts.map((shift) => state.shiftTypes.find((type) => type.id === shift.shiftTypeId)).filter(Boolean);
    const labels = typeItems.map((type) => `<span style="--dot-color:${type.color}">${escapeHtml(type.name.replace('เวร', ''))}</span>`).join('');
    const dots = typeItems.map((type) => `<i style="--dot-color:${type.color}"></i>`).join('');
    const classes = [!cell.currentMonth && 'is-outside', cell.iso === todayIso && 'is-today', cell.iso === selectedDate && 'is-selected'].filter(Boolean).join(' ');
    return `<button class="calendar-day ${classes}" data-date="${cell.iso}" aria-label="${formatThaiDate(cell.iso)}${typeItems.length ? ` มี ${typeItems.map((type) => type.name).join(' และ')}` : ''} แตะเพื่อเพิ่มเวร"><span class="day-number">${cell.day}</span><span class="day-dots">${dots}</span><span class="day-labels">${labels}</span></button>`;
  }).join('');

  $('#shift-legend').innerHTML = state.shiftTypes.map((type) => `<span><i style="--dot-color:${type.color}"></i>${escapeHtml(type.name)}</span>`).join('');
  $('#selected-date-title').textContent = formatThaiDate(selectedDate, true);
  const selectedShifts = (shiftsByDate.get(selectedDate) || []).sort((a, b) => a.startTime.localeCompare(b.startTime));
  $('#selected-shifts').innerHTML = selectedShifts.length
    ? `<div class="shift-list">${selectedShifts.map(shiftItemHtml).join('')}</div>`
    : '<div class="empty-card"><b>วันนี้ยังไม่มีเวร</b><span>แตะวันที่หรือปุ่มเพิ่มเวรเพื่อบันทึก</span></div>';
}

function shiftItemHtml(shift) {
  const type = state.shiftTypes.find((item) => item.id === shift.shiftTypeId);
  return `<article class="shift-item"><i class="shift-bar" style="--type-color:${type?.color || '#a3416a'}"></i><div class="content"><b>${escapeHtml(type?.name || 'เวร')}</b><span>${shift.startTime}–${shift.endTime} น. · ${plainMoney(type?.premium || 0)}${shift.urgentOtHours ? ` · OT เพิ่ม ${shift.urgentOtHours} ชม.` : ''}</span></div><button class="delete-button" data-delete-shift="${shift.id}" aria-label="ลบ ${escapeHtml(type?.name || 'เวร')}"><svg><use href="#i-trash"/></svg></button></article>`;
}

function renderFinance(payroll) {
  $('#finance-net').textContent = payroll.confirmed ? money(payroll.net) : `${money(payroll.estimateLow)}–${numberFormat.format(payroll.estimateHigh)}`;
  $('#finance-cycle').textContent = `รอบ ${cycleText(payroll.cycle)}`;
  $('#finance-breakdown').innerHTML = breakdownRows(payroll);
  $('#confirm-cycle').checked = payroll.confirmed;
  $('#financial-items').innerHTML = payroll.items.length
    ? payroll.items.map((item) => `<article class="financial-item ${item.kind === 'deduction' ? 'is-deduction' : ''}"><div class="content"><b>${escapeHtml(item.label)}</b><span>${formatThaiDate(item.workDate)}</span></div><b class="amount">${item.kind === 'deduction' ? '−' : '+'}${money(item.amount)}</b><button class="delete-button" data-delete-item="${item.id}" aria-label="ลบ ${escapeHtml(item.label)}"><svg><use href="#i-trash"/></svg></button></article>`).join('')
    : '<div class="empty-card"><b>ยังไม่มีรายการเพิ่ม</b><span>เพิ่มภาษี ประกันสังคม รายรับ หรือรายจ่ายอื่นได้เอง</span></div>';
}

function renderSettings() {
  const form = $('#settings-form');
  for (const name of ['salary', 'licenseAllowance', 'otRate', 'standardHours', 'cycleStartDay']) form.elements[name].value = state.settings[name];
  form.elements.notificationsEnabled.checked = state.settings.notificationsEnabled;
  $('#shift-type-settings').innerHTML = state.shiftTypes.map((type) => `
    <div class="shift-type-setting" data-type-id="${type.id}">
      <div class="type-name"><i style="--type-color:${type.color}"></i>${escapeHtml(type.name)}</div>
      <label class="field"><span>เริ่ม</span><input type="time" data-type-field="startTime" value="${type.startTime}"></label>
      <label class="field"><span>สิ้นสุด</span><input type="time" data-type-field="endTime" value="${type.endTime}"></label>
      <label class="field"><span>ค่าเพิ่ม (บาท)</span><input type="number" min="0" data-type-field="premium" value="${type.premium}" inputmode="decimal"></label>
    </div>`).join('');
  $('#reminder-settings').innerHTML = state.reminders.map((reminder) => `<label class="reminder-row"><span>${reminder.offsetMinutes >= 1440 ? `ก่อน ${reminder.offsetMinutes / 1440} วัน` : `ก่อน ${reminder.offsetMinutes} นาที`}</span><span class="switch"><input type="checkbox" data-reminder-id="${reminder.id}" ${reminder.enabled ? 'checked' : ''}><i></i></span></label>`).join('');
  $('#mode-note').textContent = serviceMode === 'connected'
    ? 'เชื่อมต่อ LINE และ Supabase แล้ว ข้อมูลจะถูกบันทึกในบัญชีของคุณ'
    : 'ขณะนี้เป็นโหมดทดสอบในเครื่อง ข้อมูลเก็บไว้ในเบราว์เซอร์นี้เท่านั้น';
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
    [`OT เคสด่วน ${payroll.urgentOtHours} ชม.`, payroll.urgentOtHours * state.settings.otRate],
    ['รายรับเพิ่มเติม', payroll.otherIncome],
    ['รายการหัก', -payroll.deductions]
  ].map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value < 0 ? '−' : ''}${money(Math.abs(value))}</td></tr>`).join('');
  $('#slip-net').textContent = payroll.confirmed ? money(payroll.net) : `${money(payroll.estimateLow)}–${numberFormat.format(payroll.estimateHigh)}`;
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

function showScreen(name) {
  if (!screenMeta[name]) return;
  $$('.screen').forEach((screen) => screen.classList.toggle('is-active', screen.dataset.screen === name));
  $$('[data-nav]').forEach((button) => button.classList.toggle('is-active', button.dataset.nav === name));
  const [eyebrow, title] = screenMeta[name];
  $('#screen-eyebrow').textContent = eyebrow;
  $('#screen-title').textContent = title;
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

function openShiftSheet(date = selectedDate, urgent = false) {
  const form = $('#shift-form');
  form.reset();
  form.elements.id.value = '';
  form.elements.workDate.value = formatDateInput(date);
  form.elements.urgentOtHours.value = urgent ? '1' : '0';
  $('#shift-sheet-title').textContent = urgent ? 'เพิ่ม OT เคสด่วน' : 'เพิ่มเวร';
  populateShiftTypeSelect();
  updateShiftTimes(form.elements.shiftTypeId.value);
  openSheet($('#shift-sheet'));
  updateOverlapWarning();
}

function openFinanceSheet() {
  const form = $('#finance-form');
  form.reset();
  form.elements.workDate.value = formatDateInput(selectedDate || todayIso);
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
    urgentOtHours: Math.floor(Number(form.elements.urgentOtHours.value || 0)),
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
  $$('[data-action="open-shift"]').forEach((button) => button.addEventListener('click', () => openShiftSheet(todayIso)));
  $$('[data-action="open-urgent"]').forEach((button) => button.addEventListener('click', () => openShiftSheet(todayIso, true)));
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
    const button = event.target.closest('[data-delete-shift]');
    if (!button) return;
    await commit(() => { state.shifts = state.shifts.filter((shift) => shift.id !== button.dataset.deleteShift); }, 'ลบเวรแล้ว');
  });
  $('#financial-items').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-item]');
    if (!button) return;
    await commit(() => { state.financialItems = state.financialItems.filter((item) => item.id !== button.dataset.deleteItem); }, 'ลบรายการแล้ว');
  });

  $('#shift-type-select').addEventListener('change', (event) => { updateShiftTimes(event.target.value); updateOverlapWarning(); });
  $('#shift-form').addEventListener('input', (event) => {
    if (event.target.name === 'workDate') event.target.value = maskDateInput(event.target.value);
    updateOverlapWarning();
  });
  $('#finance-form [name="workDate"]').addEventListener('input', (event) => { event.target.value = maskDateInput(event.target.value); });

  $('#shift-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const shift = shiftCandidateFromForm();
    if (!shift) {
      showToast('กรุณากรอกวันที่ให้ถูกต้อง เช่น 18/10/2569');
      return;
    }
    if (!Number.isInteger(shift.urgentOtHours) || shift.urgentOtHours < 0) {
      showToast('OT เคสด่วนต้องเป็นจำนวนเต็มตั้งแต่ 0 ชั่วโมง');
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
    await commit(() => {
      for (const name of ['salary', 'licenseAllowance', 'otRate', 'standardHours', 'cycleStartDay']) state.settings[name] = Number(form.elements[name].value);
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

  $('#print-slip').addEventListener('click', () => {
    renderSlip(currentPayroll());
    window.print();
  });
}

async function initialize() {
  bindEvents();
  try {
    const result = await createService();
    pendingNavigation = readNavigationIntent(window.location.search);
    dataService = result.service;
    serviceMode = result.mode;
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
