import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const marker = '-- amb-custom-start';
const custom = readFileSync(new URL('../src/db/custom.sql', import.meta.url), 'utf8').trim();
const sqlFiles = readdirSync('drizzle').filter((name) => /^0000_.*\.sql$/.test(name));
if (sqlFiles.length !== 1) {
  console.error(`expected one 0000 migration, found ${sqlFiles.length}`);
  process.exit(1);
}
const path = `drizzle/${sqlFiles[0]}`;
const current = readFileSync(path, 'utf8');
if (current.includes(marker)) {
  console.log(`custom SQL already present in ${path}`);
  process.exit(0);
}
writeFileSync(path, `${current.trimEnd()}\n--> statement-breakpoint\n${custom}\n`);
console.log(`appended custom SQL to ${path}`);
