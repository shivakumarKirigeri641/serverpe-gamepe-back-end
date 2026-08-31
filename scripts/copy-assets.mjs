/**
 * Copies the non-TypeScript files the build needs into dist/.
 *
 * `tsc` emits only JavaScript, but the server reads its migrations from a path
 * relative to its own module — dist/db/migrations at runtime. Without this step
 * that folder is empty, so `node dist/index.js` starts, finds nothing to apply,
 * logs nothing, and then serves traffic against an unmigrated database. It is a
 * silent failure in production and a working one in development, because `npm
 * run dev` runs from src/ where the .sql files live.
 */

import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const from = join(root, 'src', 'db', 'migrations');
const to = join(root, 'dist', 'db', 'migrations');

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });

const copied = (await readdir(to)).filter((f) => f.endsWith('.sql'));
console.log(`copied ${copied.length} migrations into dist/db/migrations`);

if (copied.length !== (await readdir(from)).filter((f) => f.endsWith('.sql')).length) {
  console.error('migration count does not match src/db/migrations');
  process.exit(1);
}
