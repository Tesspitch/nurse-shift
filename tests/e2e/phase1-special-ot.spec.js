import { expect, test } from '@playwright/test';

async function completeOnboarding(page) {
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

async function addShift(page, { type, start, end }) {
  await page.locator('[data-action="open-shift"]:visible').click();
  const form = page.locator('#shift-form');
  await form.locator('[name="workDate"]').fill('01/10/2569');
  await form.locator('[name="shiftTypeId"]').selectOption(type);
  await form.locator('[name="startTime"]').fill(start);
  await form.locator('[name="endTime"]').fill(end);
  await form.getByRole('button', { name: 'บันทึกเวร' }).click();
  await expect(page.locator('#shift-sheet')).toBeHidden();
}

test('calculates parallel shifts once and manages independent special OT', async ({ page }) => {
  await completeOnboarding(page);

  await addShift(page, { type: 'morning', start: '08:00', end: '16:00' });
  await addShift(page, { type: 'evening', start: '12:00', end: '20:00' });
  await expect(page.locator('#worked-hours')).toHaveText('12 / 176 ชม.');

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
  await expect(page.locator('#worked-hours')).toHaveText('12 / 10 ชม.');
  await expect(page.locator('#ot-hours')).toHaveText('6 ชม.');

  await page.locator('[data-nav="finance"]').click();
  await page.locator('#special-ot-items [data-delete-special-ot]').click();
  await expect(page.locator('#special-ot-items')).toContainText('ยังไม่มี OT พิเศษ');
  await page.locator('[data-nav="home"]').click();
  await expect(page.locator('#ot-hours')).toHaveText('2 ชม.');

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
});
