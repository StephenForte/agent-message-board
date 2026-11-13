export { account, session, user, verification } from './auth';
export { announcementRevisions, announcements } from './announcements';
export { agentTokens, agents } from './identity';
export { messageRecipients, messages } from './messages';
export { auditRecords, events, idempotencyRecords, rateLimitWindows } from './ops';
export { memberInvitations, orgEventCounters, orgMembers, organizations, ownerActivations } from './org';
export { agentProjectDefaults, projects, tokenProjectGrants } from './projects';
export { agentSessionProjects, agentSessions } from './sessions';
export { siteAdmins } from './site-admins';

/** Tables with ENABLE + FORCE ROW LEVEL SECURITY. */
export const tenantTableNames = [
  'projects',
  'agent_tokens',
  'token_project_grants',
  'agents',
  'agent_project_defaults',
  'agent_sessions',
  'agent_session_projects',
  'messages',
  'message_recipients',
  'announcements',
  'announcement_revisions',
  'org_event_counters',
  'events',
  'audit_records',
  'idempotency_records',
  'rate_limit_windows',
] as const;

/**
 * Tables deliberately without RLS. Reasons live in src/domain/kernel/README.md.
 * A new public table must be added to exactly one of these lists.
 */
export const rlsExemptTableNames = [
  'user',
  'session',
  'account',
  'verification',
  'site_admins',
  'organizations',
  'owner_activations',
  'org_members',
  'member_invitations',
] as const;
