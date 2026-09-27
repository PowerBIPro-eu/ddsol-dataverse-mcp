// Runs every *.test.mjs file in this folder with Node's built-in test runner.
// A script instead of a command-line glob, so it behaves the same in every shell
// and on every supported Node version. The tests import the compiled code in
// build/, so run `npm run build` first (or use `npm test`, which does both).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(here, name));

if (files.length === 0) {
  console.log('No unit tests found.');
  process.exit(0);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
