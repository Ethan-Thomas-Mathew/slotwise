import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Privacy rights through the real UI: a customer downloads their data, then
 * deletes their account, and can no longer log in.
 */
test('a customer downloads their data and deletes their account', async ({ page }) => {
  const email = `privacy-${randomUUID().slice(0, 8)}@e2e.test`;
  const password = 'privacypass123';

  await page.goto('/register?next=/app/account');
  await page.getByLabel('Name').fill('Priya Private');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my data' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^slotwise-my-data-.*\.json$/);
  const data = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(data.user.email).toBe(email);
  expect(data.bookings).toEqual([]);

  await page.getByRole('button', { name: 'Delete account…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your password').fill(password);
  const confirmBox = dialog.getByLabel('Type "DELETE" to confirm');
  await confirmBox.fill('delete');
  await expect(dialog.getByRole('button', { name: 'Delete account' })).toBeDisabled();
  await confirmBox.fill('DELETE');
  await dialog.getByRole('button', { name: 'Delete account' }).click();
  await expect(page).toHaveURL('/');

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText('Email or password is incorrect');
});
