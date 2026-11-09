import { eq } from 'drizzle-orm';
import { afterAll, expect, test } from 'vitest';
import { createAuth } from '../../../src/auth';
import { CapturingEmailAdapter } from '../../../src/auth/email';
import { getHumanPrincipal } from '../../../src/auth/principal';
import { user, session } from '../../../src/db/schema/auth';
import { siteAdmins } from '../../../src/db/schema/site-admins';
import { organizations } from '../../../src/db/schema/org';
import { loadEnv } from '../../../src/env';
import { newId, withOrgBootstrapTx } from '../../../src/domain/kernel';
import { openDatabase, runtimeUrl } from '../helpers';

const runtime = openDatabase(runtimeUrl());
afterAll(() => runtime.pool.end());
const email = new CapturingEmailAdapter();
const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: runtimeUrl(), APP_BASE_URL: 'http://localhost:3000' });
const auth = createAuth(runtime.db, env, email);
const post = (path: string, body: object, cookie?: string) => auth.handler(new Request(`http://localhost:3000/api/auth${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
}));
const cookieFrom = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0];
const linkFrom = (text: string) => text.match(/https?:\/\/\S+/)![0];

async function account() {
  const address = `auth-${newId()}@example.com`;
  const signup = await post('/sign-up/email', { email: address, password: 'correct-horse-battery', name: 'Auth test', callbackURL: '/verify-email' });
  expect(signup.status).toBe(200);
  const result = await signup.json();
  const verification = email.messages.findLast((m) => m.to === address)!;
  return { address, id: result.user.id as string, verification };
}

test('verification and password reset emails have working links; verification is required and reset revokes sessions', async () => {
  const person = await account();
  expect(person.verification.subject).toBe('Verify your email');
  const denied = await post('/sign-in/email', { email: person.address, password: 'correct-horse-battery' });
  expect(denied.status).toBe(403);
  const verify = await auth.handler(new Request(linkFrom(person.verification.text)));
  expect(verify.status).toBe(302);
  expect(new URL(verify.headers.get('location')!, env.APP_BASE_URL).pathname).toBe('/verify-email');
  const [verified] = await runtime.db.select().from(user).where(eq(user.id, person.id));
  expect(verified.emailVerified).toBe(true);
  const signin = await post('/sign-in/email', { email: person.address, password: 'correct-horse-battery' });
  expect(signin.status).toBe(200);
  const cookie = cookieFrom(signin);
  expect(cookie).not.toBe('');
  const principal = await getHumanPrincipal(new Headers({ cookie, 'x-request-id': 'session-test' }), auth, runtime.db);
  expect(principal).toMatchObject({ userId: person.id, orgId: null, siteAdmin: false, interface: 'web', requestId: 'session-test' });
  await post('/request-password-reset', { email: person.address, redirectTo: '/reset-password' });
  const reset = email.messages.findLast((m) => m.to === person.address && m.subject === 'Reset your password')!;
  const callback = await auth.handler(new Request(linkFrom(reset.text)));
  expect(callback.status).toBe(302);
  const redirect = new URL(callback.headers.get('location')!);
  expect(redirect.pathname).toBe('/reset-password');
  const resetResult = await post('/reset-password', { token: redirect.searchParams.get('token'), newPassword: 'updated-horse-battery' });
  expect(resetResult.status).toBe(200);
  expect(await getHumanPrincipal(new Headers({ cookie }), auth, runtime.db)).toBeNull();
  expect((await post('/sign-in/email', { email: person.address, password: 'correct-horse-battery' })).status).toBe(401);
  const newSignin = await post('/sign-in/email', { email: person.address, password: 'updated-horse-battery' });
  expect(newSignin.status).toBe(200);
  const newCookie = cookieFrom(newSignin);
  expect((await post('/sign-out', {}, newCookie)).status).toBe(200);
  expect(await getHumanPrincipal(new Headers({ cookie: newCookie }), auth, runtime.db)).toBeNull();
});

test('principal rechecks verification, org ownership, expiry and admin role on every request', async () => {
  const person = await account();
  // Seed a session directly for an unverified user to prove principal rejects even a valid session.
  const sessionId = newId();
  await runtime.db.insert(session).values({ id: sessionId, token: newId(), userId: person.id, expiresAt: new Date(Date.now() + 3600000) });
  await auth.handler(new Request(linkFrom(person.verification.text)));
  const signin = await post('/sign-in/email', { email: person.address, password: 'correct-horse-battery' });
  const headers = new Headers({ cookie: cookieFrom(signin) });
  await runtime.db.update(user).set({ emailVerified: false }).where(eq(user.id, person.id));
  expect(await getHumanPrincipal(headers, auth, runtime.db)).toBeNull();
  await runtime.db.update(user).set({ emailVerified: true }).where(eq(user.id, person.id));
  const orgId = newId();
  await withOrgBootstrapTx(orgId, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: 'Owner principal', status: 'active', ownerUserId: person.id });
  }, runtime.db);
  expect(await getHumanPrincipal(headers, auth, runtime.db)).toMatchObject({ orgId });
  await runtime.db.insert(siteAdmins).values({ userId: person.id });
  expect(await getHumanPrincipal(headers, auth, runtime.db)).toMatchObject({ siteAdmin: true });
  await runtime.db.delete(siteAdmins).where(eq(siteAdmins.userId, person.id));
  expect(await getHumanPrincipal(headers, auth, runtime.db)).toMatchObject({ siteAdmin: false });
  const otherId = newId();
  await runtime.db.insert(user).values({ id: otherId, name: 'Other', email: `${otherId}@example.com`, emailVerified: true });
  await runtime.db.update(organizations).set({ ownerUserId: otherId }).where(eq(organizations.id, orgId));
  expect(await getHumanPrincipal(headers, auth, runtime.db)).toMatchObject({ orgId: null });
  await runtime.db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.userId, person.id));
  expect(await getHumanPrincipal(headers, auth, runtime.db)).toBeNull();
  expect(await getHumanPrincipal(new Headers(), auth, runtime.db)).toBeNull();
});

test('production cookies are secure, httpOnly and SameSite=Lax; untrusted origins cannot mutate', async () => {
  const person = await account();
  await runtime.db.update(user).set({ emailVerified: true }).where(eq(user.id, person.id));
  const production = createAuth(runtime.db, loadEnv({ ...env, NODE_ENV: 'production', BETTER_AUTH_SECRET: 'x'.repeat(48),
    CURSOR_HMAC_SECRET: 'y'.repeat(48), APP_BASE_URL: 'https://board.example.com', RESEND_API_KEY: 're_fixture', EMAIL_FROM: 'board@example.com' }), email);
  const request = (origin: string) => production.handler(new Request('https://board.example.com/api/auth/sign-in/email', {
    method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': '192.0.2.101', cookie: 'csrf-probe=1', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ email: person.address, password: 'correct-horse-battery' }),
  }));
  expect((await request('https://evil.example.com')).status).toBe(403);
  const signed = await request('https://board.example.com');
  expect(signed.status).toBe(200);
  const set = signed.headers.get('set-cookie')!;
  expect(set).toMatch(/HttpOnly/i); expect(set).toMatch(/Secure/i); expect(set).toMatch(/SameSite=Lax/i);
});
