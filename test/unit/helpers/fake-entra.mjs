// A scripted stand-in for Microsoft Entra ID and a controllable clock, for testing
// the token manager without network access.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthHttpError } from '../../../build/auth/entra-http.js';
import { TokenManager } from '../../../build/auth/token-manager.js';

export const TEST_TENANT = 'organizations';

/** A TokenManager wired to a fake Entra, a fake clock and a temporary cache directory. */
export function setupTokenManager({
  onToken,
  clientId = 'client-a',
  dir = mkdtempSync(join(tmpdir(), 'dvmcp-cache-')),
  clock = fakeClock()
} = {}) {
  const entra = fakeEntra({ onToken });
  const logs = [];
  const opened = [];
  const manager = new TokenManager({
    tenantId: TEST_TENANT,
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

export function entraError(error, { status = 400, codes = [], description } = {}) {
  return new AuthHttpError(`Test token endpoint returned ${error} (HTTP ${status}).`, 'Test token endpoint', {
    status,
    transient: status >= 500,
    timedOut: false,
    entra: {
      error,
      error_description: description ?? `AADSTS${codes[0] ?? 0}: test description`,
      error_codes: codes,
      correlation_id: 'corr-1',
      trace_id: 'trace-1',
      timestamp: '2026-09-24 10:00:00Z'
    }
  });
}

export function networkError() {
  return new AuthHttpError('Could not reach Test token endpoint (ECONNRESET: socket hang up).', 'Test token endpoint', {
    transient: true,
    timedOut: false
  });
}

export function tokenResponse(n, extra = {}) {
  return {
    token_type: 'Bearer',
    access_token: `access-${n}`,
    refresh_token: `refresh-${n}`,
    expires_in: 3600,
    scope: 'test',
    ...extra
  };
}

/** Device-code requests get numbered codes; token requests are answered by onToken(form). */
export function fakeEntra({ onToken = () => { throw new Error('unexpected token request'); } } = {}) {
  const calls = [];
  let issued = 0;
  return {
    calls,
    http: {
      async postForm(url, form, endpoint) {
        calls.push({ url, form: { ...form }, endpoint });
        if (url.endsWith('/devicecode')) {
          issued++;
          return {
            device_code: `device-code-${issued}`,
            user_code: `USERCODE${issued}`,
            verification_uri: 'https://login.microsoft.com/device',
            expires_in: 900,
            interval: 5,
            message: 'test'
          };
        }
        return onToken(form, calls);
      }
    },
    deviceCodeRequests() {
      return calls.filter((call) => call.url.endsWith('/devicecode')).length;
    },
    tokenRequests(grantType) {
      return calls.filter((call) => call.url.endsWith('/token') && (!grantType || call.form.grant_type === grantType));
    }
  };
}

export function fakeClock(start = Date.UTC(2026, 8, 24, 10, 0, 0)) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    advance(ms) {
      now += ms;
    }
  };
}
