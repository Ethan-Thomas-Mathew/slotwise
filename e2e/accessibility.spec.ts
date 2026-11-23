import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/** Automated accessibility checks (WCAG 2.1 A/AA rules) on the main public pages. */
const PAGES = ['/', '/login', '/signup', '/register', '/forgot-password', '/b/does-not-exist'];

for (const path of PAGES) {
  test(`no serious accessibility problems on ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}

test('no serious accessibility problems on the booking page and the owner dashboard', async ({
  page,
}) => {
  const id = Math.random().toString(36).slice(2, 10);
  await page.goto('/signup');
  await page.getByLabel('Business name').fill(`A11y ${id}`);
  await page.getByLabel('Booking link').fill(`a11y-${id}`);
  await page.getByLabel('Your name').fill('Owner');
  await page.getByLabel('Email').fill(`a11y-${id}@e2e.test`);
  await page.getByLabel('Password').fill('ownerpass123');
  await page.getByRole('button', { name: 'Create booking page' }).click();
  await expect(page).toHaveURL(/\/app\/services/);

  for (const path of [
    '/app/overview',
    '/app/services',
    '/app/team',
    '/app/settings',
    `/b/a11y-${id}`,
  ]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(serious.map((v) => `${path} ${v.id}: ${v.help}`)).toEqual([]);
  }
});
