import { AuthHttpError, formatEntraFields, formatEntraFieldsInline, postForm } from './entra-http.js';
import { CachedToken, PendingDeviceCode, TokenStore, defaultTokenCacheDir } from './token-store.js';

// Acquires and caches OAuth tokens for Dataverse environments and the Global
// Discovery Service: cached token, then refresh token, then device-code sign-in.

export const GLOBAL_DISCOVERY_RESOURCE = 'https://globaldisco.crm.dynamics.com';

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** The user has to complete a device-code sign-in; the message says how. */
export class SignInRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInRequiredError';
  }
}

/** Microsoft Entra refused to issue a token; the message carries its error details. */
export class SignInFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInFailedError';
  }
}

/** Microsoft Entra could not be reached. Nothing was discarded, so a later retry can succeed. */
export class AuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthUnavailableError';
  }
}

export interface AuthHttp {
  postForm(url: string, form: Record<string, string>, endpoint: string): Promise<any>;
}

export interface TokenManagerOptions {
  tenantId: string;
  clientId: string;
  clientSecret?: string;
  authMode: 'client_secret' | 'device';
  cacheDir?: string;
  http?: AuthHttp;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Called when a new device code is issued, e.g. to open the browser. */
  onNewDeviceCode?: (verificationUri: string, userCode: string) => void;
  /** How long one call keeps polling a pending sign-in before reporting it as still pending. */
  pollWindowMs?: number;
}

export type PollOutcome = 'pending' | 'slow_down' | 'restart' | 'declined' | 'transient' | 'fatal';

/**
 * Classifies a failed device-code poll. Only authorization_pending and slow_down mean
 * "keep waiting"; everything else must end or restart the sign-in (RFC 8628 §3.5).
 */
export function classifyPollError(error: unknown): PollOutcome {
  if (!(error instanceof AuthHttpError)) {
    return 'fatal';
  }
  switch (error.entra?.error) {
    case 'authorization_pending':
      return 'pending';
    case 'slow_down':
      return 'slow_down';
    case 'expired_token':
    case 'bad_verification_code':
      return 'restart';
    case 'authorization_declined':
    case 'access_denied':
      return 'declined';
    default:
      return error.transient ? 'transient' : 'fatal';
  }
}

export type RefreshOutcome = 'transient' | 'configuration' | 'rejected';

/** Classifies a failed refresh: only a rejection by Entra justifies discarding the cached sign-in. */
export function classifyRefreshError(error: unknown): RefreshOutcome {
  if (!(error instanceof AuthHttpError) || error.transient) {
    return 'transient';
  }
  const code = error.entra?.error;
  return code === 'invalid_client' || code === 'unauthorized_client' ? 'configuration' : 'rejected';
}

function resourceLabel(resource: string): string {
  return resource === GLOBAL_DISCOVERY_RESOURCE ? 'the Global Discovery Service (listing environments)' : resource;
}

function delegatedScope(resource: string): string {
  return `${resource.replace(/\/+$/, '')}/user_impersonation offline_access`;
}

