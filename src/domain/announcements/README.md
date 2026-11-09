# Announcements domain

Site-wide and organization-wide announcements. T08 calls the plain readers and
writers. T07 calls `getAnnouncementsInTx` inside its board-check transaction.
No events are appended: announcement freshness is independent of the cursor.

Import from `src/domain/announcements`.

## Exports

| Export | Behavior |
| --- | --- |
| `getAnnouncements(principal)` | `{ site, org }`. Each is null or a live `Announcement`. A cleared row is null. |
| `getAnnouncementsInTx(tx, ctx)` | Same pair, using the caller's transaction and `ctx.orgId`. |
| `setOrgAnnouncement(principal, { title, body, expectedVersion })` | Org owner only, inside `withOrgTx`. One audit row. |
| `clearOrgAnnouncement(principal, { expectedVersion })` | Org owner only. Sets `cleared_at`, keeps the row, writes a revision, one audit row. |
| `setSiteAnnouncement(principal, { title, body, expectedVersion })` | Inside `withSiteAdminTx`. Re-reads `site_admins` in that transaction. No audit row. |
| `clearSiteAnnouncement(principal, { expectedVersion })` | Same admin re-check. No audit row. |
| `listAnnouncementRevisions(principal, { scope, limit? })` | Org history for the owner, site history for a current site admin. Newest first. Limit default 20, max 100. |

`Announcement` is `{ id, scope, title, body, version, authorDisplayName, authorKind: 'human', updatedAt }`.
`authorDisplayName` is the current `user.name` of `author_user_id`. `authorKind` is always `'human'`.
`AnnouncementRevision` adds `clearedAt` and `createdAt`. Clears are included.
`AnnouncementMutationResult` is `{ id, scope, version, cleared }`.

An optional `database` argument follows the kernel helpers so tests can pass the non-superuser pool. Application code omits it. Authorization and content checks run before that pool is opened.

## Versions

The first publish is version 1 and requires `expectedVersion: 0`. Every later set or clear adds 1, whether the current row is active or cleared. A stale `expectedVersion` throws `version_conflict` with `details.currentVersion` and `details.state`, and writes nothing.

`details.state` is `null` when no row exists, `'active'` when it is published, and `'cleared'` when `cleared_at` is set. After a clear, `getAnnouncements` returns null for that scope; the next `expectedVersion` is the cleared row's version, from `listAnnouncementRevisions` or from the conflict details. Passing 0 again is a conflict, not a new first publish.

Two concurrent first publishes: one commits, the other gets `version_conflict` (the partial unique index is mapped off the raw driver error).

## Authorization

Agents and other non-human principals get `capability_denied` on every set, clear, and history list, before a transaction opens. Reads go through `withOrgTx`, so a suspended org returns `org_suspended` for the owner and for agents.

Org writes require the human owner. `withOrgTx` rejects anyone else with `forbidden_or_not_found`. The org id comes from the principal.

Site writes do not trust `principal.siteAdmin`. The user's `site_admins` row is locked and re-read inside `withSiteAdminTx`. A missing row is `forbidden_or_not_found`, including when the principal was built while the user was still an admin. Site writes are not done inside `withOrgTx`: a tenant context can read the site row and cannot change it.

## Limits and audit

Title and body are measured with UTF-8 byte length. Title must be 1–16384 bytes. Body may be empty and must be ≤ 16384 bytes. Violations are `content_too_large`.

Org set and org clear each write one `announcement.set` or `announcement.clear` audit row whose `before` / `after` are `{ version, cleared }` only. The body is not copied into the audit payload. Site changes write no audit row; `announcement_revisions` is their history (D-023). Rows are never deleted.
