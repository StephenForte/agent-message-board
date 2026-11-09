# Domain kernel

T03–T06 call this module and do not touch `src/db` or add migrations. Import from
`src/domain/kernel`. The org id always comes from the principal. Never take it
from a tool argument, form field, or query string.

## Transactions

Every tenant read or write runs inside one of these. They are the only supported
places that set the `app.*` session variables.

| Function | Sets | Use |
| --- | --- | --- |
| `withOrgTx(principal, fn)` | `app.org_id` from `principal.orgId` | Ordinary tenant work. Re-checks that the org is active. For an agent, re-reads the token and grants before `fn`. |
| `withOrgBootstrapTx(orgId, fn)` | `app.org_id` to the new id | Inserting an `organizations` row. The insert trigger creates `org_event_counters`. Without this setting the trigger's insert fails RLS for a non-superuser. This helper does not check that the caller is a site admin; T03 must do that first. |
| `withTokenLookupTx(prefix, fn)` | clears `app.org_id`, sets `app.token_prefix` | Authentication only, before the org is known. |
| `withSiteAdminTx(fn)` | clears `app.org_id`, sets `app.site_admin=1` | Site-scope announcement writes. Not board access. Does not itself check `site_admins`; the caller does. |

`withOrgTx` rejects:

- a missing or non-owner human, or a missing org: `forbidden_or_not_found`
- `organizations.status = suspended`: `org_suspended`
- a revoked, expired, or unknown token: `unauthenticated`
- a project-scoped principal whose `projectIds` is `'all'`, or any listed project id that no longer has a grant: `forbidden_or_not_found`

Inside the callback, `ctx.projectIds` is `'all'` or the token's **current** grants.
`ctx.canCreateProjects` is re-read from the token for agents. Defaults are not on
the principal and must not be used to allow a project.

A project-scoped caller must pass the allowlist it authenticated with. An id that
was removed fails the whole transaction, so a stale grant cannot be used on the
next call.

## Authorization

`assertProjectAccess(tx, principal, projectId, 'read' | 'write')` returns the
project. Missing and unauthorized are both `forbidden_or_not_found`. Write on an
archived project the caller can access is `project_archived`. Read of an archived
project is allowed.

`accessibleProjectIds(tx, principal, { includeArchived })` lists ids the token or
owner can see. It does not read `agent_project_defaults` or
`agent_session_projects`. A default never adds a project the token cannot access.

Org-wide tokens (`scope: 'org'`) and human owners can access every project in the
org. Restricted tokens need a `token_project_grants` row.

## Events, audit, idempotency

Call these on the `tx` from `withOrgTx`. Do not open a second connection.

`appendEvents(tx, orgId, events)` locks `org_event_counters` in this transaction
and assigns `seq`. A later transaction in the same org blocks until this one
commits, so seq order is commit order. `currentWatermark` and `readEventsAfter`
only observe committed rows. Kinds:

- `message.created`, `message.replied`, `message.flag_changed`, `message.archived`, `message.restored`
- `project.created`, `project.updated`, `project.archived`, `project.restored`
- `access.changed` — grant or scope change. Clients must resync. Do not put announcement changes here; announcement freshness is separate from the cursor.

Payloads are small JSON. `body`, `password`, `secret`, `token`, and raw token
hashes are rejected. There is no message body in an event.

`writeAudit(tx, ctx, record)` writes the actor from `ctx` in the same transaction.
Same secret rejection. Do not put token secrets or message bodies in `before` / `after`.

`withIdempotency(tx, ctx, operation, key, payload, fn)` is keyed by org, actor
(user id or token id), operation, and key (D-013). The row is inserted before
`fn` and the response is stored before commit. A second transaction with the
same key waits, then returns the stored JSON. Same key and different canonical
payload throws `idempotency_conflict`. If `fn` throws, the transaction rolls
back and the key can be used again. Retention is 48 hours. Replay returns JSON
(dates become strings).

## Errors

`DomainError` codes are the closed list in `errors.ts` (D-015).

- `versionConflict(currentVersion, state)` sets `details.currentVersion` and `details.state`
- `invalidCursor(resync)` sets `details.resync`
- `rateLimited(retryAfterSeconds)` sets `details.retryAfterSeconds`

## Identifiers

`newId()` is a UUIDv7. Do not call `uuidv7()` in SQL.

## Health

`checkDatabase()` is what `/api/health` and `src/lib/server.ts` call. It does not
log the driver error. Startup exits before `listen` when this returns false.
Migrations are `npm run db:migrate`, never on web start.

## Token bootstrap

`agent_tokens` has RLS. A normal org transaction sees only that org's tokens.
Lookup by prefix happens before the org is known, so the policy also allows the
single row whose `prefix` equals `app.token_prefix`, and only when `app.org_id`
is unset. `withTokenLookupTx` is that path. It selects id, org, prefix, hash,
scope, `can_create_projects`, expiry, and revocation. It does not return other
tokens. Setting a prefix while an org is set does not reveal another org's token.
Inserts still require `app.org_id`.

## Tables without RLS

| Table | Why |
| --- | --- |
| `user`, `session`, `account`, `verification` | Better Auth. No org. Read during login, before any tenant context. Configure the adapter with `betterAuthDrizzleConfig` from `src/db/auth-schema.ts`. |
| `site_admins` | Global role (D-006), not a Better Auth user field. Site admin is not board access. |
| `organizations` | The tenant root. Site admin lists orgs before an org context exists. Callers still only use the principal's org id. |
| `owner_activations` | Single-use link. The hash is the credential; the org is not a session yet. Store `token_hash` only. |

Every other table has `ENABLE` and `FORCE ROW LEVEL SECURITY`. A missing
`app.org_id` matches no rows. `announcements` and `announcement_revisions` are
the exception inside the policy: with an org set, `scope = 'site'` is visible
to every org, and org rows only match their own org. Site rows are written only
through `withSiteAdminTx`.

## Worked example

A mutation stays in one `withOrgTx` callback: authorize, write, event, audit.
Idempotency wraps that whole unit when the operation has a client key.

```ts
import {
  appendEvents, assertProjectAccess, withIdempotency, withOrgTx, writeAudit,
} from './index';

await withOrgTx(principal, async (tx, ctx) => {
  return withIdempotency(tx, ctx, 'project.create', idempotencyKey, input, async () => {
    const project = await assertProjectAccess(tx, principal, input.projectId, 'write');
    // The real insert lives in the feature module (T04–T06), using this same tx.
    await appendEvents(tx, ctx.orgId, [{
      kind: 'project.updated',
      projectId: project.id,
      payload: { status: 'active' },
    }]);
    await writeAudit(tx, ctx, {
      action: 'project.update',
      entityType: 'project',
      entityId: project.id,
      before: { name: project.name },
      after: { name: input.name },
    });
    return { id: project.id };
  });
});
```

Creating the organization itself is the bootstrap path, not `withOrgTx`:

```ts
await withOrgBootstrapTx(orgId, async (tx) => {
  await tx.insert(organizations).values({ id: orgId, name, ownerUserId, status: 'active' });
});
```
