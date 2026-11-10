import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dropLoadDatabase } from './database';
import { scratchDir } from './scratch';
import type { LoadManifest } from './types';

async function main(): Promise<void> {
  const manifestPath = process.argv[2] ?? join(scratchDir(), 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as LoadManifest;
  await dropLoadDatabase(manifest);
  rmSync(manifestPath, { force: true });
  console.log(JSON.stringify({ phase: 'dropped', databaseName: manifest.databaseName, roleName: manifest.roleName }));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'drop failed';
    console.error(message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]'));
    process.exit(1);
  });
}
