import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

const eslint = new ESLint();
test.each(['src/app/example.ts', 'src/mcp/example.ts'])(
  'D-011 forbids direct database access in %s', async (filePath) => {
    for (const name of ['pg', 'pg/lib/client', 'drizzle-orm', 'drizzle-orm/pg-core', '@/db', '@/db/schema', '../../db/schema', 'src/db/client']) {
      const [result] = await eslint.lintText(`import x from '${name}';\nvoid x;`, { filePath });
      expect(result.messages.some((message) => message.ruleId === 'no-restricted-imports'), name).toBe(true);
    }
    const [dynamic] = await eslint.lintText("const x = import('pg'); void x;", { filePath });
    expect(dynamic.messages.some((message) => message.ruleId === 'no-restricted-syntax')).toBe(true);
    const [requireResult] = await eslint.lintText("const x = require('pg'); void x;", { filePath });
    expect(requireResult.messages.some((message) => message.ruleId === '@typescript-eslint/no-require-imports')).toBe(true);
    const [allowed] = await eslint.lintText("import x from '@/domain/projects'; void x;", { filePath });
    expect(allowed.errorCount).toBe(0);
  },
);
