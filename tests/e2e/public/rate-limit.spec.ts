import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('the 61st public fetch from one address is 429 and other traffic is not', async ({ request }) => {
  test.setTimeout(120_000);
  const address = randomUUID();
  const other = randomUUID();
  const path = `/rl-${randomUUID().slice(0, 8)}/missing`;
  const headers = { 'True-Client-IP': address };

  for (let n = 1; n <= 60; n += 1) {
    const response = await request.get(path, { headers });
    expect(response.status(), `request ${n}`).not.toBe(429);
  }

  const blocked = await request.get(path, { headers });
  expect(blocked.status()).toBe(429);
  const retryAfter = Number(blocked.headers()['retry-after']);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(60);
  expect(blocked.headers()['cache-control']).toContain('no-store');
  expect(blocked.headers()['x-robots-tag']).toContain('noindex');
  expect(blocked.headers()['x-request-id']).toBeTruthy();
  const body = await blocked.text();
  expect(body.length).toBeGreaterThan(0);
  expect(body.length).toBeLessThan(400);
  expect(body).not.toContain('<html');

  const neighbor = await request.get(path, { headers: { 'True-Client-IP': other } });
  expect(neighbor.status()).not.toBe(429);

  const signIn = await request.get('/sign-in', { headers });
  expect(signIn.status()).not.toBe(429);
});
