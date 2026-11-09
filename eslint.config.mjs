import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ['src/app/**/*.{ts,tsx,js,jsx}', 'src/mcp/**/*.{ts,tsx,js,jsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '(^pg($|/)|^drizzle-orm($|/)|(^|/)db($|/))',
          message: 'D-011: adapters call the domain layer; database imports are forbidden.',
        }],
      }],
      '@typescript-eslint/no-require-imports': 'error',
      'no-restricted-syntax': ['error', {
        selector: 'ImportExpression',
        message: 'D-011: use static imports in adapters so database boundaries can be checked.',
      }],
    },
  },
  globalIgnores(['.next/**', 'coverage/**', 'playwright-report/**', 'test-results/**']),
]);
