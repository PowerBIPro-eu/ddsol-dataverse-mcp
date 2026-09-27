import axios from 'axios';

// HTTP helpers for Microsoft Entra ID (device-code and token endpoints) and the
// Global Discovery Service. Every call gets a hard time limit, and failures are
// turned into AuthHttpError objects that carry only non-secret details.

/** Time limit for every authentication-related HTTP call. */
export const AUTH_HTTP_TIMEOUT_MS = 30_000;

/** The non-secret fields Microsoft Entra returns with an OAuth error. */
export interface EntraErrorFields {
  error?: string;
  error_description?: string;
  error_codes?: number[];
  correlation_id?: string;
  trace_id?: string;
  timestamp?: string;
}

const ENTRA_FIELD_NAMES: (keyof EntraErrorFields)[] = [
  'error',
  'error_description',
  'error_codes',
  'correlation_id',
  'trace_id',
  'timestamp'
];

const MAX_FIELD_LENGTH = 2000;

export interface AuthHttpErrorDetails {
  /** HTTP status, when a response arrived. */
  status?: number;
  /** Entra error fields, when the response body was an OAuth error. */
  entra?: EntraErrorFields;
  /** Network failure, timeout, throttling or server error: worth retrying later. */
  transient: boolean;
  timedOut: boolean;
}

/**
 * A failed call to Microsoft Entra ID or the Global Discovery Service.
 *
 * Built from scratch instead of wrapping the axios error: that object carries the
 * request config, whose body and headers hold refresh tokens, device codes, client
 * secrets or bearer tokens, and must never reach a log or a tool result.
 */
export class AuthHttpError extends Error {
  readonly endpoint: string;
  readonly status?: number;
  readonly entra?: EntraErrorFields;
  readonly transient: boolean;
  readonly timedOut: boolean;

  constructor(message: string, endpoint: string, details: AuthHttpErrorDetails) {
    super(message);
    this.name = 'AuthHttpError';
    this.endpoint = endpoint;
    this.status = details.status;
    this.entra = details.entra;
    this.transient = details.transient;
    this.timedOut = details.timedOut;
  }
}

/** Extracts the Entra error fields from a response body, or undefined if it isn't an OAuth error. */
export function pickEntraFields(body: unknown): EntraErrorFields | undefined {
  if (!body || typeof body !== 'object' || typeof (body as any).error !== 'string') {
    return undefined;
  }
  const fields: EntraErrorFields = {};
  for (const name of ENTRA_FIELD_NAMES) {
    const value = (body as any)[name];
    if (value !== undefined && value !== null && value !== '') {
      (fields as any)[name] = value;
    }
  }
  return fields;
}

function renderFieldValue(value: unknown): string {
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  const singleLine = text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return singleLine.length > MAX_FIELD_LENGTH ? `${singleLine.slice(0, MAX_FIELD_LENGTH)}… (truncated)` : singleLine;
}

/** Renders the Entra error fields one per line, for tool results. */
export function formatEntraFields(fields: EntraErrorFields): string {
  return ENTRA_FIELD_NAMES
    .filter((name) => fields[name] !== undefined)
    .map((name) => `${name}: ${renderFieldValue(fields[name])}`)
    .join('\n');
}

/** Renders the Entra error fields on one line, for stderr logs. */
export function formatEntraFieldsInline(fields: EntraErrorFields): string {
  return ENTRA_FIELD_NAMES
    .filter((name) => fields[name] !== undefined)
    .map((name) => `${name}=${renderFieldValue(fields[name])}`)
    .join(' ');
}

function isTimeout(error: any): boolean {
  return (
    error?.code === 'ECONNABORTED' ||
    error?.code === 'ETIMEDOUT' ||
    error?.code === 'ERR_CANCELED' ||
    error?.name === 'CanceledError' ||
    error?.name === 'AbortError' ||
    error?.name === 'TimeoutError'
  );
}

/** Converts whatever axios threw into an AuthHttpError without copying any request data. */
export function toAuthHttpError(error: unknown, endpoint: string, timeoutMs: number = AUTH_HTTP_TIMEOUT_MS): AuthHttpError {
  const err = error as any;
  if (isTimeout(err)) {
    return new AuthHttpError(
      `Request to ${endpoint} timed out after ${Math.round(timeoutMs / 1000)} s.`,
      endpoint,
      { transient: true, timedOut: true }
    );
  }

  const status: unknown = err?.response?.status;
  if (typeof status === 'number') {
    const entra = pickEntraFields(err.response.data);
    const transient = status >= 500 || status === 429 || entra?.error === 'temporarily_unavailable';
    const reason = entra?.error ?? `HTTP ${status}`;
    return new AuthHttpError(`${endpoint} returned ${reason} (HTTP ${status}).`, endpoint, {
      status,
      entra,
      transient,
      timedOut: false
    });
  }

  const code = typeof err?.code === 'string' ? `${err.code}: ` : '';
  const detail = typeof err?.message === 'string' ? err.message : 'network error';
  return new AuthHttpError(`Could not reach ${endpoint} (${code}${detail}).`, endpoint, {
    transient: true,
    timedOut: false
  });
}

/** POSTs an application/x-www-form-urlencoded body and returns the parsed response body. */
export async function postForm(
  url: string,
  form: Record<string, string>,
  endpoint: string,
  timeoutMs: number = AUTH_HTTP_TIMEOUT_MS
): Promise<any> {
  try {
    const response = await axios.post(url, new URLSearchParams(form), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // `timeout` only fires when the socket goes idle; the abort signal is a hard
      // deadline that also covers DNS, connect and slowly trickling responses.
      timeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response.data;
  } catch (error) {
    throw toAuthHttpError(error, endpoint, timeoutMs);
  }
}

/** GETs a JSON resource with a bearer token and returns the parsed response body. */
export async function getJson(
  url: string,
  bearerToken: string,
  endpoint: string,
  timeoutMs: number = AUTH_HTTP_TIMEOUT_MS
): Promise<any> {
  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${bearerToken}`, Accept: 'application/json' },
      timeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response.data;
  } catch (error) {
    throw toAuthHttpError(error, endpoint, timeoutMs);
  }
}
