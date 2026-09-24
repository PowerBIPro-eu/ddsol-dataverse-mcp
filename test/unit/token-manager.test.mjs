import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AuthUnavailableError,
  SignInFailedError,
  SignInRequiredError,
  TokenManager,
  classifyPollError
} from '../../build/auth/token-manager.js';
import { TokenStore } from '../../build/auth/token-store.js';
import { entraError, fakeClock, fakeEntra, networkError, tokenResponse } from './helpers/fake-entra.mjs';
import { makeTempDir } from './helpers/mcp-process.mjs';

const TENANT = 'organizations';
const ENV = 'https://contoso.api.crm4.dynamics.com';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function setup({ onToken, clientId = 'client-a', dir = makeTempDir(), clock = fakeClock() } = {}) {
  const entra = fakeEntra({ onToken });
  const logs = [];
  const opened = [];
  const manager = new TokenManager({
    tenantId: TENANT,
    clientId,
    authMode: 'device',
    cacheDir: dir,
    http: entra.http,
    now: clock.now,
    sleep: clock.sleep,
    log: (line) => logs.push(line),
    onNewDeviceCode: (uri, code) => opened.push({ uri, code })
  });
  return { dir, clock, entra, logs, opened, manager };
}

function pendingFiles(dir) {
  return readdirSync(dir).filter((name) => name.startsWith('dataverse-mcp-pending-'));
}

function readPending(dir) {
  const [name] = pendingFiles(dir);
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}

function tokenPath(dir, clientId = 'client-a', resource = ENV) {
  return new TokenStore(dir).tokenPath(TENANT, clientId, resource);
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected a rejection');
}

// Issues a device code (first call) so the next call polls it.
async function withPendingCode(context) {
  const error = await rejectionOf(context.manager.getAccessToken(ENV));
  assert.ok(error instanceof SignInRequiredError);
  return error;
}

test('the first call issues a device code and returns the familiar prompt', async (t) => {
  const context = setup();
  t.after(() => rmSync(context.dir, { recursive: true, force: true }));
  const error = await withPendingCode(context);

  assert.equal(
    error.message,
    'Sign-in required to continue.\n\nOpen this URL: https://login.microsoft.com/device\nEnter code: USERCODE1\n\n' +
      '(A browser window was opened automatically and the code was copied to your clipboard.)\n\n' +
      'Run this tool again after completing sign-in.'
  );
  const pending = readPending(context.dir);
  assert.equal(pending.tenantId, TENANT);
  assert.equal(pending.clientId, 'client-a');
  assert.equal(pending.scope, `${ENV}/user_impersonation offline_access`);
  assert.deepEqual(context.opened, [{ uri: 'https://login.microsoft.com/device', code: 'USERCODE1' }]);
  assert.equal(context.entra.tokenRequests().length, 0);
});

test('authorization_pending keeps the same code and reports the last check', async (t) => {
  const context = setup({ onToken: () => { throw entraError('authorization_pending'); } });
  t.after(() => rmSync(context.dir, { recursive: true, force: true }));
  await withPendingCode(context);

  const error = await rejectionOf(context.manager.getAccessToken(ENV));
  assert.ok(error instanceof SignInRequiredError);
  assert.match(error.message, /^Sign-in required to continue\.\n/);
  assert.match(error.message, /Enter code: USERCODE1\n/);
  assert.match(error.message, /\(The code is valid until 10:15 UTC\.\)/);
  assert.match(error.message, /Last check at 10:00:20 UTC: .*\(authorization_pending\)/);
  // One call keeps polling for 20 seconds at the 5-second interval before giving up.
  assert.equal(context.entra.tokenRequests(DEVICE_GRANT).length, 5);
  assert.equal(context.entra.deviceCodeRequests(), 1);
  assert.equal(pendingFiles(context.dir).length, 1);
  assert.equal(context.logs.filter((line) => line.endsWith(': pending')).length, 5);
});

test('slow_down adds five seconds to the stored polling interval', async (t) => {
  let polls = 0;
  const context = setup({
    onToken: () => {
      polls++;
      throw entraError(polls === 1 ? 'slow_down' : 'authorization_pending');
    }
  });
  t.after(() => rmSync(context.dir, { recursive: true, force: true }));
  await withPendingCode(context);

  const error = await rejectionOf(context.manager.getAccessToken(ENV));
  assert.ok(error instanceof SignInRequiredError);
  assert.equal(readPending(context.dir).interval, 10_000);
  assert.equal(context.entra.tokenRequests(DEVICE_GRANT).length, 3);
  assert.ok(context.logs.some((line) => line.includes('slow_down, interval now 10 s')));
});

