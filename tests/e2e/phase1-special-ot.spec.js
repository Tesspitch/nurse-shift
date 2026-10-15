import { expect, test } from '@playwright/test';

async function completeOnboarding(page) {
  await page.addInitScript(() => {
    const NativeDate = Date;
    const fixed = new NativeDate('2026-10-15T12:00:00+07:00').valueOf();
    class MockDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return fixed; }
    }
    window.Date = MockDate;
  });
  await page.goto('/');
  const form = page.locator('#onboarding-form');
  await form.locator('[name="salary"]').fill('20000');
  await form.locator('[name="licenseAllowance"]').fill('2000');
  await form.locator('[name="otRate"]').fill('100');
  await form.locator('[name="standardHours"]').fill('176');
  await form.locator('[name="cycleStartDay"]').fill('25');
  await form.getByRole('button', { name: 'เริ่มใช้งาน' }).click();
  await expect(page.locator('#app-shell')).toBeVisible();
}

async function addShift(page, { type }) {
  await page.locator('[data-action="open-shift"]:visible').click();
  await page.locator(`[data-bulk-type="${type}"]`).click();
  await page.locator('[data-bulk-date="2026-10-01"]').click();
  await page.locator('#bulk-save').click();
  await expect(page.locator('#shift-sheet')).toBeHidden();
}

test('shows newly added special OT on its selected calendar date', async ({ page }) => {
  await completeOnboarding(page);

  await page.locator('[data-action="open-special-ot"]:visible').click();
  const specialForm = page.locator('#special-ot-form');
  await specialForm.locator('[name="workDate"]').fill('05/11/2569');
  await specialForm.locator('[name="hours"]').fill('2');
  await specialForm.locator('[name="note"]').fill('OT เดือนถัดไป');
  await specialForm.getByRole('button', { name: 'บันทึก OT พิเศษ' }).click();
  await expect(page.locator('#special-ot-sheet')).toBeHidden();

  await page.locator('[data-nav="calendar"]').click();
  await expect(page.locator('#calendar-title')).toContainText('พฤศจิกายน 2569');
  await expect(page.locator('#calendar-grid [data-date="2026-11-05"]')).toContainText('OT');
  await expect(page.locator('#selected-date-title')).toContainText('5');
  await expect(page.locator('#selected-shifts')).toContainText('OT เดือนถัดไป');
});

test('manages independent special OT with the bulk shift flow', async ({ page }) => {
  await completeOnboarding(page);

  await addShift(page, { type: 'morning' });
  await addShift(page, { type: 'evening' });
  await expect(page.locator('#worked-hours')).toHaveText('16 / 176 ชม.');

  await page.locator('[data-nav="home"]').click();
  await page.locator('[data-action="open-special-ot"]:visible').click();
  const specialForm = page.locator('#special-ot-form');
  await specialForm.locator('[name="workDate"]').fill('01/10/2569');
  await specialForm.locator('[name="hours"]').fill('3');
  await specialForm.locator('[name="note"]').fill('เคสด่วนหลังลงเวร');
  await specialForm.getByRole('button', { name: 'บันทึก OT พิเศษ' }).click();
  await expect(page.locator('#ot-hours')).toHaveText('3 ชม.');

  await page.locator('[data-nav="finance"]').click();
  await expect(page.locator('#special-ot-items')).toContainText('เคสด่วนหลังลงเวร');
  await page.locator('#special-ot-items [data-edit-special-ot]').click();
  await specialForm.locator('[name="hours"]').fill('4');
  await specialForm.getByRole('button', { name: 'บันทึก OT พิเศษ' }).click();
  await expect(page.locator('#special-ot-items')).toContainText('4 ชม.');

  await page.locator('[data-nav="settings"]').click();
  await page.locator('[data-settings-open="income"]').click();
  await page.locator('#settings-form [name="standardHours"]').fill('10');
  await page.locator('#save-settings').click();
  await page.locator('[data-nav="home"]').click();
  await expect(page.locator('#worked-hours')).toHaveText('16 / 10 ชม.');
  await expect(page.locator('#ot-hours')).toHaveText('10 ชม.');

  await page.locator('[data-nav="finance"]').click();
  await page.locator('#special-ot-items [data-delete-special-ot]').click();
  await expect(page.locator('#special-ot-items')).toContainText('ยังไม่มี OT พิเศษ');
  await page.locator('[data-nav="home"]').click();
  await expect(page.locator('#ot-hours')).toHaveText('6 ชม.');

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
});
