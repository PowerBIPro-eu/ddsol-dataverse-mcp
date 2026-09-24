import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import {
  AuthHttpError,
  formatEntraFields,
  formatEntraFieldsInline,
  getJson,
  postForm
} from '../../build/auth/entra-http.js';

// Starts a local HTTP server; `handler` decides how (or whether) to answer.
async function withServer(handler, run) {
  const sockets = new Set();
  const server = createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/token`;
  try {
    return await run(url);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to fail');
}

test('a server that never answers times out and names the endpoint', async () => {
  await withServer(() => {}, async (url) => {
    const started = Date.now();
    const error = await rejectionOf(postForm(url, { a: 'b' }, 'Test token endpoint', 1000));
    assert.ok(error instanceof AuthHttpError);
    assert.equal(error.timedOut, true);
    assert.equal(error.transient, true);
    assert.equal(error.message, 'Request to Test token endpoint timed out after 1 s.');
    assert.ok(Date.now() - started < 5000, 'timeout took too long');
  });
});

test('a response that keeps trickling bytes is cut off by the hard deadline', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const timer = setInterval(() => res.write(' '), 100);
    res.on('close', () => clearInterval(timer));
  }, async (url) => {
    const error = await rejectionOf(postForm(url, { a: 'b' }, 'Test token endpoint', 1000));
    assert.equal(error.timedOut, true);
  });
});

test('an Entra OAuth error keeps its non-secret fields and is not transient', async () => {
  const body = {
    error: 'invalid_grant',
    error_description: 'AADSTS53003: Access has been blocked by Conditional Access policies.\r\nTrace ID: t-1\r\nCorrelation ID: c-1',
    error_codes: [53003],
    timestamp: '2026-09-23 16:02:53Z',
    trace_id: 't-1',
    correlation_id: 'c-1'
  };
  await withServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }, async (url) => {
    const error = await rejectionOf(postForm(url, { refresh_token: 'SECRET-REFRESH-TOKEN' }, 'Test token endpoint'));
    assert.equal(error.status, 400);
    assert.equal(error.transient, false);
    assert.equal(error.entra.error, 'invalid_grant');
    assert.deepEqual(error.entra.error_codes, [53003]);
    assert.equal(error.message, 'Test token endpoint returned invalid_grant (HTTP 400).');

    const rendered = formatEntraFields(error.entra);
    assert.match(rendered, /^error: invalid_grant$/m);
    assert.match(rendered, /^error_description: AADSTS53003: Access has been blocked by Conditional Access policies\. Trace ID: t-1 Correlation ID: c-1$/m);
    assert.match(rendered, /^error_codes: 53003$/m);
    assert.match(rendered, /^correlation_id: c-1$/m);
    assert.match(rendered, /^trace_id: t-1$/m);
    assert.match(rendered, /^timestamp: 2026-09-23 16:02:53Z$/m);
    assert.match(formatEntraFieldsInline(error.entra), /^error=invalid_grant error_description=AADSTS53003/);
  });
});

test('no secret from the request body or headers survives on the error object', async () => {
  await withServer((req, res) => {
    res.writeHead(500);
    res.end('upstream failure');
  }, async (url) => {
    const error = await rejectionOf(
      postForm(url, { refresh_token: 'SECRET-REFRESH-TOKEN', device_code: 'SECRET-DEVICE-CODE', client_secret: 'SECRET-CLIENT' }, 'Test token endpoint')
    );
    const everything = [error.message, error.stack, inspect(error, { depth: 20, showHidden: true }), JSON.stringify(error)].join('\n');
    for (const secret of ['SECRET-REFRESH-TOKEN', 'SECRET-DEVICE-CODE', 'SECRET-CLIENT']) {
      assert.ok(!everything.includes(secret), `${secret} leaked into the error`);
    }
    assert.equal(error.transient, true, 'HTTP 500 should be transient');

    const getError = await rejectionOf(getJson(url, 'SECRET-BEARER-TOKEN', 'Test discovery'));
    assert.ok(!inspect(getError, { depth: 20, showHidden: true }).includes('SECRET-BEARER-TOKEN'));
  });
});

test('a refused connection is a transient transport error', async () => {
  // Grab a free port, then close the server so nothing listens on it.
  const port = await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const error = await rejectionOf(postForm(`http://127.0.0.1:${port}/token`, { a: 'b' }, 'Test token endpoint', 5000));
  assert.equal(error.transient, true);
  assert.equal(error.timedOut, false);
  assert.match(error.message, /^Could not reach Test token endpoint \(ECONNREFUSED/);
});

test('long Entra fields are truncated to 2,000 characters', () => {
  const rendered = formatEntraFields({ error: 'server_error', error_description: 'x'.repeat(5000) });
  const line = rendered.split('\n').find((l) => l.startsWith('error_description: '));
  assert.equal(line.length, 'error_description: '.length + 2000 + '… (truncated)'.length);
});
