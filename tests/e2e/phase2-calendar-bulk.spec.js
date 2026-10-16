import { readFile } from 'node:fs/promises';
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

test('downloads a phone wallpaper image of the current shift calendar', async ({ page }) => {
  await completeOnboarding(page);
  await page.locator('[data-nav="calendar"]').click();
  for (const disableToBlob of [false, true]) {
    if (disableToBlob) {
      await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = undefined; });
    }
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#download-calendar-image').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('nurseshift-calendar-2026-10.png');
    const image = await readFile(await download.path());
    expect(image.toString('ascii', 1, 4)).toBe('PNG');
    expect(image.readUInt32BE(16)).toBe(1080);
    expect(image.readUInt32BE(20)).toBe(1920);
  }
});

test('adds a shift for one selected day', async ({ page }) => {
  await completeOnboarding(page);
  await page.locator('[data-nav="calendar"]').click();
  await page.locator('[data-action="open-single-shift"]').click();

  const selectedDate = page.locator('#bulk-calendar-grid [data-bulk-date="2026-10-15"]');
  await expect(selectedDate).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-bulk-type="evening"]').click();
  await expect(selectedDate).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#bulk-calendar-grid [data-bulk-date="2026-10-16"]').click();
  await expect(selectedDate).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#bulk-calendar-grid [data-bulk-date="2026-10-16"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#bulk-save').click();
  await expect(page.locator('#shift-sheet')).toBeHidden();

  await page.locator('#calendar-grid [data-date="2026-10-16"]').click();
  await expect(page.locator('#selected-shifts')).toContainText('เวรบ่าย');
  await page.locator('#calendar-grid [data-date="2026-10-15"]').click();
  await expect(page.locator('#selected-shifts')).toContainText('วันนี้ยังไม่มีรายการ');
});

test('selects existing shifts by type and marks them for removal', async ({ page }) => {
  await completeOnboarding(page);
  await page.locator('[data-nav="calendar"]').click();
  await page.locator('.calendar-primary-actions [data-action="open-shift"]').click();
  await page.locator('[data-bulk-type="evening"]').click();
  await page.locator('[data-bulk-date="2026-10-01"]').click();
  await page.locator('#bulk-save').click();
  await expect(page.locator('#shift-sheet')).toBeHidden();

  await page.locator('.calendar-primary-actions [data-action="open-shift"]').click();
  await page.locator('[data-bulk-type="evening"]').click();
  const existingEvening = page.locator('#bulk-calendar-grid [data-bulk-date="2026-10-01"]');
  await expect(existingEvening).toHaveClass(/has-active-existing-shift/);
  await expect(existingEvening.locator('.day-labels')).toContainText('บ่าย');
  await existingEvening.click();
  await expect(existingEvening).toHaveClass(/is-marked-for-removal/);
  await expect(page.locator('#bulk-preview')).toContainText('ลบเวรบ่าย');
  await page.locator('#bulk-save').click();
  await expect(page.locator('#shift-sheet')).toBeHidden();
  await expect(page.locator('#selected-shifts')).toContainText('วันนี้ยังไม่มีรายการ');
});

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
  await expect(page.locator('#bulk-calendar-grid [data-bulk-date="2026-10-01"] .day-labels')).toContainText('เช้า');
  await expect(page.locator('#bulk-calendar-grid [data-bulk-date="2026-10-04"] .day-labels')).toContainText('หยุด');
  await page.locator('[data-bulk-type="morning"]').click();
  const existingMorning = page.locator('#bulk-calendar-grid [data-bulk-date="2026-10-01"]');
  await expect(existingMorning).toHaveClass(/has-active-existing-shift/);
  await expect(existingMorning).not.toHaveAttribute('aria-pressed', 'true');
  await existingMorning.click();
  await expect(existingMorning).toHaveClass(/is-marked-for-removal/);
  await expect(page.locator('#bulk-preview')).toContainText('ลบเวรเช้า');
  await page.locator('#bulk-save').click();
  await expect(page.locator('#shift-sheet')).toBeHidden();
  await page.locator('#calendar-grid [data-date="2026-10-01"]').click();
  await expect(page.locator('#selected-shifts')).toContainText('วันนี้ยังไม่มีรายการ');

  await page.locator('#calendar-grid [data-date="2026-10-04"]').click();
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

  const settingsCardBox = await page.locator('.shift-type-setting').first().boundingBox();
  const inputBoxes = await page.locator('.shift-type-setting').first().locator('input').evaluateAll((inputs) => inputs.map((input) => {
    const box = input.getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width };
  }));
  expect(settingsCardBox).not.toBeNull();
  expect(inputBoxes.every((box) => box.left >= settingsCardBox.x
    && box.right <= settingsCardBox.x + settingsCardBox.width
    && box.width <= settingsCardBox.width)).toBe(true);

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
});
