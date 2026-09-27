import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEnvironmentUrl } from '../../build/environment-url.js';

test('environment URLs are reduced to a lower-case origin', () => {
  const cases = [
    ['https://contoso.api.crm4.dynamics.com', 'https://contoso.api.crm4.dynamics.com'],
    ['https://contoso.api.crm4.dynamics.com/', 'https://contoso.api.crm4.dynamics.com'],
    ['https://contoso.api.crm4.dynamics.com///', 'https://contoso.api.crm4.dynamics.com'],
    ['HTTPS://Contoso.API.CRM4.Dynamics.com', 'https://contoso.api.crm4.dynamics.com'],
    ['https://contoso.api.crm4.dynamics.com/api/data/v9.2/', 'https://contoso.api.crm4.dynamics.com'],
    ['https://contoso.crm4.dynamics.com/main.aspx?appid=1#x', 'https://contoso.crm4.dynamics.com'],
    ['  contoso.crm4.dynamics.com  ', 'https://contoso.crm4.dynamics.com'],
    ['https://contoso.api.crm4.dynamics.com:443', 'https://contoso.api.crm4.dynamics.com'],
    ['http://127.0.0.1:5555/api/data/v9.2', 'http://127.0.0.1:5555']
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeEnvironmentUrl(input), expected, `for ${input}`);
  }
});

test('the browser URL and the API URL stay distinct', () => {
  assert.notEqual(
    normalizeEnvironmentUrl('https://contoso.crm4.dynamics.com'),
    normalizeEnvironmentUrl('https://contoso.api.crm4.dynamics.com')
  );
});

test('invalid or insecure URLs are rejected with a clear message', () => {
  assert.throws(() => normalizeEnvironmentUrl(''), /empty/);
  assert.throws(() => normalizeEnvironmentUrl('http://contoso.crm4.dynamics.com'), /must use https/);
  assert.throws(() => normalizeEnvironmentUrl('https://'), /not a valid environment URL/);
});
