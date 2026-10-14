// A read that fails with "does not exist" right after a write is retried once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { makeTempDir } from './helpers/mcp-process.mjs';

const requests = [];
const seen = new Map();
let server;
let baseUrl;
let workDir;
let DataverseClient;
let readRetry;

before(async () => {
  server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') {
      res.writeHead(204);
      return res.end();
    }
    // "appears-late" is missing on the first read and present on the second.
    const count = (seen.get(req.url) ?? 0) + 1;
    seen.set(req.url, count);
    if (req.url.includes('appears-late') && count > 1) {
      res.writeHead(200);
      return res.end(JSON.stringify({ value: ['found'] }));
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { code: '0x80040217', message: 'Does not exist.' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  workDir = makeTempDir();
  process.chdir(workDir);
  process.env.LOCALAPPDATA = workDir;
  process.env.HOME = workDir;
  process.env.DATAVERSE_MCP_STATE_DIR = workDir;
  const { TokenStore } = await import('../../build/auth/token-store.js');
  writeFileSync(new TokenStore(workDir).tokenPath('organizations', 'client-a', baseUrl), JSON.stringify({
    access_token: 'token', refresh_token: 'refresh', expires_at: Date.now() + 3_600_000
  }));
  ({ DataverseClient, readRetry } = await import('../../build/dataverse-client.js'));
  readRetry.delayMs = 0;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  process.chdir(process.env.TEMP || process.env.TMPDIR || '/');
  rmSync(workDir, { recursive: true, force: true });
});

function newClient() {
  return new DataverseClient({ dataverseUrl: baseUrl, clientId: 'client-a', tenantId: 'organizations', authMode: 'device' });
}

test('without a recent write, "does not exist" is returned at once', async () => {
  const client = newClient();
  const before = requests.length;
  await assert.rejects(client.getMetadata('appears-late-1'), (error) => error.code === '0x80040217');
  assert.equal(requests.length - before, 1);
});

test('right after a write, the read is retried once with strong consistency', async () => {
  const client = newClient();
  await client.post('optionsets', { name: 'x' });
  const before = requests.length;
  assert.deepEqual(await client.getMetadata('appears-late-2'), { value: ['found'] });
  const reads = requests.slice(before);
  assert.equal(reads.length, 2);
  assert.equal(reads[0].headers.consistency, undefined);
  assert.equal(reads[1].headers.consistency, 'Strong');
});

test('a component that really does not exist still fails after the single retry', async () => {
  const client = newClient();
  await client.post('optionsets', { name: 'x' });
  const before = requests.length;
  await assert.rejects(client.get('never-there'), (error) => error.code === '0x80040217');
  assert.equal(requests.length - before, 2);
});
