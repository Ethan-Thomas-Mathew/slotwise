import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Mailbox } from './mailbox';

/**
 * Flows that depend on a link in an email: staff invites and password reset.
 * The real worker sends real SMTP to a local test mailbox.
 */
test.describe.configure({ mode: 'serial' });

const mailbox = new Mailbox();
const id = randomUUID().slice(0, 8);
const staff = { name: 'Sana Staff', email: `staff-${id}@e2e.test` };

test.beforeAll(() => mailbox.start(2526));
test.afterAll(() => mailbox.stop());

test('owner invites a team member, who accepts from the email link', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage();
  await owner.goto('/signup');
  await owner.getByLabel('Business name').fill(`Invite Clinic ${id}`);
  await owner.getByLabel('Booking link').fill(`invite-${id}`);
  await owner.getByLabel('Your name').fill('Olga Owner');
  await owner.getByLabel('Email').fill(`owner-inv-${id}@e2e.test`);
  await owner.getByLabel('Password').fill('ownerpass123');
  await owner.getByRole('button', { name: 'Create booking page' }).click();
  await expect(owner).toHaveURL(/\/app\/services/);

  await owner.getByRole('link', { name: 'Team and hours' }).click();
  await owner.getByRole('button', { name: 'Invite someone' }).click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Name').fill(staff.name);
  await dialog.getByLabel('Email').fill(staff.email);
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  await expect(owner.getByText(`Invite sent to ${staff.email}`)).toBeVisible();

  const link = await mailbox.linkSentTo(staff.email, '/accept-invite?token=');

  const page = await (await browser.newContext()).newPage();
  await page.goto(link);
  await expect(page.getByRole('heading', { name: `Join Invite Clinic ${id}` })).toBeVisible();
  await page.getByLabel('Your name').fill(staff.name);
  await page.getByLabel('Choose a password').fill('staffpass123');
  await page.getByRole('button', { name: 'Accept invite' }).click();
  await expect(page.getByRole('heading', { name: 'My schedule' })).toBeVisible();

  // The owner now sees them on the team.
  await owner.reload();
  await expect(owner.getByText(staff.name)).toBeVisible();
});

test('a forgotten password can be reset from the email link', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill(staff.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/reset link is on its way/)).toBeVisible();

  const link = await mailbox.linkSentTo(staff.email, '/reset-password?token=');
  await page.goto(link);
  await page.getByLabel('New password').fill('brandnewpass1');
  await page.getByLabel('Repeat it').fill('brandnewpass1');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByText(/Password changed/)).toBeVisible();

  // The link works only once.
  await page.goto(link);
  await page.getByLabel('New password').fill('anotherpass12');
  await page.getByLabel('Repeat it').fill('anotherpass12');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid or has expired/);

  // The new password works.
  await page.goto('/login');
  await page.getByLabel('Email').fill(staff.email);
  await page.getByLabel('Password').fill('brandnewpass1');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'My schedule' })).toBeVisible();
});
