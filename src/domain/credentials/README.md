# Credentials domain (T04)

All ordinary operations open one `withOrgTx`. The bearer bootstrap uses the
SELECT-only `withTokenLookupTx`, then an org transaction for fresh grants and
`last_used_at`. No secret or hash appears in metadata, events or audit records.
Dates are UTC ISO strings. The secret is returned only by create/replace.

## Agent calls

- `authenticateBearer(header, { requestId, interface })`: `AgentPrincipal` with
  null agent/session IDs. Strict `amb_<base62 8>_<base62 40>` format, SHA-256,
  constant-time hash comparison; all malformed/unknown/dead credentials share
  `unauthenticated`. Suspended orgs return `org_suspended`.
- `connectAgent(principal, { name, clientLabel? })`: `{ agent, sessionId,
  capabilities: { canCreateProjects }, defaults: [{ id, slug, name }] }`.
  Case-insensitive concurrent first connections reuse one agent. New business
  session on each connection. Instructions are left to T11.
- `resolveAgentSession(principal, sessionId)`: resolved principal, bound to this
  token and org, with fresh grants/capabilities; updates session/agent last seen.
- `selectSessionProjects(resolvedPrincipal, projectIds)`: replaces the selection
  with a subset of accessible active defaults. Empty resets to defaults.
- `resolveTargetProjects(resolvedPrincipal, { projectId?, mode })`: labeled
  project records. Explicit IDs are authorized; otherwise session selection,
  falling back to accessible active agent defaults when no selection rows exist.
  A stale selection never falls through to different defaults. Zero targets:
  `no_project_selected`; multiple write targets: `ambiguous_project` with
  `details.projects`. Explicit reads can access archived projects; writes cannot.
- `getAgentDefaults(principal, agentId)`: accessible active defaults; agents may
  read only their own resolved identity's defaults.

T07 composes `resolveTargetProjectsInTx(tx, ctx, input)` and
`getAgentDefaultsInTx(tx, ctx, agentId)` inside its existing org transaction.
Every default is intersected with fresh access, never treated as authority.
A principal retaining a removed grant is rejected by the kernel; reauthenticate
on every request, including requests using an existing session.

## Owner calls

Agents and system principals receive `capability_denied` on these exports:

- `createToken(principal, CreateTokenInput)`: `{ token: metadata, secret }`.
  Input: label, scope, optional projectIds, canCreateProjects, expiresAt (Date or
  ISO string). Creation defaults true for org scope and false for projects scope.
  Org tokens have no grant rows. Expiration must be in the future.
- `listTokens(principal)`: safe metadata with current projectIds.
- `revokeToken(principal, tokenId)`: revocation timestamp, preserving history.
- `replaceToken(principal, tokenId)`: creates a new credential with the same
  label/scope/grants/flags/expiry; old credential remains live until revoked.
  An already expired expiration cannot issue a usable replacement.
- `setTokenGrants(principal, tokenId, projectIds)`: replace restricted allowlist.
- `listAgents(principal)`: agent name and last-seen metadata.
- `listAgentSessions(principal, agentId)`: session metadata including tokenPrefix,
  clientLabel, createdAt, lastSeenAt, never a credential hash.
- `setAgentDefaults(principal, agentId, projectIds)`: replaces default assignments.

Owner reads also have `listTokensInTx(tx, ctx)`, `listAgentsInTx(tx, ctx)`, and
`listAgentSessionsInTx(tx, ctx, agentId)` forms. Use a kernel-created context.
Credential/default access mutations emit `access.changed` for cursor resync;
connection, session activity and selection writes are audited. There is no
session event kind in the kernel; usage timestamp maintenance emits no event.

`secrets.ts` contains internal random/hash helpers (not adapter entry points).
Base62 generation rejects bytes 248–255, avoiding modulo bias.

## Owner connection wizard (D-030)

- `setupAgentConnection(owner, { agentName, clientLabel?, token, defaultProjectIds })`
  registers or case-insensitively reuses the agent, issues a token with the internal
  issuer, and replaces defaults in one org transaction. Restricted defaults must
  be in the token allowlist. Validation, audit or event failures roll everything
  back. New identities audit `agent.register`; token/default actions retain their
  normal audit and `access.changed` events. Returns the secret only once.
- `getConnectionDiagnostics(owner, { agentId, tokenId })` returns org/agent metadata,
  only sessions for that exact agent/token pair, effective projects (archives are
  read-only), active defaults intersected with access, and creation capability.
  Revocation/expiry metadata is included. Foreign and absent ids are identical
  `forbidden_or_not_found`. No secret or hash is accepted or returned.

Both exports reject agents and system principals with `capability_denied`.
`clientLabel` validates the chosen setup client; the actual session label comes
from the agent's own `connectAgent` call, never a diagnostic test connection.
