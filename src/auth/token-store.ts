import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// On-disk storage for OAuth tokens and device-code sign-ins in progress. Files are
// written atomically (temporary file + rename), so a second server process never
// reads a half-written file, and with owner-only permissions on macOS and Linux.

/** A cached OAuth token (dataverse-mcp-auth-*.json). */
export interface CachedToken {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  /** Epoch milliseconds, one minute before the token really expires. */
  expires_at: number;
  refresh_token?: string;
  scope?: string;
}

/** A device-code sign-in in progress (dataverse-mcp-pending-*.json). */
export interface PendingDeviceCode {
  tenantId: string;
  clientId: string;
  scope: string;
  resource: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** Epoch milliseconds after which the code can no longer be redeemed. */
  expires_at: number;
  /** Minimum time between two polls, in milliseconds. */
  interval: number;
  /** Epoch milliseconds of the last poll, 0 before the first one. */
  lastPollAt: number;
  /** Outcome of the last poll, shown when the sign-in prompt is repeated. */
  lastResult?: { at: number; outcome: string };
}

/** The token cache directory. Unchanged from earlier versions, so existing sign-ins keep working. */
export function defaultTokenCacheDir(): string {
  return process.env.LOCALAPPDATA || process.env.HOME || process.cwd();
}

/** The cache key used in token file names since the first device-code release. */
export function tokenCacheKey(tenantId: string, clientId: string, resource: string): string {
  return Buffer.from(`${tenantId}:${clientId}:${resource}`).toString('hex');
}

export class TokenStore {
  constructor(readonly dir: string) {}

  tokenPath(tenantId: string, clientId: string, resource: string): string {
    return path.join(this.dir, `dataverse-mcp-auth-${tokenCacheKey(tenantId, clientId, resource)}.json`);
  }

  /**
   * A pending sign-in is identified by tenant, client and scope: Microsoft Entra only
   * redeems a device code for the tenant and client that requested it, so servers with
   * different configurations must never share one. Hashed to keep the name short.
   */
  pendingPath(tenantId: string, clientId: string, scope: string): string {
    const digest = crypto.createHash('sha256').update(`${tenantId}:${clientId}:${scope}`).digest('hex').slice(0, 40);
    return path.join(this.dir, `dataverse-mcp-pending-${digest}.json`);
  }

  readToken(filePath: string): CachedToken | null {
    const data = readJson(filePath);
    return data && typeof data.access_token === 'string' && typeof data.expires_at === 'number' ? data : null;
  }

  writeToken(filePath: string, token: CachedToken): void {
    writeJsonAtomic(filePath, token);
  }

  readPending(filePath: string): PendingDeviceCode | null {
    const data = readJson(filePath);
    return data && typeof data.device_code === 'string' ? data : null;
  }

  writePending(filePath: string, pending: PendingDeviceCode): void {
    writeJsonAtomic(filePath, pending);
  }

  remove(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        console.error(`[dataverse-mcp] could not delete ${path.basename(filePath)} (${error?.code ?? 'unknown error'})`);
      }
    }
  }
}

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      // Only the error code: a JSON parse message can quote part of a token.
      console.error(`[dataverse-mcp] ignoring unreadable file ${path.basename(filePath)} (${error?.code ?? error?.name ?? 'unknown error'})`);
    }
    return null;
  }
}

/** Writes JSON through a temporary file and a rename, with owner-only permissions. */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    renameWithRetry(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Nothing more to clean up.
    }
    throw error;
  }
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error: any) {
      // On Windows a virus scanner or another reader can hold the target for a moment.
      if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}
