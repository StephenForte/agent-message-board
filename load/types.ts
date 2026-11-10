/** Shape of the seeded pilot (or smoke) database. The manifest file holds bearer secrets and stays in $AMB_TMP. */
export type LoadManifest = {
  createdAt: string;
  commit: string;
  smoke: boolean;
  serverVersion: string;
  databaseName: string;
  roleName: string;
  adminUrl: string;
  runtimeUrl: string;
  seedSeconds: number;
  databaseBytes: number;
  counts: {
    orgs: number;
    projects: number;
    agents: number;
    roots: number;
    replies: number;
    messages: number;
  };
  orgs: LoadOrg[];
};

export type LoadOrg = {
  orgId: string;
  name: string;
  projects: Array<{ id: string; slug: string; rootIds: string[] }>;
  agents: LoadAgent[];
};

export type LoadAgent = {
  name: string;
  agentId: string;
  secret: string;
  scope: 'org' | 'projects';
  /** Projects this token may write. Org-wide tokens list every project. */
  writableProjectIds: string[];
  /** Stable check_board / list_messages target. Changing it invalidates cursors. */
  listProjectId: string;
  updateRootId: string;
  updateVersion: number;
  updateUrgent: boolean;
};

export type ToolName =
  | 'connect_agent'
  | 'check_board'
  | 'list_messages'
  | 'get_thread'
  | 'post_message'
  | 'reply_message'
  | 'update_message';

export const READ_TOOLS = ['check_board', 'list_messages', 'get_thread'] as const;
export const WRITE_TOOLS = ['post_message', 'reply_message', 'update_message'] as const;

/** 80% of D-029, per token per clock minute: 96 reads and 24 writes. */
export const READS_PER_MINUTE = 96;
export const WRITES_PER_MINUTE = 24;
