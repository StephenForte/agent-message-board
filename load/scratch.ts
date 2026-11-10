import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Logs and the manifest live here, never in the repo. */
export function scratchDir(): string {
  const dir = process.env.AMB_TMP;
  if (!dir || !dir.startsWith('/')) throw new Error('AMB_TMP must be an absolute directory');
  const repo = resolve(process.cwd());
  const abs = resolve(dir);
  if (abs === repo || abs.startsWith(`${repo}/`)) throw new Error('AMB_TMP must be outside the repository');
  mkdirSync(abs, { recursive: true });
  return abs;
}

export function gitCommit(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

export function assertSafeIdent(value: string, label: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`unsafe ${label}`);
  return value;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