function utcTime(epochMs: number, withSeconds = false): string {
  return new Date(epochMs).toISOString().slice(11, withSeconds ? 19 : 16);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function entraSummary(error: unknown): string {
  if (error instanceof AuthHttpError && error.entra?.error) {
    const code = error.entra.error_codes?.[0];
    return code ? `${error.entra.error}, AADSTS${code}` : error.entra.error;
  }
  return errorMessage(error);
}

function detailLines(error: unknown): string {
  return error instanceof AuthHttpError && error.entra ? formatEntraFields(error.entra) : errorMessage(error);
}

function detailInline(error: unknown): string {
  return error instanceof AuthHttpError && error.entra ? formatEntraFieldsInline(error.entra) : errorMessage(error);
}

function describeOutcome(outcome: string): string {
  switch (outcome) {
    case 'authorization_pending':
      return 'Microsoft Entra has not seen a completed sign-in for this code yet (authorization_pending).';
    case 'slow_down':
      return 'Microsoft Entra asked for slower polling (slow_down).';
    default:
      return outcome;
  }
}

export class TokenManager {
  private readonly store: TokenStore;
  private readonly http: AuthHttp;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly pollWindowMs: number;
  private readonly memory = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<CachedToken>>();

  constructor(private readonly options: TokenManagerOptions) {
    this.store = new TokenStore(options.cacheDir ?? defaultTokenCacheDir());
    this.http = options.http ?? { postForm };
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? ((line) => console.error(`[dataverse-mcp] ${line}`));
    this.pollWindowMs = options.pollWindowMs ?? 20_000;
  }

  /** Returns a valid access token for an environment URL or GLOBAL_DISCOVERY_RESOURCE. */
  async getAccessToken(resource: string): Promise<string> {
    return (await this.getToken(resource)).access_token;
  }

  getToken(resource: string): Promise<CachedToken> {
    // Parallel tool calls share one acquisition, so they never request two device
    // codes or poll the same code twice.
    const running = this.inflight.get(resource);
    if (running) {
      return running;
    }
    const acquisition = this.acquire(resource).finally(() => this.inflight.delete(resource));
    this.inflight.set(resource, acquisition);
    return acquisition;
  }

  private get tokenEndpointUrl(): string {
    return `https://login.microsoftonline.com/${this.options.tenantId}/oauth2/v2.0/token`;
  }

  private get tokenEndpointLabel(): string {
    return `Microsoft Entra token endpoint (${this.tokenEndpointUrl})`;
  }

  private async acquire(resource: string): Promise<CachedToken> {
    const memoryToken = this.memory.get(resource);
    if (this.isUsable(memoryToken)) {
      return memoryToken!;
    }

    // Another server process, or this one before a restart, may have refreshed the
    // token since it was last read.
    const storedToken = this.readStoredToken(resource);
    if (this.isUsable(storedToken)) {
      this.memory.set(resource, storedToken!);
      return storedToken!;
    }

    if (this.options.authMode === 'client_secret' && resource !== GLOBAL_DISCOVERY_RESOURCE) {
      return this.acquireWithClientSecret(resource);
    }

    const scope = delegatedScope(resource);
    const refreshable = [memoryToken, storedToken]
      .filter((token): token is CachedToken => !!token?.refresh_token)
      .sort((a, b) => b.expires_at - a.expires_at)[0];
    const notes: string[] = [];

    if (refreshable) {
      try {
        const token = await this.redeemRefreshToken(refreshable.refresh_token!, scope);
        this.storeToken(resource, token);
        this.log(`auth: refreshed the sign-in for ${resourceLabel(resource)}`);
        return token;
      } catch (error) {
        const outcome = classifyRefreshError(error);
        if (outcome === 'transient') {
          this.log(`auth: refresh for ${resourceLabel(resource)} failed temporarily: ${detailInline(error)}`);
          throw new AuthUnavailableError(
            `Could not refresh the Dataverse sign-in for ${resourceLabel(resource)}: ${errorMessage(error)}\n` +
            'The cached sign-in was kept; run the tool again once Microsoft Entra is reachable.'
          );
        }
        if (outcome === 'configuration') {
          this.log(`auth: refresh for ${resourceLabel(resource)} rejected the app configuration: ${detailInline(error)}`);
          throw new SignInFailedError(
            `Sign-in failed: Microsoft Entra rejected the app configuration for ${resourceLabel(resource)}.\n` +
            `${detailLines(error)}\n` +
            'Check DATAVERSE_CLIENT_ID and DATAVERSE_TENANT_ID, and that the app registration allows public client flows.'
          );
        }
        this.log(`auth: cached sign-in for ${resourceLabel(resource)} was rejected: ${detailInline(error)}`);
        this.forgetToken(resource);
        notes.push(`The cached sign-in could not be renewed (${entraSummary(error)}).`);
      }
    }

    return this.signInWithDeviceCode(resource, scope, notes);
  }

  // Expired tokens fail this check but can still hold a usable refresh token.
  private isUsable(token: CachedToken | null | undefined): boolean {
    return !!token && typeof token.access_token === 'string' && this.now() < token.expires_at;
  }

  // The Global Discovery token is cached exactly like environment tokens, under
  // hex(tenant:clientId:https://globaldisco.crm.dynamics.com), so a new server process
  // can list environments without a new sign-in.
  private tokenPath(resource: string): string {
    return this.store.tokenPath(this.options.tenantId, this.options.clientId, resource);
  }

  private readStoredToken(resource: string): CachedToken | null {
    return this.store.readToken(this.tokenPath(resource));
  }

  private storeToken(resource: string, token: CachedToken): void {
    this.memory.set(resource, token);
    try {
      this.store.writeToken(this.tokenPath(resource), token);
    } catch (error: any) {
      this.log(`auth: could not save the token cache for ${resourceLabel(resource)} (${error?.code ?? 'unknown error'})`);
    }
  }

  private forgetToken(resource: string): void {
    this.memory.delete(resource);
    this.store.remove(this.tokenPath(resource));
  }

  private toCachedToken(data: any, previousRefreshToken?: string): CachedToken {
    if (!data || typeof data.access_token !== 'string') {
      throw new Error('Microsoft Entra returned a response without an access token.');
    }
    const expiresIn = Number(data.expires_in) || 3600;
    return {
      access_token: data.access_token,
      token_type: data.token_type,
      expires_in: expiresIn,
      expires_at: this.now() + expiresIn * 1000 - 60_000,
      refresh_token: data.refresh_token ?? previousRefreshToken,
      scope: data.scope
    };
  }

  private async redeemRefreshToken(refreshToken: string, scope: string): Promise<CachedToken> {
    const data = await this.http.postForm(this.tokenEndpointUrl, {
      grant_type: 'refresh_token',
      client_id: this.options.clientId,
      refresh_token: refreshToken,
      scope
    }, this.tokenEndpointLabel);
    return this.toCachedToken(data, refreshToken);
  }

  private async acquireWithClientSecret(resource: string): Promise<CachedToken> {
    try {
      const data = await this.http.postForm(this.tokenEndpointUrl, {
        grant_type: 'client_credentials',
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret ?? '',
        scope: `${resource.replace(/\/+$/, '')}/.default`
      }, this.tokenEndpointLabel);
      const token = this.toCachedToken(data);
      this.storeToken(resource, token);
      return token;
    } catch (error) {
      if (error instanceof AuthHttpError && error.transient) {
        throw new AuthUnavailableError(`Authentication failed: ${error.message}`);
      }
      throw new SignInFailedError(`Authentication failed: Microsoft Entra rejected the client credentials for ${resource}.\n${detailLines(error)}`);
    }
  }

  private async signInWithDeviceCode(resource: string, scope: string, notes: string[]): Promise<CachedToken> {
    const pendingFile = this.store.pendingPath(this.options.tenantId, this.options.clientId, scope);
    let pending = this.store.readPending(pendingFile);
    if (pending && !this.isSameSignIn(pending, scope)) {
      pending = null;
    }
    if (pending && this.now() >= pending.expires_at) {
      this.store.remove(pendingFile);
      pending = null;
      notes.push('The previous sign-in code expired, so a new code was issued.');
    }
    if (!pending) {
      const fresh = await this.startDeviceCode(resource, scope, pendingFile);
      throw new SignInRequiredError(this.signInMessage(fresh, notes, true));
    }
    return this.pollPendingSignIn(resource, pending, pendingFile);
  }

  private isSameSignIn(pending: PendingDeviceCode, scope: string): boolean {
    return pending.tenantId === this.options.tenantId && pending.clientId === this.options.clientId && pending.scope === scope;
  }

  private async startDeviceCode(resource: string, scope: string, pendingFile: string): Promise<PendingDeviceCode> {
    const url = `https://login.microsoftonline.com/${this.options.tenantId}/oauth2/v2.0/devicecode`;
    let data: any;
    try {
      data = await this.http.postForm(url, { client_id: this.options.clientId, scope }, `Microsoft Entra device-code endpoint (${url})`);
    } catch (error) {
      this.log(`auth: could not start a sign-in for ${resourceLabel(resource)}: ${detailInline(error)}`);
      if (error instanceof AuthHttpError && error.entra && !error.transient) {
        throw new SignInFailedError(
          `Sign-in failed: Microsoft Entra refused to start a sign-in for ${resourceLabel(resource)}.\n${detailLines(error)}`
        );
      }
      throw new AuthUnavailableError(`Could not start the sign-in for ${resourceLabel(resource)}: ${errorMessage(error)}`);
    }

    const issuedAt = this.now();
    const pending: PendingDeviceCode = {
      tenantId: this.options.tenantId,
      clientId: this.options.clientId,
      scope,
      resource,
      device_code: String(data.device_code),
      user_code: String(data.user_code),
      verification_uri: String(data.verification_uri),
      expires_at: issuedAt + (Number(data.expires_in) || 900) * 1000,
      interval: Math.max(Number(data.interval) || 5, 5) * 1000,
      lastPollAt: 0
    };
    this.store.writePending(pendingFile, pending);
    this.log(`auth: new sign-in code issued for ${resourceLabel(resource)}, valid until ${utcTime(pending.expires_at)} UTC`);
    try {
      this.options.onNewDeviceCode?.(pending.verification_uri, pending.user_code);
    } catch {
      // Opening a browser is a convenience; the prompt contains everything needed.
    }
    return pending;
  }

  private async pollPendingSignIn(resource: string, pending: PendingDeviceCode, pendingFile: string): Promise<CachedToken> {
    const label = resourceLabel(resource);
    const deadline = this.now() + this.pollWindowMs;

    for (;;) {
      // The code may have been redeemed by another server process in the meantime.
      const completedElsewhere = this.readStoredToken(resource);
      if (this.isUsable(completedElsewhere)) {
        this.store.remove(pendingFile);
        this.memory.set(resource, completedElsewhere!);
        return completedElsewhere!;
      }

      const wait = pending.lastPollAt + pending.interval - this.now();
      if (wait > 0) {
        if (this.now() + wait > deadline) {
          break;
        }
        await this.sleep(wait);
      }
      pending.lastPollAt = this.now();
      this.store.writePending(pendingFile, pending);

      try {
        const data = await this.http.postForm(this.tokenEndpointUrl, {
          grant_type: DEVICE_CODE_GRANT,
          client_id: this.options.clientId,
          device_code: pending.device_code
        }, this.tokenEndpointLabel);
        const token = this.toCachedToken(data);
        this.storeToken(resource, token);
        this.store.remove(pendingFile);
        this.log(`auth: poll for ${label}: token acquired`);
        return token;
      } catch (error) {
        const outcome = classifyPollError(error);
        const code = error instanceof AuthHttpError
          ? error.entra?.error ?? (error.timedOut ? 'timeout' : 'transport error')
          : 'unexpected error';

        if (outcome === 'pending' || outcome === 'slow_down') {
          if (outcome === 'slow_down') {
            pending.interval += 5000;
          }
          pending.lastResult = { at: pending.lastPollAt, outcome: code };
          this.store.writePending(pendingFile, pending);
          this.log(`auth: poll for ${label}: ${outcome === 'slow_down' ? `slow_down, interval now ${pending.interval / 1000} s` : 'pending'}`);
          continue;
        }

        if (outcome === 'restart') {
          this.store.remove(pendingFile);
          this.log(`auth: poll for ${label}: ${code}, issuing a new code`);
          const note = code === 'expired_token'
            ? 'The previous sign-in code expired before the sign-in was completed, so a new code was issued.'
            : 'Microsoft Entra no longer recognised the stored sign-in session (bad_verification_code), so a new code was issued.';
          const fresh = await this.startDeviceCode(resource, pending.scope, pendingFile);
          throw new SignInRequiredError(this.signInMessage(fresh, [note], true));
        }

        if (outcome === 'declined') {
          this.store.remove(pendingFile);
          this.log(`auth: poll for ${label}: ${code}`);
          throw new SignInFailedError(
            `Sign-in failed: the sign-in for ${label} was declined in the browser (${code}).\nRun the tool again to get a new code.`
          );
        }

        if (outcome === 'transient') {
          // A network problem says nothing about the sign-in itself: keep the code, so a
          // sign-in the user may already have completed is not thrown away.
          pending.lastResult = { at: pending.lastPollAt, outcome: code };
          this.store.writePending(pendingFile, pending);
          this.log(`auth: poll for ${label}: ${code}, keeping the code (${errorMessage(error)})`);
          throw new AuthUnavailableError(
            `Could not check the sign-in with Microsoft Entra: ${errorMessage(error)}\n` +
            `The sign-in code ${pending.user_code} stays valid until ${utcTime(pending.expires_at)} UTC; run the tool again.`
          );
        }

        // Fatal. Check once more whether another process redeemed the code a moment ago.
        const redeemedElsewhere = this.readStoredToken(resource);
        if (this.isUsable(redeemedElsewhere)) {
          this.store.remove(pendingFile);
          this.memory.set(resource, redeemedElsewhere!);
          return redeemedElsewhere!;
        }
        this.store.remove(pendingFile);
        this.log(`auth: poll for ${label}: ${detailInline(error)}`);
        throw new SignInFailedError([
          `Sign-in failed: Microsoft Entra did not issue a token for ${label}.`,
          detailLines(error),
          'The sign-in code was discarded. Resolve the cause above, then run the tool again to get a new code.'
        ].join('\n'));
      }
    }

    throw new SignInRequiredError(this.signInMessage(pending, [], false));
  }

  private signInMessage(pending: PendingDeviceCode, notes: string[], fresh: boolean): string {
    const lines = ['Sign-in required to continue.', ''];
    if (notes.length > 0) {
      lines.push(...notes, '');
    }
    lines.push(`Open this URL: ${pending.verification_uri}`, `Enter code: ${pending.user_code}`, '');
    if (fresh) {
      lines.push('(A browser window was opened automatically and the code was copied to your clipboard.)');
    } else {
      lines.push(`(The code is valid until ${utcTime(pending.expires_at)} UTC.)`);
      if (pending.lastResult) {
        lines.push(`Last check at ${utcTime(pending.lastResult.at, true)} UTC: ${describeOutcome(pending.lastResult.outcome)}`);
      }
    }
    lines.push('', 'Run this tool again after completing sign-in.');
    return lines.join('\n');
  }
}
