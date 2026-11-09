import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const backup = mkdtempSync(join(tmpdir(), 'amb-db-check-'));
cpSync('drizzle', join(backup, 'drizzle'), { recursive: true });

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(dir, { recursive: true })) {
    if (typeof name !== 'string' || name.endsWith('/')) continue;
    const path = join(dir, name);
    try {
      out.set(name, readFileSync(path, 'utf8'));
    } catch {
      // directories thrown by readFileSync are skipped
    }
  }
  return out;
}

const before = snapshot('drizzle');
const result = spawnSync('npx', ['drizzle-kit', 'generate', '--name', 'drift_check'], {
  encoding: 'utf8',
});
const after = snapshot('drizzle');
rmSync('drizzle', { recursive: true, force: true });
cpSync(join(backup, 'drizzle'), 'drizzle', { recursive: true });
rmSync(backup, { recursive: true, force: true });

const changed: string[] = [];
const names = new Set([...before.keys(), ...after.keys()]);
for (const name of names) {
  if (before.get(name) !== after.get(name)) changed.push(name);
}
if (result.status !== 0 || changed.length > 0) {
  if (result.stdout) console.error(result.stdout);
  if (result.stderr) console.error(result.stderr);
  if (changed.length > 0) console.error(`schema drift: ${changed.join(', ')}`);
  process.exit(1);
}
console.log('db:check: no schema drift');
