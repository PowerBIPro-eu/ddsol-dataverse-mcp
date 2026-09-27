import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createColumnTool, updateColumnTool } from '../../build/tools/column-tools.js';
import { fakeClient, registerTools } from './helpers/fake-tools.mjs';

const STRING_COLUMN = {
  entityLogicalName: 'cnt_resource',
  displayName: 'Primary URL',
  schemaName: 'cnt_primaryurl',
  logicalName: 'cnt_primaryurl',
  columnType: 'String',
  maxLength: 1000
};
const READ_BACK = "EntityDefinitions(LogicalName='cnt_resource')/Attributes(LogicalName='cnt_primaryurl')/Microsoft.Dynamics.CRM.StringAttributeMetadata";

function create(client, args) {
  return registerTools([createColumnTool], client).call('create_dataverse_column', args);
}

test('create: a String format is sent as FormatName and Format, then read back', async () => {
  const client = fakeClient({ getMetadata: () => ({ FormatName: { Value: 'Url' }, Format: 'Url' }) });
  const result = await create(client, { ...STRING_COLUMN, format: 'Url' });

  const [endpoint, body] = client.callsTo('postMetadata')[0];
  assert.equal(endpoint, "EntityDefinitions(LogicalName='cnt_resource')/Attributes");
  assert.deepEqual(body.FormatName, { Value: 'Url' });
  assert.equal(body.Format, 'Url');
  assert.equal(body.MaxLength, 1000);

  const [readEndpoint, params, headers] = client.callsTo('getMetadata')[0];
  assert.equal(readEndpoint, READ_BACK);
  assert.equal(params.$select, 'LogicalName,FormatName,Format');
  assert.deepEqual(headers, { Consistency: 'Strong' });
  assert.ok(!result.isError);
  assert.match(result.content[0].text, /\nStored format: Url\n/);
});

test('create: every documented String format is accepted, including Json and TickerSymbol', async () => {
  for (const format of ['Email', 'Text', 'TextArea', 'Url', 'TickerSymbol', 'Phone', 'Json']) {
    const client = fakeClient({ getMetadata: () => ({ FormatName: { Value: format } }) });
    const result = await create(client, { ...STRING_COLUMN, format });
    assert.equal(client.callsTo('postMetadata')[0][1].FormatName.Value, format);
    assert.match(result.content[0].text, new RegExp(`Stored format: ${format}`));
  }
});

test('create: a format Dataverse did not store is reported as a warning', async () => {
  const client = fakeClient({ getMetadata: () => ({ FormatName: { Value: 'Text' } }) });
  const result = await create(client, { ...STRING_COLUMN, format: 'Url' });
  assert.match(result.content[0].text, /WARNING: Stored format was requested as 'Url', but Dataverse reports 'Text'\./);
});

test('create: without a format the Dataverse default is kept and reported', async () => {
  const client = fakeClient({ getMetadata: () => ({ FormatName: { Value: 'Text' } }) });
  const result = await create(client, STRING_COLUMN);
  const body = client.callsTo('postMetadata')[0][1];
  assert.equal(body.FormatName, undefined);
  assert.equal(body.Format, undefined);
  assert.match(result.content[0].text, /Stored format: Text/);
});

test('create: an Integer format is sent as Format and read back', async () => {
  const client = fakeClient({ getMetadata: () => ({ Format: 'Duration' }) });
  const result = await create(client, { ...STRING_COLUMN, columnType: 'Integer', integerFormat: 'Duration' });
  assert.equal(client.callsTo('postMetadata')[0][1].Format, 'Duration');
  assert.match(client.callsTo('getMetadata')[0][0], /IntegerAttributeMetadata$/);
  assert.match(result.content[0].text, /Stored integer format: Duration/);
});

test('create: a failed read-back does not turn a created column into an error', async () => {
  const client = fakeClient({ getMetadata: () => { throw new Error('Dataverse API Error: boom (Code: 0x1)\nHTTP status: 500'); } });
  const result = await create(client, { ...STRING_COLUMN, format: 'Url' });
  assert.ok(!result.isError);
  assert.match(result.content[0].text, /Stored format could not be read back: Dataverse API Error: boom \(Code: 0x1\)/);
});

function stringAttribute(format) {
  return {
    '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata',
    LogicalName: 'cnt_primaryurl',
    AttributeType: 'String',
    AttributeTypeName: { Value: 'StringType' },
    Format: format,
    FormatName: { Value: format },
    MaxLength: 1000
  };
}

test('update: format changes FormatName and Format, publishes, and reads back', async () => {
  let reads = 0;
  const client = fakeClient({
    getMetadata: () => (++reads === 1 ? stringAttribute('Text') : { FormatName: { Value: 'Url' } })
  });
  const result = await registerTools([updateColumnTool], client).call('update_dataverse_column', {
    entityLogicalName: 'cnt_resource',
    logicalName: 'cnt_primaryurl',
    format: 'Url'
  });

  const [endpoint, body, headers] = client.callsTo('putMetadata')[0];
  assert.equal(endpoint, "EntityDefinitions(LogicalName='cnt_resource')/Attributes(LogicalName='cnt_primaryurl')");
  assert.deepEqual(body.FormatName, { Value: 'Url' });
  assert.equal(body.Format, 'Url');
  assert.deepEqual(headers, { 'MSCRM.MergeLabels': 'true' });
  assert.equal(client.callsTo('callAction')[0][0], 'PublishXml');
  assert.deepEqual(client.callsTo('getMetadata')[1][2], { Consistency: 'Strong' });
  assert.match(result.content[0].text, /Stored format: Url/);
});

test('update: format is refused on a Memo column', async () => {
  const client = fakeClient({
    getMetadata: () => ({ '@odata.type': '#Microsoft.Dynamics.CRM.MemoAttributeMetadata', AttributeType: 'Memo', AttributeTypeName: { Value: 'MemoType' } })
  });
  const result = await registerTools([updateColumnTool], client).call('update_dataverse_column', {
    entityLogicalName: 'cnt_resource',
    logicalName: 'cnt_notes',
    format: 'Url'
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /format can only be updated on a String column/);
  assert.equal(client.callsTo('putMetadata').length, 0);
});
