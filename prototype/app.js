const panels = [...document.querySelectorAll('[data-screen-panel]')];
const navButtons = [...document.querySelectorAll('.bottom-nav [data-screen]')];
const reviewButtons = [...document.querySelectorAll('.review-link[data-screen]')];
const sheet = document.querySelector('.bottom-sheet');
const backdrop = document.querySelector('.sheet-backdrop');
const toast = document.querySelector('.toast');
const shiftDateInput = document.querySelector('#shift-date');
let toastTimer;

function formatDateForDisplay(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${Number(year) + 543}`;
}

function formatDateInput(value) {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function isValidDateInput(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return false;

  const [, day, month, buddhistYear] = match;
  const year = Number(buddhistYear) - 543;
  const date = new Date(Date.UTC(year, Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day);
}

function showScreen(name) {
  panels.forEach((panel) => panel.classList.toggle('is-visible', panel.dataset.screenPanel === name));
  navButtons.forEach((button) => button.classList.toggle('is-active', button.dataset.screen === name));
  reviewButtons.forEach((button) => button.classList.toggle('is-active', button.dataset.screen === name));
  document.querySelector('.bottom-nav').style.display = name === 'onboarding' ? 'none' : 'flex';
  closeSheet();
}

function openSheet(urgent = false, date = null) {
  sheet.classList.add('is-open');
  backdrop.classList.add('is-open');
  document.querySelector('#shift-title').textContent = urgent ? 'เพิ่ม OT เคสด่วน' : 'เพิ่มเวร';
  document.querySelector('#urgent-hours').value = urgent ? '1' : '0';
  if (date) shiftDateInput.value = formatDateForDisplay(date);
}

function closeSheet() {
  sheet.classList.remove('is-open');
  backdrop.classList.remove('is-open');
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2200);
}

document.querySelectorAll('[data-screen]').forEach((button) => {
  button.addEventListener('click', () => showScreen(button.dataset.screen));
});

document.querySelectorAll('[data-open-sheet]').forEach((button) => {
  button.addEventListener('click', () => openSheet(button.dataset.urgent === 'true'));
});

document.querySelectorAll('[data-close-sheet]').forEach((button) => button.addEventListener('click', closeSheet));

shiftDateInput.addEventListener('input', (event) => {
  event.target.value = formatDateInput(event.target.value);
});

document.querySelector('#save-shift').addEventListener('click', () => {
  if (!isValidDateInput(shiftDateInput.value)) {
    showToast('กรุณากรอกวันที่ให้ถูกต้อง เช่น 18/10/2569');
    shiftDateInput.focus();
    return;
  }
  closeSheet();
  showToast('บันทึกเวรในต้นแบบแล้ว');
});

document.querySelectorAll('[data-toast]').forEach((button) => {
  button.addEventListener('click', () => showToast(button.dataset.toast));
});

document.querySelector('#complete-toggle').addEventListener('change', (event) => {
  const complete = event.target.checked;
  const status = document.querySelector('#finance-status');
  document.querySelector('#finance-net').textContent = complete ? '฿29,500' : '฿29,000–30,000';
  document.querySelector('#finance-help').textContent = complete ? 'ตรวจข้อมูลครบแล้ว' : 'ช่วงประมาณการรวมค่าเผื่อ ±฿500';
  status.textContent = complete ? 'ข้อมูลครบแล้ว' : 'ข้อมูลยังไม่ครบ';
  status.className = `status ${complete ? 'status-success' : 'status-warning'}`;
});

const calendarDays = [
  { day: 27, muted: true }, { day: 28, muted: true }, { day: 29, muted: true }, { day: 30, muted: true },
  { day: 1, dots: ['morning'] }, { day: 2, dots: ['evening'] }, { day: 3 },
  { day: 4, dots: ['night'] }, { day: 5 }, { day: 6, dots: ['morning'] }, { day: 7, dots: ['evening'] }, { day: 8 }, { day: 9, dots: ['night'] }, { day: 10 },
  { day: 11, dots: ['morning'] }, { day: 12 }, { day: 13, dots: ['evening'] }, { day: 14 }, { day: 15, dots: ['night'] }, { day: 16 }, { day: 17 },
  { day: 18, selected: true, dots: ['evening', 'night'] }, { day: 19 }, { day: 20, dots: ['morning'] }, { day: 21 }, { day: 22, dots: ['evening'] }, { day: 23 }, { day: 24, dots: ['night'] },
  { day: 25, dots: ['night'] }, { day: 26, muted: true }, { day: 27, muted: true }, { day: 28, muted: true }, { day: 29, muted: true }, { day: 30, muted: true }, { day: 31, muted: true }
];

const shiftLabels = { morning: 'เช้า', evening: 'บ่าย', night: 'ดึก' };
const calendarGrid = document.querySelector('#calendar-grid');
calendarGrid.innerHTML = calendarDays.map(({ day, muted, selected, dots = [] }, index) => {
  const month = index < 4 ? '09' : '10';
  const date = `2026-${month}-${String(day).padStart(2, '0')}`;

  return `
  <button class="calendar-day${muted ? ' is-muted' : ''}${selected ? ' is-selected' : ''}" data-date="${date}" aria-label="วันที่ ${day}${dots.length ? ` เวร${dots.map((dot) => shiftLabels[dot]).join(' และเวร')}` : ''} แตะเพื่อเพิ่มเวร">
    <span>${day}</span>
    <span class="day-dots">${dots.map((dot) => `<i class="${dot}"></i>`).join('')}</span>
    <span class="day-shifts">${dots.map((dot) => `<span class="${dot}">${shiftLabels[dot]}</span>`).join('')}</span>
  </button>
  `;
}).join('');

const calendarViewToggle = document.querySelector('#calendar-view-toggle');
calendarViewToggle.addEventListener('click', () => {
  const expanded = !calendarGrid.classList.contains('is-expanded');
  calendarGrid.classList.toggle('is-expanded', expanded);
  calendarViewToggle.classList.toggle('is-expanded', expanded);
  calendarViewToggle.setAttribute('aria-pressed', String(expanded));
  calendarViewToggle.setAttribute('aria-label', expanded ? 'ย่อปฏิทินเป็นจุดสี' : 'ขยายปฏิทินเพื่อแสดงชื่อเวร');
  document.querySelector('#calendar-view-label').textContent = expanded ? 'ย่อ' : 'ขยาย';
});

calendarGrid.addEventListener('click', (event) => {
  const day = event.target.closest('.calendar-day');
  if (!day) return;
  calendarGrid.querySelectorAll('.calendar-day').forEach((item) => item.classList.remove('is-selected'));
  day.classList.add('is-selected');
  openSheet(false, day.dataset.date);
});

showScreen('onboarding');
