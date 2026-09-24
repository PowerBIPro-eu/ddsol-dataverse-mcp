import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { makeTempDir } from './helpers/mcp-process.mjs';

test('without an environment, Dataverse calls say so instead of starting a sign-in', async (t) => {
  const workDir = makeTempDir();
  process.chdir(workDir);
  process.env.LOCALAPPDATA = workDir;
  process.env.HOME = workDir;
  t.after(() => {
    process.chdir(process.env.TEMP || process.env.TMPDIR || '/');
    rmSync(workDir, { recursive: true, force: true });
  });

  const { DataverseClient } = await import('../../build/dataverse-client.js');
  const client = new DataverseClient({ dataverseUrl: '', clientId: 'client-a', tenantId: 'organizations', authMode: 'device' });
  await assert.rejects(client.get('accounts'), (error) => {
    assert.match(error.message, /^No Dataverse environment is selected\./);
    return true;
  });
});
