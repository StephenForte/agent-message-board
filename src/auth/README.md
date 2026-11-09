# Human authentication (T03)

Import `getHumanPrincipal(headers)` from `src/auth/principal` in server code. It returns
`HumanPrincipal | null` and re-reads the session, user verification, ownership, and
site-admin role on every call. No session cookie cache is enabled. A missing, expired,
or unverified session returns null; database outages throw rather than implying sign-out.
`orgId` is exclusively the authenticated user's owned organization, possibly null.
`siteAdmin` is a hint: admin domain operations recheck `site_admins` in their transaction.
`requestId` uses the validated x-request-id header; `interface` is web.

`requireHuman()` redirects to `/sign-in?message=session-expired` with a visible message.
`requireAdmin()` returns 404 for non-admins. Wave 3 shell code should call
`humanLanding(principal)` to route no-org and suspended owners before rendering content,
then use the kernel's `withOrgTx` on every content operation. T03 does not change the root shell.

Better Auth uses `/api/auth` (shared `AUTH_BASE_PATH`), APP_BASE_URL and its origin,
verified email/password, default per-instance rate limiting, and Next server-action cookies.
`createAuth(db, env, emailAdapter)` supports capturing email in tests; production uses Resend.
Grant site admin only with `npm run admin:grant -- <verified-email>`.

Activation is bound to the invited verified email. Links are 32 random bytes, hashed at rest,
expire after 72 hours, and consume with a conditional update in the ownership transaction.
Issuing a replacement invalidates prior unused links; explicit association invalidates them too.
Already-owned organizations cannot be claimed using an old link.

Credential-bearing path prefixes live in `src/auth/paths.ts`. Add every future secret path
there before introducing its route. `redactRoute` drops queries/fragments, decodes once to
recognize encoded prefixes, and replaces the entire suffix after a credential prefix with
`[redacted]`. Malformed encoding is fully redacted. Finish and failure logs share that value.
Activation and password-reset credentials must never appear in audit metadata or ordinary logs.
Admin activation URLs exist only in the current action result; no persistence or redisplay API.
