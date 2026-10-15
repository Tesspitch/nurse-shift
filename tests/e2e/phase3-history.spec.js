import { expect, test } from '@playwright/test';

test('shows exactly three Bangkok calendar months and refreshes cached history', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeDate = Date;
    const fixed = new NativeDate('2026-10-15T12:00:00+07:00').valueOf();
    class MockDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return fixed; }
    }
    window.Date = MockDate;
    localStorage.setItem('cost-nurse-state-v1', JSON.stringify({
      version: 0,
      profile: { displayName: 'History test', pictureUrl: '' },
      settings: { onboardingComplete: true, salary: 20000, licenseAllowance: 2000, otRate: 100, standardHours: 8, cycleStartDay: 25, uncertaintyBuffer: 500, confirmedCycle: null, notificationsEnabled: true },
      shiftTypes: [
        { id: 'morning', name: 'เวรเช้า', startTime: '08:00', endTime: '16:00', premium: 0, color: '#F59E0B' },
        { id: 'evening', name: 'เวรบ่าย', startTime: '16:00', endTime: '00:00', premium: 200, color: '#8B5CF6' },
        { id: 'night', name: 'เวรดึก', startTime: '00:00', endTime: '08:00', premium: 300, color: '#2563EB' }
      ],
      shifts: [
        { id: crypto.randomUUID(), shiftTypeId: 'morning', workDate: '2026-07-01', startTime: '08:00', endTime: '16:00', urgentOtHours: 0, note: 'ต้องไม่ถูกลบ' },
        { id: crypto.randomUUID(), shiftTypeId: 'night', workDate: '2026-09-01', startTime: '00:00', endTime: '08:00', urgentOtHours: 0, note: '' },
        { id: crypto.randomUUID(), shiftTypeId: 'evening', workDate: '2026-10-01', startTime: '16:00', endTime: '00:00', urgentOtHours: 0, note: '' }
      ],
      specialOtItems: [{ id: crypto.randomUUID(), workDate: '2026-10-01', hours: 2, note: 'เคสด่วน' }],
      dayOffs: [{ id: crypto.randomUUID(), workDate: '2026-08-10' }],
      financialItems: [
        { id: crypto.randomUUID(), kind: 'income', label: 'เพิ่ม', amount: 500, workDate: '2026-10-02' },
        { id: crypto.randomUUID(), kind: 'deduction', label: 'ภาษี', amount: 300, workDate: '2026-10-02' }
      ],
      reminders: [{ id: 'one-day', offsetMinutes: 1440, enabled: true }]
    }));
  });
  await page.goto('/');
  await page.locator('[data-nav="calendar"]').click();
  await page.locator('[data-go="history"]').click();

  await expect(page.locator('.history-month-button')).toHaveCount(3);
  await expect(page.locator('[data-history-month="2026-08"]')).toContainText('สิงหาคม');
  await expect(page.locator('[data-history-month="2026-09"]')).toContainText('กันยายน');
  await expect(page.locator('[data-history-month="2026-10"]')).toContainText('ตุลาคม');
  await expect(page.locator('#history-content')).toBeVisible();
  await expect(page.locator('#history-net')).toContainText('22,600');
  await expect(page.locator('#history-ot-hours')).toHaveText('2 ชม.');

  await page.locator('[data-history-month="2026-09"]').click();
  await expect(page.locator('#history-shift-counts')).toContainText('เวรดึก 1');
  await page.locator('[data-history-month="2026-08"]').click();
  await expect(page.locator('#history-day-off-total')).toHaveText('1 วัน');

  await page.getByRole('button', { name: 'กลับไปปฏิทิน' }).click();
  await page.locator('.calendar-primary-actions [data-action="open-shift"]').click();
  await page.locator('[data-bulk-type="morning"]').click();
  await page.locator('[data-bulk-date="2026-10-02"]').click();
  await page.locator('#bulk-save').click();
  await page.locator('[data-go="history"]').click();
  await page.locator('[data-history-month="2026-10"]').click();
  await expect(page.locator('#history-shift-total')).toHaveText('2 เวร');

  const preservedOldRecord = await page.evaluate(() => JSON.parse(localStorage.getItem('cost-nurse-state-v1')).shifts.some((shift) => shift.workDate === '2026-07-01'));
  expect(preservedOldRecord).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
