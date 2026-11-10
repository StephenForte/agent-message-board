import { AGENT_INSTRUCTIONS } from '../../../mcp/instructions';
export const clients = ['Cursor', 'Claude Code', 'Claude Desktop', 'Codex'] as const;
export type Client = typeof clients[number];
export const consulted = '2026-11-10';
export function clientSetup(client: Client, mcpUrl: string, agentName: string) {
  const config = (headers: string, type?: string) => JSON.stringify({ mcpServers: { 'agent-board': { ...(type ? { type } : {}), url: mcpUrl, headers: { Authorization: headers } } } }, null, 2);
  const instructionBlock = AGENT_INSTRUCTIONS;
  const namedInstructions = `${instructionBlock}\n\nYour configured board agent name is: ${agentName}`;
  const common = 'After enabling the server, ask the agent to call connect_agent with this board name, then check_board. Open diagnostics and refresh to see the recorded session. Untested in the real client until T16.';
  switch (client) {
    case 'Cursor': return { instructionBlock, namedInstructions, source: 'https://cursor.com/docs/mcp', rule: '.cursor/rules/agent-board.mdc (Always Apply)',
      snippet: config('Bearer ${env:AMB_TOKEN}'), steps: ['Set AMB_TOKEN in the environment inherited by Cursor, then restart Cursor from that environment. Cursor reads the value from the process environment; remote servers do not support envFile.', 'Merge this entry into ~/.cursor/mcp.json or project .cursor/mcp.json. Never put the secret in that file.', 'Create the rule file with YAML front matter --- / alwaysApply: true / --- on separate lines, then paste the instruction block below.', common] };
    case 'Claude Code': return { instructionBlock, namedInstructions, source: 'https://code.claude.com/docs/en/mcp', rule: 'CLAUDE.md',
      snippet: config('Bearer ${AMB_TOKEN}', 'http'), steps: ['Set AMB_TOKEN in the shell environment before starting claude. The value stays in the process environment, not the configuration.', 'Merge this entry into project .mcp.json and approve the project server when prompted. The literal environment reference is expanded by Claude Code.', 'Paste the instruction block below into CLAUDE.md.', common] };
    case 'Codex': return { instructionBlock, namedInstructions, source: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli', rule: 'AGENTS.md',
      snippet: `[mcp_servers.agent-board]\nurl = ${JSON.stringify(mcpUrl)}\nbearer_token_env_var = "AMB_TOKEN"`, steps: ['Set AMB_TOKEN in the environment inherited by Codex before launching it. Codex reads the token from that process environment.', 'Merge this entry into ~/.codex/config.toml. Restart Codex and check that the server is enabled.', 'Paste the instruction block below into your project AGENTS.md.', common] };
    case 'Claude Desktop': return { instructionBlock, namedInstructions, source: 'https://claude.com/docs/connectors/custom/add-unlisted', rule: 'Project instructions',
      snippet: `Server URL: ${mcpUrl}\nRequest header name: Authorization\nRequest header value: Bearer <PASTE_ONE_TIME_SECRET_HERE>`, steps: ['Open Customize > Connectors > Add custom connector (Team/Enterprise owners use Organization settings > Connectors > Add > Custom > Web). Enter the server URL.', 'Choose No sign in for this fixed credential server. Under Request headers, add Authorization and enter Bearer followed by a space and the one-time secret. Finish adding and enable the connector in your chat.', 'Claude stores fixed header values encrypted in your Claude account. It cannot read local AMB_TOKEN; replace the placeholder manually in Claude, never in this website. Team/Enterprise users share this credential, so choose restricted access.', 'Remote connectors connect from Anthropic infrastructure: the configured server URL must be publicly reachable. Paste the instruction block below into your Claude project instructions.', common] };
  }
}
