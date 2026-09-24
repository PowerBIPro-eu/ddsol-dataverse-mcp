import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  AuthUnavailableError,
  GLOBAL_DISCOVERY_RESOURCE,
  SignInRequiredError,
  parseClientInfo
} from '../../build/auth/token-manager.js';
import { TokenStore } from '../../build/auth/token-store.js';
import { TEST_TENANT, entraError, fakeClock, networkError, setupTokenManager, tokenResponse } from './helpers/fake-entra.mjs';
import { makeTempDir } from './helpers/mcp-process.mjs';

const ENV = 'https://contoso.api.crm4.dynamics.com';
const OTHER_ENV = 'https://fabrikam.api.crm.dynamics.com';

function seed(dir, resource, token) {
  const file = new TokenStore(dir).tokenPath(TEST_TENANT, 'client-a', resource);
  writeFileSync(file, JSON.stringify(token));
  return file;
}

function clientInfo(uid, utid) {
  return Buffer.from(JSON.stringify({ uid, utid })).toString('base64url');
}

function fresh(t) {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, clock: fakeClock() };
}

test('the environment list works from a cached environment sign-in (the reported incident)', async (t) => {
  const { dir, clock } = fresh(t);
  // A refreshable environment token from an earlier session, written by 0.2.43 (no account info).
  seed(dir, ENV, { access_token: 'old', refresh_token: 'rt-env', expires_at: clock.now() - 1000 });

  const context = setupTokenManager({
    dir,
    clock,
    onToken: (form) => {
      assert.equal(form.grant_type, 'refresh_token');
      assert.equal(form.refresh_token, 'rt-env');
      assert.equal(form.scope, 'https://globaldisco.crm.dynamics.com/user_impersonation offline_access');
      assert.equal(form.client_info, '1');
      return tokenResponse(7);
    }
  });
  assert.equal(await context.manager.getAccessToken(GLOBAL_DISCOVERY_RESOURCE), 'access-7');
  assert.equal(context.entra.deviceCodeRequests(), 0, 'no device sign-in may be needed');
  assert.ok(context.logs.some((line) => line.includes('with the cached sign-in of https://contoso.api.crm4.dynamics.com')));
});

test('a new environment is signed in silently with the cached Global Discovery sign-in', async (t) => {
  const { dir, clock } = fresh(t);
  seed(dir, GLOBAL_DISCOVERY_RESOURCE, { access_token: 'disco', refresh_token: 'rt-disco', expires_at: clock.now() + 3_600_000 });

  const context = setupTokenManager({
    dir,
    clock,
    onToken: (form) => {
      assert.equal(form.refresh_token, 'rt-disco');
      assert.equal(form.scope, `${ENV}/user_impersonation offline_access`);
      return tokenResponse(8);
    }
  });
  assert.equal(await context.manager.getAccessToken(ENV), 'access-8');
  assert.equal(context.entra.deviceCodeRequests(), 0);
  assert.ok(existsSync(new TokenStore(dir).tokenPath(TEST_TENANT, 'client-a', ENV)));
});

test('if Entra refuses the cached sign-in for this resource, the user gets a device code', async (t) => {
  const { dir, clock } = fresh(t);
  const discoveryFile = seed(dir, GLOBAL_DISCOVERY_RESOURCE, {
    access_token: 'disco', refresh_token: 'rt-disco', expires_at: clock.now() + 3_600_000
  });

  const context = setupTokenManager({ dir, clock, onToken: () => { throw entraError('invalid_grant', { codes: [65001] }); } });
  await assert.rejects(context.manager.getAccessToken(ENV), SignInRequiredError);
  assert.equal(context.entra.deviceCodeRequests(), 1);
  assert.ok(existsSync(discoveryFile), 'the other resource\'s sign-in must be kept');
});

test('sign-ins of two different accounts are never mixed', async (t) => {
  const { dir, clock } = fresh(t);
  seed(dir, GLOBAL_DISCOVERY_RESOURCE, {
    access_token: 'a', refresh_token: 'rt-a', expires_at: clock.now() + 3_600_000, account: { uid: 'user-1', utid: 'tenant-1' }
  });
  seed(dir, OTHER_ENV, {
    access_token: 'b', refresh_token: 'rt-b', expires_at: clock.now() + 3_600_000, account: { uid: 'user-2', utid: 'tenant-2' }
  });

  const context = setupTokenManager({ dir, clock, onToken: () => { throw new Error('must not try another account\'s token'); } });
  await assert.rejects(context.manager.getAccessToken(ENV), SignInRequiredError);
  assert.equal(context.entra.tokenRequests().length, 0);
  assert.ok(context.logs.some((line) => line.includes('sign-ins of 2 accounts are cached')));
});

test('a network failure during a silent sign-in is reported as temporary', async (t) => {
  const { dir, clock } = fresh(t);
  seed(dir, GLOBAL_DISCOVERY_RESOURCE, { access_token: 'disco', refresh_token: 'rt-disco', expires_at: clock.now() + 3_600_000 });

  const context = setupTokenManager({ dir, clock, onToken: () => { throw networkError(); } });
  await assert.rejects(context.manager.getAccessToken(ENV), AuthUnavailableError);
  assert.equal(context.entra.deviceCodeRequests(), 0);
});

test('the account identifiers from client_info are stored with the token', async (t) => {
  const { dir, clock } = fresh(t);
  const context = setupTokenManager({ dir, clock, onToken: (form) => {
    assert.equal(form.client_info, '1');
    return tokenResponse(1, { client_info: clientInfo('user-1', 'tenant-1') });
  } });
  await assert.rejects(context.manager.getAccessToken(ENV), SignInRequiredError);
  await context.manager.getAccessToken(ENV);

  const stored = JSON.parse(readFileSync(new TokenStore(dir).tokenPath(TEST_TENANT, 'client-a', ENV), 'utf8'));
  assert.deepEqual(stored.account, { uid: 'user-1', utid: 'tenant-1' });
});

test('parseClientInfo ignores anything that is not base64url JSON', () => {
  assert.deepEqual(parseClientInfo(clientInfo('u', 't')), { uid: 'u', utid: 't' });
  assert.equal(parseClientInfo('%%%'), undefined);
  assert.equal(parseClientInfo(undefined), undefined);
  assert.equal(parseClientInfo(Buffer.from('{"other":1}').toString('base64url')), undefined);
});