for (const [code, note] of [
  ['expired_token', /previous sign-in code expired before the sign-in was completed/],
  ['bad_verification_code', /no longer recognised the stored sign-in session \(bad_verification_code\)/]
]) {
  test(`${code} discards the code and issues a new one`, async (t) => {
    const context = setup({ onToken: () => { throw entraError(code); } });
    t.after(() => rmSync(context.dir, { recursive: true, force: true }));
    await withPendingCode(context);

    const error = await rejectionOf(context.manager.getAccessToken(ENV));
    assert.ok(error instanceof SignInRequiredError);
    assert.match(error.message, /^Sign-in required to continue\.\n/);
    assert.match(error.message, note);
    assert.match(error.message, /Enter code: USERCODE2\n/);
    assert.equal(context.entra.deviceCodeRequests(), 2);
    assert.equal(readPending(context.dir).device_code, 'device-code-2');
  });
}

test('invalid_grant ends the sign-in with the Entra details and deletes the pending file', async (t) => {
  const context = setup({
    onToken: () => {
      throw entraError('invalid_grant', {
        codes: [53003],
        description: 'AADSTS53003: Access has been blocked by Conditional Access policies.'
      });
    }
  });
  t.after(() => rmSync(context.dir, { recursive: true, force: true }));
  await withPendingCode(context);

  const error = await rejectionOf(context.manager.getAccessToken(ENV));
  assert.ok(error instanceof SignInFailedError);
  assert.match(error.message, /^Sign-in failed: Microsoft Entra did not issue a token for https:\/\/contoso/);
  for (const line of [
    'error: invalid_grant',
    'error_description: AADSTS53003: Access has been blocked by Conditional Access policies.',
    'error_codes: 53003',
    'correlation_id: corr-1',
    'trace_id: trace-1',
    'timestamp: 2026-09-24 10:00:00Z'
  ]) {
    assert.ok(error.message.includes(line), `missing "${line}"`);
  }
  assert.equal(pendingFiles(context.dir).length, 0);
  assert.ok(context.logs.some((line) => line.includes('error=invalid_grant') && line.includes('correlation_id=corr-1')));
});

test('a network error keeps the code and reports the transport problem', async (t) => {
  const context = setup({ onToken: () => { throw networkError(); } });
  t.after(() => rmSync(context.dir, { recursive: true, force: true }));
  await withPendingCode(context);

  const error = await rejectionOf(context.manager.getAccessToken(ENV));
  assert.ok(error instanceof AuthUnavailableError);
  assert.match(error.message, /ECONNRESET/);
  assert.match(error.message, /USERCODE1 stays valid until 10:15 UTC/);
  assert.equal(pendingFiles(context.dir).length, 1);
});

test('a successful poll caches the token and deletes the pending file', async (t) => {
  const context = setup({ onToken: () => tokenResponse(1) });
  t.after(() => rmSync(context.dir, { recursive: true, force: true }));
  await withPendingCode(context);

  assert.equal(await context.manager.getAccessToken(ENV), 'access-1');
  assert.equal(pendingFiles(context.dir).length, 0);
  const cached = JSON.parse(readFileSync(tokenPath(context.dir), 'utf8'));
  assert.equal(cached.refresh_token, 'refresh-1');
  assert.ok(context.logs.some((line) => line.endsWith('token acquired')));

  const requestsBefore = context.entra.calls.length;
  assert.equal(await context.manager.getAccessToken(ENV), 'access-1');
  assert.equal(context.entra.calls.length, requestsBefore, 'a cached token must not trigger HTTP calls');
});

test('parallel calls share one device code', async (t) => {
  const context = setup();
  t.after(() => rmSync(context.dir, { recursive: true, force: true }));
  const results = await Promise.allSettled([
    context.manager.getAccessToken(ENV),
    context.manager.getAccessToken(ENV),
    context.manager.getAccessToken(ENV)
  ]);
  assert.equal(context.entra.deviceCodeRequests(), 1);
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason instanceof SignInRequiredError));
  assert.equal(new Set(results.map((result) => result.reason.message)).size, 1);
});

test('servers with different client IDs never share a pending sign-in', async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = setup({ dir, clientId: 'client-a', onToken: () => { throw entraError('authorization_pending'); } });
  const second = setup({ dir, clientId: 'client-b', onToken: () => { throw entraError('authorization_pending'); } });
  await withPendingCode(first);
  await withPendingCode(second);
  await rejectionOf(second.manager.getAccessToken(ENV));

  assert.equal(pendingFiles(dir).length, 2);
  assert.ok(second.entra.tokenRequests(DEVICE_GRANT).every((call) => call.form.client_id === 'client-b'));
  assert.equal(second.entra.deviceCodeRequests(), 1, 'client-b must request its own code, not reuse client-a\'s');
});

