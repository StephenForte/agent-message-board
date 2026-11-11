# Projects domain (T04)

Adapters call these exports; org identity comes from the principal. All operations
use the kernel and the runtime database, with no adapter SQL required.

- `createProject(principal, { name, slug, description?, idempotencyKey })` returns
  project metadata (ISO timestamps), idempotently. A human owner may create; an
  agent needs a resolved session and the current creation capability. Creation,
  token-specific `agent_create` grant (restricted tokens only), agent default,
  event and audit commit together. A replay has the same serialized shape.
- `updateProject(principal, projectId, { name?, description? })`
- `archiveProject(principal, projectId)`, `restoreProject(principal, projectId)`
  are owner-only and emit project events plus before/after audit metadata.
- `setProjectVisibility(principal, projectId, 'private' | 'public')` is owner-only.
  It writes an audit row with the previous and next visibility and emits
  `access.changed`. Agents cannot change it. Serialized projects include
  `visibility` (`private` by default, including `createProject` and `listProjects`).
- `listProjects(principal, { includeArchived? } = {})` returns only accessible
  projects, sorted by slug, with ISO timestamps. Active only by default.
- `getProjectBySlug(principal, slug)` returns a kernel `ProjectRecord` plus
  `visibility`. Hidden and absent slugs both return `forbidden_or_not_found`.
- `listProjectsInTx(tx, ctx, options?)`, `getProjectBySlugInTx(tx, ctx, slug)`
  compose reads in T07's existing `withOrgTx` (do not open another transaction).

`CreateProjectInput` is the creation input type. `requireOwner`, `requireId`,
`textField` are shared validation helpers used by credentials. Owners must still
be verified by `withOrgTx`; the kind check alone is not owner authorization.

No schema changes, UI, or MCP adapters. Caller supplies request ID and interface
on the principal. Kernel errors pass through unchanged.
