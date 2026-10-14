/**
 * Normalises a Dataverse environment URL to its origin: scheme and host in lower case,
 * no path, query, fragment or trailing slash. A pasted Web API endpoint such as
 * https://contoso.api.crm4.dynamics.com/api/data/v9.2/ becomes
 * https://contoso.api.crm4.dynamics.com, and a missing scheme defaults to https.
 *
 * The browser URL (contoso.crm4.dynamics.com) and the API URL
 * (contoso.api.crm4.dynamics.com) are deliberately not mapped onto each other: both
 * work, and each has its own token cache entry.
 *
 * Plain http is accepted only for localhost, which the unit tests use.
 */
export function normalizeEnvironmentUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('The environment URL is empty.');
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`'${input}' is not a valid environment URL. Use the form https://contoso.api.crm4.dynamics.com.`);
  }
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(`Environment URLs must use https: '${input}'.`);
  }
  return url.origin;
}
