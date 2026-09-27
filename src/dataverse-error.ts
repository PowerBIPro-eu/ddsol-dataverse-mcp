// Turns failed Dataverse Web API calls into errors that keep the classic first line,
// "Dataverse API Error: <message> (Code: <code>)", which consumers parse, and append the
// details Dataverse returns: inner error, CDS error-detail annotations, HTTP status and
// request ID. Errors are rebuilt from scratch, so the request (bearer token, body)
// never travels with them into logs or tool results.

const MAX_FIELD_LENGTH = 2000;
const CDS_ANNOTATION_PREFIX = '@Microsoft.PowerApps.CDS.';

/**
 * Dataverse only returns its error-detail annotations when the request asks for them.
 * Listing these annotations (rather than "*") leaves successful responses unchanged.
 */
export const ERROR_DETAIL_PREFERENCE =
  'odata.include-annotations="Microsoft.PowerApps.CDS.ErrorDetails*,Microsoft.PowerApps.CDS.HelpLink,' +
  'Microsoft.PowerApps.CDS.TraceText,Microsoft.PowerApps.CDS.InnerError.Message"';

/** Adds the error-detail preference to a Prefer header value, keeping existing preferences. */
export function withErrorDetailPreference(existing?: string): string {
  if (!existing) {
    return ERROR_DETAIL_PREFERENCE;
  }
  if (/odata\.include-annotations/i.test(existing)) {
    return existing;
  }
  return `${existing},${ERROR_DETAIL_PREFERENCE}`;
}

/** A failed Dataverse request. `code` is the Dataverse error code, e.g. 0x80040217. */
export class DataverseRequestError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(message: string, details: { status?: number; code?: string; requestId?: string }) {
    super(message);
    this.name = 'DataverseRequestError';
    this.status = details.status;
    this.code = details.code;
    this.requestId = details.requestId;
  }
}

function clip(value: unknown): string {
  const text = String(value).replace(/\r\n/g, '\n').trim();
  return text.length > MAX_FIELD_LENGTH ? `${text.slice(0, MAX_FIELD_LENGTH)}… (truncated)` : text;
}

function headerValue(headers: any, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

function isTimeout(error: any): boolean {
  return error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || error?.name === 'CanceledError';
}

/**
 * Converts an axios error into a DataverseRequestError. Anything else, such as a
 * sign-in prompt raised before the request was sent, is returned unchanged.
 */
export function toDataverseError(error: unknown): unknown {
  const err = error as any;
  if (!err?.isAxiosError) {
    return error;
  }

  const response = err.response;
  const status: number | undefined = response?.status;
  const requestId = headerValue(response?.headers, 'x-ms-service-request-id') ?? headerValue(response?.headers, 'REQ_ID');
  const statusLine = status ? `HTTP status: ${status}${response.statusText ? ` ${response.statusText}` : ''}` : undefined;
  const requestIdLine = requestId ? `x-ms-service-request-id: ${requestId}` : undefined;
  const body = response?.data?.error;

  if (body && typeof body === 'object') {
    const lines = [`Dataverse API Error: ${body.message} (Code: ${body.code})`];
    if (body.innererror?.message) {
      lines.push(`Inner error: ${clip(body.innererror.message)}`);
    }
    if (body.innererror?.type) {
      lines.push(`Inner error type: ${clip(body.innererror.type)}`);
    }
    for (const [key, value] of Object.entries(body)) {
      if (key.startsWith(CDS_ANNOTATION_PREFIX) && value !== undefined && value !== null && value !== '') {
        lines.push(`${key.slice(CDS_ANNOTATION_PREFIX.length)}: ${clip(value)}`);
      }
    }
    if (statusLine) lines.push(statusLine);
    if (requestIdLine) lines.push(requestIdLine);
    return new DataverseRequestError(lines.join('\n'), { status, code: body.code, requestId });
  }

  let firstLine: string;
  if (status) {
    firstLine = `Dataverse request failed with HTTP ${status}${response.statusText ? ` ${response.statusText}` : ''}.`;
  } else if (isTimeout(err)) {
    firstLine = `Dataverse request timed out (${err.code ?? 'timeout'}).`;
  } else {
    firstLine = `Dataverse request failed: ${err.code ? `${err.code}: ` : ''}${err.message ?? 'network error'}`;
  }
  const lines = [firstLine];
  if (requestIdLine) lines.push(requestIdLine);
  return new DataverseRequestError(lines.join('\n'), { status, requestId });
}
