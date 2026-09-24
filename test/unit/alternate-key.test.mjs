import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlternateKeyTool, createdKeyLookup, keyIdFromEntityIdHeader } from '../../build/tools/alternate-key-tools.js';
import { fakeClient, registerTools } from './helpers/fake-tools.mjs';

createdKeyLookup.delayMs = 0;

const KEY_ID = '11111111-2222-3333-4444-555555555555';
const ENTITY_ID_HEADER = `https://contoso.api.crm4.dynamics.com/api/data/v9.2/EntityDefinitions(aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)/Keys(${KEY_ID})`;
const ARGS = { entityLogicalName: 'cnt_resource', schemaName: 'cnt_resourceidentitykey', keyAttributes: ['cnt_code'] };
const KEY = { MetadataId: KEY_ID, SchemaName: 'cnt_resourceidentitykey', KeyAttributes: ['cnt_code'], EntityKeyIndexStatus: 'Pending' };

function notFound() {
  const error = new Error("Dataverse API Error: Could not find the key. (Code: 0x80040217)\nHTTP status: 404 Not Found");
  error.status = 404;
  error.code = '0x80040217';
  return error;
}

function created(headers = { 'odata-entityid': ENTITY_ID_HEADER }) {
  return () => ({ data: '', status: 204, headers });
}

function create(client) {
  return registerTools([createAlternateKeyTool], client).call('create_dataverse_alternate_key', ARGS);
}

test('the key ID is taken from OData-EntityId and looked up with strong consistency', async () => {
  const client = fakeClient({ postMetadataWithResponse: created(), getMetadata: () => KEY });
  const result = await create(client);

  assert.ok(!result.isError);
  assert.match(result.content[0].text, /^Successfully created alternate key 'cnt_resourceidentitykey' on table 'cnt_resource'\. Index status: Pending\./);
  const [endpoint, params, headers] = client.callsTo('getMetadata')[0];
  assert.equal(endpoint, `EntityDefinitions(LogicalName='cnt_resource')/Keys(${KEY_ID})`);
  assert.match(params.$select, /EntityKeyIndexStatus/);
  assert.deepEqual(headers, { Consistency: 'Strong' });
});

test('a key that is not visible at first is found by retrying', async () => {
  let lookups = 0;
  const client = fakeClient({
    postMetadataWithResponse: created(),
    getMetadata: () => {
      if (++lookups < 3) throw notFound();
      return KEY;
    }
  });
  const result = await create(client);
  assert.match(result.content[0].text, /Index status: Pending/);
  assert.equal(client.callsTo('getMetadata').length, 3);
});

test('a key that is still not visible after the retries is reported as created, not as failed', async () => {
  const client = fakeClient({ postMetadataWithResponse: created(), getMetadata: () => { throw notFound(); } });
  const result = await create(client);

  assert.ok(!result.isError, 'a created key must not be reported as an error');
  assert.match(result.content[0].text, new RegExp(`\\(keyId: ${KEY_ID}\\), but it is not visible in the table metadata yet\\.`));
  assert.match(result.content[0].text, /Do not create it again\./);
  assert.equal(client.callsTo('getMetadata').length, createdKeyLookup.attempts);
});

test('without the header the key is found by its schema name', async () => {
  const client = fakeClient({ postMetadataWithResponse: created({}), getMetadata: () => ({ value: [{ ...KEY, SchemaName: 'other' }, KEY] }) });
  const result = await create(client);
  assert.match(result.content[0].text, /Index status: Pending/);
  assert.equal(client.callsTo('getMetadata')[0][0], "EntityDefinitions(LogicalName='cnt_resource')/Keys");
});

test('a lookup failure other than not found is not retried and does not fail the create', async () => {
  const client = fakeClient({
    postMetadataWithResponse: created(),
    getMetadata: () => { throw new Error('Dataverse request failed with HTTP 500 Internal Server Error.'); }
  });
  const result = await create(client);
  assert.ok(!result.isError);
  assert.match(result.content[0].text, /lookup failed: Dataverse request failed with HTTP 500/);
  assert.equal(client.callsTo('getMetadata').length, 1);
});

test('a failed create request is still an error', async () => {
  const client = fakeClient({
    postMetadataWithResponse: () => { throw new Error('Dataverse API Error: A key with this name already exists. (Code: 0x80060889)'); }
  });
  const result = await create(client);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Error creating alternate key: Dataverse API Error: A key with this name already exists/);
});

test('keyIdFromEntityIdHeader reads the key ID and ignores anything else', () => {
  assert.equal(keyIdFromEntityIdHeader(ENTITY_ID_HEADER), KEY_ID);
  assert.equal(keyIdFromEntityIdHeader(undefined), undefined);
  assert.equal(keyIdFromEntityIdHeader('https://contoso/api/data/v9.2/accounts(1)'), undefined);
});
