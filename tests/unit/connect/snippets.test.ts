import { expect, test } from 'vitest';
import { clients, clientSetup } from '../../../src/app/(app)/connect/snippets';
import { AGENT_INSTRUCTIONS } from '../../../src/mcp/instructions';
for (const client of clients) test(`${client}: configured URL, no credential, exact instructions`, () => {
  const result = clientSetup(client, 'https://board.example.test/api/mcp', 'worker.one');
  expect(result.snippet).toContain('https://board.example.test/api/mcp');
  expect(JSON.stringify(result)).not.toMatch(/amb_[0-9A-Za-z]{8}_/);
  expect(result.instructionBlock).toBe(AGENT_INSTRUCTIONS);
  expect(result.namedInstructions).toBe(`${AGENT_INSTRUCTIONS}\n\nYour configured board agent name is: worker.one`);
  expect(result.steps.join(' ')).toContain('Untested');
});
test('configuration references the environment or a Desktop placeholder', () => {
  expect(clientSetup('Cursor', 'https://board.test/api/mcp', 'a').snippet).toContain('${env:AMB_TOKEN}');
  expect(clientSetup('Claude Code', 'https://board.test/api/mcp', 'a').snippet).toContain('${AMB_TOKEN}');
  expect(clientSetup('Codex', 'https://board.test/api/mcp', 'a').snippet).toContain('bearer_token_env_var = "AMB_TOKEN"');
  expect(clientSetup('Claude Desktop', 'https://board.test/api/mcp', 'a').snippet).toContain('<PASTE_ONE_TIME_SECRET_HERE>');
});
