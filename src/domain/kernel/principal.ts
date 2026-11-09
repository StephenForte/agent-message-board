export type InterfaceKind = 'web' | 'mcp' | 'cli';

type Common = {
  interface: InterfaceKind;
  requestId: string;
};

/** Owned org comes from the authenticated user, never from a request argument. */
export type HumanPrincipal = Common & {
  kind: 'human';
  userId: string;
  orgId: string | null;
  siteAdmin: boolean;
};

/**
 * orgId, scope, and project ids come from the token row. `projectIds: 'all'`
 * is only valid for an org-wide token. Defaults are not part of this type.
 */
export type AgentPrincipal = Common & {
  kind: 'agent';
  orgId: string;
  tokenId: string;
  scope: 'org' | 'projects';
  projectIds: readonly string[] | 'all';
  canCreateProjects: boolean;
  agentId: string | null;
  sessionId: string | null;
};

/** CLI and tests. Not a substitute for a human or agent credential. */
export type SystemPrincipal = Common & {
  kind: 'system';
  orgId: string | null;
};

export type Principal = HumanPrincipal | AgentPrincipal | SystemPrincipal;
