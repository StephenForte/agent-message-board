import { describe, expect, test } from 'vitest';
import { loadEnv } from '../../src/env';

const production = {
  NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/amb',
  BETTER_AUTH_SECRET: 'a'.repeat(48), CURSOR_HMAC_SECRET: 'b'.repeat(48),
  APP_BASE_URL: 'https://example.test',
};

describe('fail-closed config', () => {
  test('accepts valid production configuration', () => {
    expect(loadEnv(production).LOG_LEVEL).toBe('info');
  });
  test.each(['DATABASE_URL', 'BETTER_AUTH_SECRET', 'CURSOR_HMAC_SECRET', 'APP_BASE_URL'])(
    'rejects missing production %s without disclosing values', (key) => {
      const source: Record<string, string | undefined> = { ...production };
      delete source[key];
      expect(() => loadEnv(source)).toThrow(key);
    },
  );
  test.each([
    ['DATABASE_URL', 'file:private'], ['DATABASE_URL', 'bad-secret-value'],
    ['BETTER_AUTH_SECRET', 'short'], ['CURSOR_HMAC_SECRET', 'short'],
    ['APP_BASE_URL', 'javascript:alert(1)'], ['APP_BASE_URL', 'http://example.test'],
    ['LOG_LEVEL', 'anything'], ['NODE_ENV', 'unknown'],
  ])('rejects invalid %s', (key, value) => {
    expect(() => loadEnv({ ...production, [key]: value })).toThrow(key);
    try { loadEnv({ ...production, [key]: value }); } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });
  test('development secrets are explicit and rejected by production', () => {
    const dev = loadEnv({ NODE_ENV: 'development', DATABASE_URL: production.DATABASE_URL });
    expect(dev.BETTER_AUTH_SECRET).toContain('obviously-dev');
    expect(() => loadEnv({ ...dev, NODE_ENV: 'production' })).toThrow('BETTER_AUTH_SECRET');
  });
  test('there is no development database fallback', () => {
    expect(() => loadEnv({ NODE_ENV: 'development' })).toThrow('DATABASE_URL');
  });
});
