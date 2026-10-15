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
}

test('calendar details, bulk shifts and day off work on mobile', async ({ page }) => {
  await completeOnboarding(page);
  await page.locator('[data-nav="calendar"]').click();

  await page.locator('#calendar-grid [data-date="2026-10-05"]').click();
  await expect(page.locator('#shift-sheet')).toBeHidden();
  await expect(page.locator('#selected-date-title')).toContainText('5');

  await page.locator('.calendar-primary-actions [data-action="open-special-ot"]').click();
  await expect(page.locator('#special-ot-form [name="workDate"]')).toHaveValue('05/10/2569');
  await page.locator('#special-ot-sheet [data-close-sheet]').click();

  await page.locator('.calendar-primary-actions [data-action="open-shift"]').click();
  await page.locator('[data-bulk-type="morning"]').click();
  await page.locator('[data-bulk-date="2026-10-01"]').click();
  await page.locator('[data-bulk-date="2026-10-02"]').click();
  await expect(page.locator('[data-bulk-type="morning"] small')).toHaveText('2');

  await page.locator('[data-bulk-type="night"]').click();
  await page.locator('[data-bulk-date="2026-10-03"]').click();
  await expect(page.locator('[data-bulk-type="morning"] small')).toHaveText('2');
  await page.locator('[data-bulk-type="day-off"]').click();
  await page.locator('[data-bulk-date="2026-10-04"]').click();
  await expect(page.locator('#bulk-preview')).toContainText('วันหยุด');
  await page.locator('#bulk-save').click();
  await expect(page.locator('#shift-sheet')).toBeHidden();

  await page.locator('#calendar-toggle').click();
  await expect(page.locator('#calendar-grid [data-date="2026-10-01"]')).toContainText('เช้า');
  await expect(page.locator('#calendar-grid [data-date="2026-10-04"]')).toContainText('หยุด');
  await page.locator('#calendar-grid [data-date="2026-10-04"]').click();
  await expect(page.locator('#selected-shifts')).toContainText('0 ชั่วโมง');

  await page.locator('.calendar-primary-actions [data-action="open-shift"]').click();
  await page.locator('[data-bulk-type="morning"]').click();
  await page.locator('[data-bulk-date="2026-10-01"]').click();
  await expect(page.locator('#bulk-preview')).toContainText('ข้ามรายการซ้ำ');
  await expect(page.locator('#bulk-save')).toBeDisabled();
  await page.locator('#shift-sheet [data-close-sheet]').click();

  await page.locator('#selected-shifts [data-delete-day-off]').click();
  await expect(page.locator('#selected-shifts')).toContainText('วันนี้ยังไม่มีรายการ');

  await page.locator('.calendar-primary-actions [data-action="open-shift"]').click();
  await page.locator('[data-bulk-type="day-off"]').click();
  await page.locator('[data-bulk-date="2026-10-02"]').click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#bulk-save').click();
  await expect(page.locator('#shift-sheet')).toBeVisible();
  await page.locator('#shift-sheet [data-close-sheet]').click();
  await page.locator('#calendar-grid [data-date="2026-10-02"]').click();
  await expect(page.locator('#selected-shifts')).toContainText('เวรเช้า');

  await page.locator('[data-nav="home"]').click();
  await page.locator('[data-action="open-special-ot"]:visible').click();
  const specialForm = page.locator('#special-ot-form');
  await specialForm.locator('[name="workDate"]').fill('01/10/2569');
  await specialForm.locator('[name="hours"]').fill('2');
  await specialForm.locator('[name="note"]').fill('เคสด่วนยังต้องคงอยู่');
  await specialForm.getByRole('button', { name: 'บันทึก OT พิเศษ' }).click();
  await page.locator('[data-nav="calendar"]').click();
  await page.locator('.calendar-primary-actions [data-action="open-shift"]').click();
  await page.locator('[data-bulk-type="day-off"]').click();
  await page.locator('[data-bulk-date="2026-10-01"]').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#bulk-save').click();
  await page.locator('#calendar-grid [data-date="2026-10-01"]').click();
  await expect(page.locator('#selected-shifts')).toContainText('วันหยุด');
  await expect(page.locator('#selected-shifts')).toContainText('เคสด่วนยังต้องคงอยู่');

  await page.locator('[data-nav="settings"]').click();
  await page.locator('[data-settings-open="shift-types"]').click();
  const fieldBoxes = await page.locator('.shift-type-setting').first().locator('.field').evaluateAll((fields) => fields.map((field) => {
    const box = field.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
  }));
  expect(fieldBoxes[1].top).toBeGreaterThanOrEqual(fieldBoxes[0].bottom);
  expect(fieldBoxes[2].top).toBeGreaterThanOrEqual(fieldBoxes[1].bottom);
  expect(fieldBoxes.every((box) => box.left >= 0 && box.right <= page.viewportSize().width)).toBe(true);

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
});
