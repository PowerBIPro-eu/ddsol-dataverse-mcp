// Runs a real DataverseClient against a local HTTP server that imitates the Dataverse
// Web API. A cached token is seeded, so no sign-in or network access is involved.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { makeTempDir } from './helpers/mcp-process.mjs';

const TENANT = 'organizations';
const CLIENT_ID = 'client-a';
const requests = [];
let server;
let baseUrl;
let client;
let workDir;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === 'GET' && req.url.startsWith('/api/data/v9.2/ok')) return send(res, 200, { value: [] });
      if (req.method === 'GET' && req.url.startsWith('/api/data/v9.2/unauthorized')) return send(res, 401, undefined, { 'x-ms-service-request-id': 'req-401' });
      if (req.method === 'POST' && req.url === '/api/data/v9.2/accounts') return send(res, 201, { accountid: '1' });
      if (req.method === 'PATCH') {
        return send(res, 500, {
          error: {
            code: '0x80040216',
            message: 'An unexpected error occurred.',
            '@Microsoft.PowerApps.CDS.InnerError.Message': 'The real cause.'
          }
        }, { 'x-ms-service-request-id': 'req-500' });
      }
      send(res, 404, { error: { code: '0x80060888', message: 'Resource not found.' } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  workDir = makeTempDir();
  process.chdir(workDir);
  process.env.LOCALAPPDATA = workDir;
  process.env.HOME = workDir;
  const { TokenStore } = await import('../../build/auth/token-store.js');
  writeFileSync(new TokenStore(workDir).tokenPath(TENANT, CLIENT_ID, baseUrl), JSON.stringify({
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_at: Date.now() + 3_600_000
  }));

  const { DataverseClient } = await import('../../build/dataverse-client.js');
  client = new DataverseClient({ dataverseUrl: baseUrl, clientId: CLIENT_ID, tenantId: TENANT, authMode: 'device' });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  process.chdir(process.env.TEMP || process.env.TMPDIR || '/');
  rmSync(workDir, { recursive: true, force: true });
});

test('writes ask for error details and surface the full error body', async () => {
  await assert.rejects(client.patch('savedqueries(00000000-0000-0000-0000-000000000001)', { fetchxml: '<fetch/>' }), (error) => {
    assert.deepEqual(error.message.split('\n'), [
      'Dataverse API Error: An unexpected error occurred. (Code: 0x80040216)',
      'InnerError.Message: The real cause.',
      'HTTP status: 500 Internal Server Error',
      'x-ms-service-request-id: req-500'
    ]);
    return true;
  });
  const patch = requests.find((request) => request.method === 'PATCH');
  assert.equal(patch.headers.authorization, 'Bearer test-access-token');
  assert.match(patch.headers.prefer, /^odata\.include-annotations="Microsoft\.PowerApps\.CDS\.ErrorDetails\*/);
});

test('reads are left without the error-detail preference', async () => {
  await client.get('ok');
  const get = requests.findLast((request) => request.method === 'GET');
  assert.equal(get.headers.prefer, undefined);
  assert.equal(get.headers.authorization, 'Bearer test-access-token');
});

test('an existing Prefer header such as return=representation is kept', async () => {
  const created = await client.post('accounts', { name: 'x' }, { Prefer: 'return=representation' });
  assert.deepEqual(created, { accountid: '1' });
  const post = requests.findLast((request) => request.method === 'POST');
  assert.match(post.headers.prefer, /^return=representation,odata\.include-annotations=/);
});

test('metadata calls go through the same path and error format', async () => {
  await assert.rejects(client.getMetadata("EntityDefinitions(LogicalName='missing')"), (error) => {
    assert.equal(error.message, 'Dataverse API Error: Resource not found. (Code: 0x80060888)\nHTTP status: 404 Not Found');
    assert.equal(error.code, '0x80060888');
    return true;
  });
});

test('a pasted Web API URL selects the same environment and token cache entry', async () => {
  const active = await client.setActiveEnvironment(`${baseUrl}/api/data/v9.2/`);
  assert.equal(active, baseUrl);
  await client.get('ok');
  const get = requests.findLast((request) => request.method === 'GET');
  assert.equal(get.url, '/api/data/v9.2/ok');
  assert.equal(get.headers.authorization, 'Bearer test-access-token');
});

test('an error without a Dataverse body carries no request data', async () => {
  await assert.rejects(client.get('unauthorized'), (error) => {
    assert.equal(error.message, 'Dataverse request failed with HTTP 401 Unauthorized.\nx-ms-service-request-id: req-401');
    assert.equal(error.config, undefined);
    return true;
  });
});
