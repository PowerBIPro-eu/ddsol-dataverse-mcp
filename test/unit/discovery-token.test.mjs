import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { GLOBAL_DISCOVERY_RESOURCE, SignInRequiredError } from '../../build/auth/token-manager.js';
import { TokenStore } from '../../build/auth/token-store.js';
import { TEST_TENANT, fakeClock, setupTokenManager, tokenResponse } from './helpers/fake-entra.mjs';
import { makeTempDir } from './helpers/mcp-process.mjs';

const DISCOVERY_SCOPE = 'https://globaldisco.crm.dynamics.com/user_impersonation offline_access';

function discoveryTokenPath(dir) {
  return new TokenStore(dir).tokenPath(TEST_TENANT, 'client-a', GLOBAL_DISCOVERY_RESOURCE);
}

test('the Global Discovery token is written to the cache and reused by a new server process', async (t) => {
  const dir = makeTempDir();
  const clock = fakeClock();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = setupTokenManager({ dir, clock, onToken: () => tokenResponse(1) });
  await assert.rejects(first.manager.getAccessToken(GLOBAL_DISCOVERY_RESOURCE), SignInRequiredError);
  assert.equal(await first.manager.getAccessToken(GLOBAL_DISCOVERY_RESOURCE), 'access-1');

  const file = discoveryTokenPath(dir);
  assert.ok(existsSync(file));
  const key = Buffer.from(`${TEST_TENANT}:client-a:https://globaldisco.crm.dynamics.com`).toString('hex');
  assert.equal(basename(file), `dataverse-mcp-auth-${key}.json`);

  // A second TokenManager stands in for a new server process.
  const second = setupTokenManager({ dir, clock, onToken: () => { throw new Error('no HTTP call expected'); } });
  assert.equal(await second.manager.getAccessToken(GLOBAL_DISCOVERY_RESOURCE), 'access-1');
  assert.equal(second.entra.calls.length, 0);
});

test('an expired Global Discovery token is refreshed and the cache updated', async (t) => {
  const dir = makeTempDir();
  const clock = fakeClock();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(discoveryTokenPath(dir), JSON.stringify({
    access_token: 'old-discovery',
    refresh_token: 'old-discovery-refresh',
    expires_at: clock.now() - 1000
  }));

  const context = setupTokenManager({
    dir,
    clock,
    onToken: (form) => {
      assert.equal(form.grant_type, 'refresh_token');
      assert.equal(form.refresh_token, 'old-discovery-refresh');
      assert.equal(form.scope, DISCOVERY_SCOPE);
      return tokenResponse(2);
    }
  });
  assert.equal(await context.manager.getAccessToken(GLOBAL_DISCOVERY_RESOURCE), 'access-2');
  assert.equal(JSON.parse(readFileSync(discoveryTokenPath(dir), 'utf8')).refresh_token, 'refresh-2');
  assert.equal(context.entra.deviceCodeRequests(), 0);
});