test('a code redeemed by another process a moment ago is picked up instead of failing', async (t) => {
  let context;
  context = setup({
    onToken: () => {
      writeFileSync(tokenPath(context.dir), JSON.stringify({
        access_token: 'from-other-process',
        refresh_token: 'refresh-other',
        expires_at: context.clock.now() + 3_600_000
      }));
      throw entraError('invalid_grant', { codes: [70000] });
    }
  });
  t.after(() => rmSync(context.dir, { recursive: true, force: true }));
  await withPendingCode(context);

  assert.equal(await context.manager.getAccessToken(ENV), 'from-other-process');
  assert.equal(pendingFiles(context.dir).length, 0);
});

test('a code that expired locally is replaced without polling it', async (t) => {
  const context = setup({ onToken: () => { throw new Error('must not poll an expired code'); } });
  t.after(() => rmSync(context.dir, { recursive: true, force: true }));
  await withPendingCode(context);
  context.clock.advance(16 * 60 * 1000);

  const error = await rejectionOf(context.manager.getAccessToken(ENV));
  assert.ok(error instanceof SignInRequiredError);
  assert.match(error.message, /The previous sign-in code expired, so a new code was issued\./);
  assert.match(error.message, /Enter code: USERCODE2\n/);
  assert.equal(context.entra.tokenRequests().length, 0);
});

function seedExpiredToken(context) {
  writeFileSync(tokenPath(context.dir), JSON.stringify({
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: context.clock.now() - 1000
  }));
}

test('refresh: a network failure keeps the cached sign-in and starts no device flow', async (t) => {
  const context = setup({ onToken: () => { throw networkError(); } });
  t.after(() => rmSync(context.dir, { recursive: true, force: true }));
  seedExpiredToken(context);

  const error = await rejectionOf(context.manager.getAccessToken(ENV));
  assert.ok(error instanceof AuthUnavailableError);
  assert.match(error.message, /The cached sign-in was kept/);
  assert.ok(existsSync(tokenPath(context.dir)));
  assert.equal(context.entra.deviceCodeRequests(), 0);
});

test('refresh: a rejected refresh token starts a new sign-in and says why', async (t) => {
  const context = setup({ onToken: () => { throw entraError('invalid_grant', { codes: [700082] }); } });
  t.after(() => rmSync(context.dir, { recursive: true, force: true }));
  seedExpiredToken(context);

  const error = await rejectionOf(context.manager.getAccessToken(ENV));
  assert.ok(error instanceof SignInRequiredError);
  assert.match(error.message, /The cached sign-in could not be renewed \(invalid_grant, AADSTS700082\)\./);
  assert.ok(!existsSync(tokenPath(context.dir)));
  assert.equal(context.entra.deviceCodeRequests(), 1);
});

test('refresh: success rewrites the cache with the new refresh token', async (t) => {
  const context = setup({ onToken: (form) => {
    assert.equal(form.refresh_token, 'old-refresh');
    return tokenResponse(2);
  } });
  t.after(() => rmSync(context.dir, { recursive: true, force: true }));
  seedExpiredToken(context);

  assert.equal(await context.manager.getAccessToken(ENV), 'access-2');
  assert.equal(JSON.parse(readFileSync(tokenPath(context.dir), 'utf8')).refresh_token, 'refresh-2');
});

test('logs never contain codes or tokens', async (t) => {
  let polls = 0;
  const context = setup({ onToken: () => (++polls < 2 ? (() => { throw entraError('authorization_pending'); })() : tokenResponse(1)) });
  t.after(() => rmSync(context.dir, { recursive: true, force: true }));
  await withPendingCode(context);
  await context.manager.getAccessToken(ENV);

  const allLogs = context.logs.join('\n');
  for (const secret of ['device-code-1', 'USERCODE1', 'access-1', 'refresh-1']) {
    assert.ok(!allLogs.includes(secret), `${secret} appeared in the log`);
  }
});

test('classifyPollError treats only authorization_pending and slow_down as waiting', () => {
  assert.equal(classifyPollError(entraError('authorization_pending')), 'pending');
  assert.equal(classifyPollError(entraError('slow_down')), 'slow_down');
  assert.equal(classifyPollError(entraError('expired_token')), 'restart');
  assert.equal(classifyPollError(entraError('bad_verification_code')), 'restart');
  assert.equal(classifyPollError(entraError('authorization_declined')), 'declined');
  assert.equal(classifyPollError(entraError('invalid_grant')), 'fatal');
  assert.equal(classifyPollError(entraError('invalid_client', { status: 401 })), 'fatal');
  assert.equal(classifyPollError(entraError('server_error', { status: 503 })), 'transient');
  assert.equal(classifyPollError(networkError()), 'transient');
  assert.equal(classifyPollError(new Error('bug')), 'fatal');
});
