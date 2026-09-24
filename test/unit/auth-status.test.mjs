import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { GLOBAL_DISCOVERY_RESOURCE, SignInRequiredError } from '../../build/auth/token-manager.js';
import { TokenStore } from '../../build/auth/token-store.js';
import { TEST_TENANT, entraError, fakeClock, setupTokenManager } from './helpers/fake-entra.mjs';
import { makeTempDir, startServer } from './helpers/mcp-process.mjs';

const ENV = 'https://contoso.api.crm4.dynamics.com';

test('getStatus reports tokens, pending sign-ins and errors without any secret', async (t) => {
  const dir = makeTempDir();
  const clock = fakeClock();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(new TokenStore(dir).tokenPath(TEST_TENANT, 'client-a', GLOBAL_DISCOVERY_RESOURCE), JSON.stringify({
    access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH', expires_at: clock.now() + 3_600_000,
    account: { uid: 'user-1', utid: 'tenant-1' }
  }));

  let polls = 0;
  const context = setupTokenManager({
    dir,
    clock,
    onToken: (form) => {
      if (form.grant_type === 'refresh_token') throw entraError('invalid_grant', { codes: [65001] });
      polls++;
      throw entraError('authorization_pending');
    }
  });
  await assert.rejects(context.manager.getAccessToken(ENV), SignInRequiredError);
  await assert.rejects(context.manager.getAccessToken(ENV), SignInRequiredError);
  assert.ok(polls > 0);

  const status = context.manager.getStatus();
  assert.equal(status.tenantId, TEST_TENANT);
  assert.equal(status.clientId, 'client-a');
  assert.deepEqual(status.tokens.map((entry) => entry.resource), [GLOBAL_DISCOVERY_RESOURCE]);
  assert.equal(status.tokens[0].accessTokenValid, true);
  assert.equal(status.tokens[0].hasRefreshToken, true);
  assert.deepEqual(status.tokens[0].account, { uid: 'user-1', utid: 'tenant-1' });
  assert.equal(status.pendingSignIns.length, 1);
  assert.equal(status.pendingSignIns[0].resource, ENV);
  assert.equal(status.pendingSignIns[0].userCode, 'USERCODE1');
  assert.equal(status.pendingSignIns[0].lastResult, 'authorization_pending');

  const text = JSON.stringify(status);
  for (const secret of ['SECRET-ACCESS', 'SECRET-REFRESH', 'device-code-1']) {
    assert.ok(!text.includes(secret), `${secret} must not appear in the status`);
  }
});

test('get_dataverse_auth_status answers without starting a sign-in', async (t) => {
  const home = makeTempDir('dvmcp-home-');
  const cwd = makeTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  // The server under test uses tenant "organizations" and the all-zero client ID.
  writeFileSync(new TokenStore(home).tokenPath('organizations', '00000000-0000-0000-0000-000000000000', ENV), JSON.stringify({
    access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH', expires_at: Date.now() + 3_600_000
  }));

  const server = startServer({ cwd, home });
  try {
    await server.initialize();
    const result = await server.callTool('get_dataverse_auth_status');
    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.match(text, /^Dataverse sign-in status:\n\n/);
    const status = JSON.parse(text.slice(text.indexOf('{')));
    assert.deepEqual(status.tokens.map((entry) => entry.resource), [ENV]);
    assert.deepEqual(status.pendingSignIns, []);
    assert.ok(!text.includes('SECRET-'));
  } finally {
    await server.close();
  }
});
