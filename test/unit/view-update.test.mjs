import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateViewTool } from '../../build/tools/view-tools.js';
import { fakeClient, registerTools } from './helpers/fake-tools.mjs';

const VIEW_ID = '00000000-0000-0000-0000-000000000001';
const UNEXPECTED = 'Dataverse API Error: An unexpected error occurred. (Code: 0x80040216)\nInnerError.Message: details\nHTTP status: 500 Internal Server Error';

function update(client) {
  return registerTools([updateViewTool], client).call('update_dataverse_view', { savedQueryId: VIEW_ID, fetchXml: '<fetch/>' });
}

test('view updates send If-Match: * so a wrong ID cannot create a view', async () => {
  const client = fakeClient();
  const result = await update(client);
  assert.ok(!result.isError);
  const [endpoint, body, headers] = client.callsTo('patch')[0];
  assert.equal(endpoint, `savedqueries(${VIEW_ID})`);
  assert.deepEqual(body, { fetchxml: '<fetch/>' });
  assert.deepEqual(headers, { 'If-Match': '*' });
});

test('an unexpected error on a Quick Find view keeps the details and adds a hint', async () => {
  const client = fakeClient({
    patch: () => { throw new Error(UNEXPECTED); },
    get: () => ({ name: 'Quick Find Active Resources', querytype: 4, isquickfindquery: true })
  });
  const result = await update(client);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.startsWith(`Error updating view: ${UNEXPECTED}`));
  assert.match(result.content[0].text, /This is the Quick Find view of the table\./);
  assert.match(client.callsTo('get')[0][0], /isquickfindquery/);
});

test('the same error on a regular view gets no Quick Find hint', async () => {
  const client = fakeClient({
    patch: () => { throw new Error(UNEXPECTED); },
    get: () => ({ name: 'Active Resources', querytype: 0, isquickfindquery: false })
  });
  const result = await update(client);
  assert.doesNotMatch(result.content[0].text, /Quick Find/);
});

test('other errors do not trigger the Quick Find lookup', async () => {
  const client = fakeClient({ patch: () => { throw new Error('Dataverse API Error: Invalid FetchXML. (Code: 0x80041103)'); } });
  const result = await update(client);
  assert.equal(result.isError, true);
  assert.equal(client.callsTo('get').length, 0);
});
