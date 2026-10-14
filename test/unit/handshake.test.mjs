import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, repoRoot, startServer } from './helpers/mcp-process.mjs';

test('the MCP handshake reports the package name and version from package.json', async () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const cwd = makeTempDir();
  const server = startServer({ cwd });
  try {
    const response = await server.initialize();
    assert.deepEqual(response.result.serverInfo, { name: packageJson.name, version: packageJson.version });
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
