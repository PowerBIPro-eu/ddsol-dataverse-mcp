import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, startServer } from './helpers/mcp-process.mjs';

test('stdout carries only JSON-RPC frames while the server logs diagnostics', async () => {
  const cwd = makeTempDir();
  writeFileSync(
    join(cwd, '.dataverse-mcp'),
    JSON.stringify({ solutionUniqueName: 'contosocore', solutionDisplayName: 'Contoso Core', customizationPrefix: 'cnt' })
  );
  const server = startServer({ cwd });
  try {
    await server.initialize();
    // Loading .dataverse-mcp at startup logs a diagnostic line (it used to go to stdout).
    await server.callTool('get_solution_context');
    await server.callTool('get_active_dataverse_environment');

    assert.ok(server.stdoutLines.length >= 3, 'expected at least three responses on stdout');
    for (const line of server.stdoutLines) {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0', `not a JSON-RPC frame: ${line}`);
    }
    assert.match(server.stderr, /Loaded solution context/);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
