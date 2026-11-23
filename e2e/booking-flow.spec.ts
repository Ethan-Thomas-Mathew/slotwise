import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * The critical paths, through the real UI:
 *  1. An owner signs up, adds a service and their working hours.
 *  2. A customer books a slot, pays (mock provider → real signed webhook) and sees it confirmed.
 *  3. The owner sees the booking.
 *  4. The customer cancels well in advance and gets a refund (processed by the worker).
 */
test.describe.configure({ mode: 'serial' });

const id = randomUUID().slice(0, 8);
const slug = `e2e-${id}`;
const owner = { name: 'Esha Owner', email: `owner-${id}@e2e.test`, password: 'ownerpass123' };
const customer = {
  name: 'Chetan Customer',
  email: `customer-${id}@e2e.test`,
  password: 'custpass123',
};

let ownerPage: Page;
let customerPage: Page;

test.beforeAll(async ({ browser }) => {
  ownerPage = await (await browser.newContext()).newPage();
  customerPage = await (await browser.newContext()).newPage();
});

test('owner signs up and sets up a service and working hours', async () => {
  const page = ownerPage;
  await page.goto('/signup');
  await page.getByLabel('Business name').fill(`E2E Salon ${id}`);
  await page.getByLabel('Booking link').fill(slug);
  await page.getByLabel('Your name').fill(owner.name);
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Create booking page' }).click();
  await expect(page).toHaveURL(/\/app\/services/);

  await page.getByRole('button', { name: 'Add a service' }).click();
  await page.getByLabel('Name').fill('Haircut');
  await page.getByLabel('Length (minutes)').fill('30');
  await page.getByLabel('Price (₹)').fill('500');
  await page.getByRole('button', { name: 'Add service' }).click();
  await expect(page.getByText('30 min, ₹500.00')).toBeVisible();

  // The owner works too: offer the service and set hours for every day.
  await page.getByRole('link', { name: 'Team and hours' }).click();
  await page.getByRole('button', { name: 'Haircut' }).click();
  await expect(page.getByRole('button', { name: 'Haircut' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Working hours' }).click();
  const dialog = page.getByRole('dialog');
  for (let i = 0; i < 7; i++)
    await dialog.getByRole('button', { name: 'Add hours' }).nth(i).click();
  await dialog.getByRole('button', { name: 'Save hours' }).click();
  await expect(page.getByText('Working hours saved')).toBeVisible();
});

test('customer books and pays; the booking is confirmed by the webhook', async () => {
  const page = customerPage;
  await page.goto(`/b/${slug}`);
  await page.getByRole('radio', { name: /Haircut/ }).click();
  // Only one person offers it, so they are picked automatically.
  await page.getByRole('radiogroup', { name: 'Day' }).getByRole('radio').nth(3).click();
  const slots = page.getByRole('list', { name: /Open times/ }).getByRole('button');
  await slots.first().click();

  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill(customer.name);
  await page.getByLabel('Email').fill(customer.email);
  await page.getByLabel('Password').fill(customer.password);
  await page.getByRole('button', { name: 'Create account' }).click();

  // Back on the booking page with the same choice.
  await page.getByRole('button', { name: 'Hold this time and pay' }).click();
  await expect(page).toHaveURL(/\/checkout\//);
  await expect(page.getByText("We're holding this time for you")).toBeVisible();

  await page.getByRole('button', { name: 'Pay ₹500.00' }).click(); // creates the order
  await page.getByRole('button', { name: 'Pay ₹500.00' }).click(); // mock provider "pays"
  await expect(page.getByText('Booking confirmed')).toBeVisible({ timeout: 20_000 });
});

test('the owner sees the new booking', async () => {
  await ownerPage.getByRole('link', { name: 'Bookings' }).click();
  await expect(
    ownerPage.getByText(`Haircut with ${owner.name} for ${customer.name}`),
  ).toBeVisible();
  await expect(ownerPage.getByText('Paid ₹500.00')).toBeVisible();
});

test('customer cancels in advance and is refunded', async () => {
  const page = customerPage;
  await page.goto('/app/bookings');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText(/full refund of ₹500.00/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(page.getByText('Booking cancelled')).toBeVisible();

  // The worker calls the (mock) provider in the background.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Refund issued: ₹500.00')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
});
