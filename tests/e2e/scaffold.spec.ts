import { expect, test } from '@playwright/test';

test('anonymous home requires a session', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.headers()['x-request-id']).toMatch(/^[A-Za-z0-9._-]+$/);
  await expect(page).toHaveURL(/\/sign-in\?message=session-expired$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('session has expired');
});
test('health and missing routes echo valid request ids', async ({ request }) => {
  const response = await request.get('/api/health', { headers: { 'x-request-id': 'e2e-health-1' } });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
  expect(response.headers()['x-request-id']).toBe('e2e-health-1');
  const missing = await request.get('/missing', { headers: { 'x-request-id': 'e2e-404' } });
  expect(missing.status()).toBe(404);
  expect(missing.headers()['x-request-id']).toBe('e2e-404');
});
test('invalid inbound request ids are replaced', async ({ request }) => {
  const response = await request.get('/api/health', { headers: { 'x-request-id': 'bad id' } });
  expect(response.headers()['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
});
