import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import {
  DataverseRequestError,
  ERROR_DETAIL_PREFERENCE,
  toDataverseError,
  withErrorDetailPreference
} from '../../build/dataverse-error.js';

function axiosError({ status, statusText, data, headers = {}, code, message = 'Request failed' }) {
  return {
    isAxiosError: true,
    code,
    message,
    // A real axios error carries the request config, including the bearer token.
    config: { headers: { Authorization: 'Bearer SECRET-TOKEN' }, data: '{"secret":"SECRET-BODY"}' },
    response: status ? { status, statusText, data, headers } : undefined
  };
}

test('the first line stays exactly as before and the details follow', () => {
  const error = toDataverseError(axiosError({
    status: 500,
    statusText: 'Internal Server Error',
    headers: { 'x-ms-service-request-id': 'req-123' },
    data: {
      error: {
        code: '0x80040216',
        message: 'An unexpected error occurred.',
        innererror: { message: 'Inner detail', type: 'Microsoft.Crm.CrmException', stacktrace: 'at Somewhere()' },
        '@Microsoft.PowerApps.CDS.ErrorDetails.OperationStatus': '0',
        '@Microsoft.PowerApps.CDS.ErrorDetails.SubErrorCode': '-2146233088',
        '@Microsoft.PowerApps.CDS.HelpLink': 'http://go.microsoft.com/fwlink/?LinkID=398563&error=Microsoft.Crm.CrmException%3a80040216',
        '@Microsoft.PowerApps.CDS.TraceText': 'line 1\r\nline 2',
        '@Microsoft.PowerApps.CDS.InnerError.Message': 'The real cause.'
      }
    }
  }));

  assert.ok(error instanceof DataverseRequestError);
  assert.equal(error.code, '0x80040216');
  assert.equal(error.status, 500);
  assert.equal(error.requestId, 'req-123');
  assert.deepEqual(error.message.split('\n'), [
    'Dataverse API Error: An unexpected error occurred. (Code: 0x80040216)',
    'Inner error: Inner detail',
    'Inner error type: Microsoft.Crm.CrmException',
    'ErrorDetails.OperationStatus: 0',
    'ErrorDetails.SubErrorCode: -2146233088',
    'HelpLink: http://go.microsoft.com/fwlink/?LinkID=398563&error=Microsoft.Crm.CrmException%3a80040216',
    'TraceText: line 1',
    'line 2',
    'InnerError.Message: The real cause.',
    'HTTP status: 500 Internal Server Error',
    'x-ms-service-request-id: req-123'
  ]);
});

test('a single field is truncated to 2,000 characters', () => {
  const error = toDataverseError(axiosError({
    status: 400,
    data: { error: { code: '0x1', message: 'm', '@Microsoft.PowerApps.CDS.TraceText': 'x'.repeat(10_000) } }
  }));
  const traceLine = error.message.split('\n').find((line) => line.startsWith('TraceText: '));
  assert.equal(traceLine, `TraceText: ${'x'.repeat(2000)}… (truncated)`);
});

test('errors without a Dataverse body are rebuilt without the request config', () => {
  const unauthorized = toDataverseError(axiosError({ status: 401, statusText: 'Unauthorized', data: '', headers: { 'x-ms-service-request-id': 'req-9' } }));
  assert.equal(unauthorized.message, 'Dataverse request failed with HTTP 401 Unauthorized.\nx-ms-service-request-id: req-9');

  const network = toDataverseError(axiosError({ code: 'ECONNRESET', message: 'socket hang up' }));
  assert.equal(network.message, 'Dataverse request failed: ECONNRESET: socket hang up');

  const timeout = toDataverseError(axiosError({ code: 'ECONNABORTED', message: 'timeout of 1ms exceeded' }));
  assert.equal(timeout.message, 'Dataverse request timed out (ECONNABORTED).');

  for (const error of [unauthorized, network, timeout]) {
    const everything = inspect(error, { depth: 20, showHidden: true });
    assert.ok(!everything.includes('SECRET-TOKEN'), 'the bearer token leaked');
    assert.ok(!everything.includes('SECRET-BODY'), 'the request body leaked');
  }
});

test('non-axios errors, such as a sign-in prompt, pass through unchanged', () => {
  const prompt = new Error('Sign-in required to continue.');
  assert.equal(toDataverseError(prompt), prompt);
});

test('the error-detail preference is added without dropping other preferences', () => {
  assert.equal(withErrorDetailPreference(undefined), ERROR_DETAIL_PREFERENCE);
  assert.equal(withErrorDetailPreference('return=representation'), `return=representation,${ERROR_DETAIL_PREFERENCE}`);
  assert.equal(withErrorDetailPreference('odata.include-annotations="*"'), 'odata.include-annotations="*"');
});
