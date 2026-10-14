import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createTableTool } from '../../build/tools/table-tools.js';
import { fakeClient, registerTools } from './helpers/fake-tools.mjs';

const TABLE = {
  displayName: 'Technical Resource',
  displayCollectionName: 'Technical Resources',
  logicalName: 'cnt_technicalresource',
  schemaName: 'cnt_technicalresource',
  primaryNameDisplayName: 'Name',
  primaryNameLogicalName: 'cnt_name',
  primaryNameSchemaName: 'cnt_name'
};
const FLAG_PROPERTIES = ['IsAuditEnabled', 'IsDuplicateDetectionEnabled', 'IsValidForQueue', 'IsConnectionsEnabled', 'IsMailMergeEnabled', 'IsDocumentManagementEnabled'];

function storedEntity(overrides = {}) {
  const managed = (value) => ({ Value: value, CanBeChanged: true });
  return {
    IsAuditEnabled: managed(false),
    IsDuplicateDetectionEnabled: managed(false),
    IsValidForQueue: managed(false),
    IsConnectionsEnabled: managed(false),
    IsMailMergeEnabled: managed(true),
    IsDocumentManagementEnabled: false,
    ...overrides
  };
}

function create(client, args) {
  return registerTools([createTableTool], client).call('create_dataverse_table', args);
}

test('supplied flags are sent like update_dataverse_table sends them', async () => {
  const client = fakeClient({
    getMetadata: () => storedEntity({ IsDuplicateDetectionEnabled: { Value: true }, IsDocumentManagementEnabled: true })
  });
  const result = await create(client, { ...TABLE, isDuplicateDetectionEnabled: true, isDocumentManagementEnabled: true });

  const [, body] = client.callsTo('postMetadata')[0];
  assert.deepEqual(body.IsDuplicateDetectionEnabled, {
    Value: true,
    CanBeChanged: true,
    ManagedPropertyLogicalName: 'canmodifyduplicatedetectionsettings'
  });
  assert.equal(body.IsDocumentManagementEnabled, true, 'IsDocumentManagementEnabled is a plain Edm.Boolean');
  for (const property of ['IsAuditEnabled', 'IsValidForQueue', 'IsConnectionsEnabled', 'IsMailMergeEnabled']) {
    assert.equal(property in body, false, `${property} was not supplied and must not be sent`);
  }

  const [endpoint, params, headers] = client.callsTo('getMetadata')[0];
  assert.equal(endpoint, "EntityDefinitions(LogicalName='cnt_technicalresource')");
  assert.equal(params.$select, FLAG_PROPERTIES.join(','));
  assert.deepEqual(headers, { Consistency: 'Strong' });
  assert.match(result.content[0].text, /- IsDuplicateDetectionEnabled: true/);
  assert.match(result.content[0].text, /- IsDocumentManagementEnabled: true/);
  assert.match(result.content[0].text, /- IsMailMergeEnabled: true/);
});

test('all six managed flags use the same managed-property names as the update path', async () => {
  const client = fakeClient({ getMetadata: () => storedEntity() });
  await create(client, {
    ...TABLE,
    isAuditEnabled: true,
    isDuplicateDetectionEnabled: false,
    isValidForQueue: true,
    isConnectionsEnabled: true,
    isMailMergeEnabled: false,
    isDocumentManagementEnabled: false
  });
  const [, body] = client.callsTo('postMetadata')[0];
  assert.deepEqual(
    Object.fromEntries(FLAG_PROPERTIES.slice(0, 5).map((property) => [property, body[property].ManagedPropertyLogicalName])),
    {
      IsAuditEnabled: 'canmodifyauditsettings',
      IsDuplicateDetectionEnabled: 'canmodifyduplicatedetectionsettings',
      IsValidForQueue: 'canmodifyqueuesettings',
      IsConnectionsEnabled: 'canmodifyconnectionsettings',
      IsMailMergeEnabled: 'canmodifymailmergesettings'
    }
  );
  assert.equal(body.IsDocumentManagementEnabled, false);
});

test('omitted flags are not sent, so Dataverse defaults apply', async () => {
  const client = fakeClient({ getMetadata: () => storedEntity() });
  await create(client, TABLE);
  const [, body] = client.callsTo('postMetadata')[0];
  for (const property of FLAG_PROPERTIES) {
    assert.equal(property in body, false, `${property} must not be sent when omitted`);
  }
});

test('the six flags are optional without defaults in the tool schema', () => {
  const schema = registerTools([createTableTool], fakeClient()).schema('create_dataverse_table');
  const parsed = z.object(schema).parse(TABLE);
  for (const param of ['isAuditEnabled', 'isDuplicateDetectionEnabled', 'isValidForQueue', 'isConnectionsEnabled', 'isMailMergeEnabled', 'isDocumentManagementEnabled']) {
    assert.equal(parsed[param], undefined, `${param} must stay undefined when omitted`);
  }
});

test('a flag Dataverse did not store is reported as a warning', async () => {
  const client = fakeClient({ getMetadata: () => storedEntity() });
  const result = await create(client, { ...TABLE, isDuplicateDetectionEnabled: true });
  assert.match(result.content[0].text, /WARNING: IsDuplicateDetectionEnabled was requested as 'true', but Dataverse reports 'false'\./);
});
