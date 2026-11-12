import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDataverseRecordTool,
  queryDataverseRecordsTool,
  buildODataQuery,
  buildRecordKey,
  relativeNextLink,
  parseFetchXmlPagingCookie
} from '../../build/tools/record-read-tools.js';
import { fakeClient, registerTools } from './helpers/fake-tools.mjs';

const ENV = 'https://contoso.api.crm4.dynamics.com';
const ID = '00000000-0000-0000-0000-0000000000a1';

function tools(client) {
  return registerTools([getDataverseRecordTool, queryDataverseRecordsTool], client);
}

function payload(result) {
  const text = result.content[0].text;
  return JSON.parse(text.slice(text.indexOf('\n\n') + 2));
}

test('buildODataQuery encodes values and keeps option names', () => {
  assert.equal(
    buildODataQuery({ select: ['name', 'accountid'], filter: "contains(name,'A&B') and statecode eq 0", orderby: 'name asc', top: 5, count: true }),
    `?$select=name%2Caccountid&$filter=${encodeURIComponent("contains(name,'A&B') and statecode eq 0")}&$orderby=name%20asc&$top=5&$count=true`
  );
  assert.equal(buildODataQuery({}), '');
  assert.equal(buildODataQuery({ select: [] }), '');
});

test('buildRecordKey builds GUID and alternate-key segments', () => {
  assert.equal(buildRecordKey(ID, undefined), `(${ID})`);
  assert.equal(buildRecordKey(undefined, { accountnumber: "O'Neil", priority: 5 }), `(accountnumber=${encodeURIComponent("'O''Neil'")},priority=5)`);
  assert.throws(() => buildRecordKey(undefined, { 'bad/name': 'x' }), /not a valid column/);
});

test('relativeNextLink accepts only links to the active environment Web API', () => {
  assert.equal(
    relativeNextLink(`${ENV}/api/data/v9.2/accounts?$select=name&$skiptoken=abc`, ENV, 'accounts'),
    'accounts?$select=name&$skiptoken=abc'
  );
  assert.throws(() => relativeNextLink('https://evil.example.com/api/data/v9.2/accounts', ENV, 'accounts'), /active environment/);
  assert.throws(() => relativeNextLink(`${ENV}/other/accounts`, ENV, 'accounts'), /active environment/);
  assert.throws(() => relativeNextLink(`${ENV}/api/data/v9.2/contacts?x=1`, ENV, 'accounts'), /does not belong/);
  assert.throws(() => relativeNextLink('not a url', ENV, 'accounts'), /absolute/);
});

test('parseFetchXmlPagingCookie decodes the doubly encoded cookie', () => {
  const inner = '<cookie page="1"><accountid last="{A}" first="{B}" /></cookie>';
  const annotation = `<cookie pagenumber="2" pagingcookie="${encodeURIComponent(encodeURIComponent(inner))}" istracking="False" />`;
  assert.deepEqual(parseFetchXmlPagingCookie(annotation), { pagingCookie: inner, nextPage: 2 });
  assert.equal(parseFetchXmlPagingCookie(undefined), null);
});

test('get_dataverse_record reads by GUID with select, expand and annotations', async () => {
  const client = fakeClient({
    get: () => ({ '@odata.context': 'ctx', '@odata.etag': 'W/"1"', accountid: ID, name: 'Contoso', statecode: 0, 'statecode@OData.Community.Display.V1.FormattedValue': 'Active' })
  });
  const result = await tools(client).call('get_dataverse_record', { entitySetName: 'accounts', recordId: ID, select: ['name', 'statecode'], expand: 'primarycontactid($select=fullname)' });
  assert.ok(!result.isError, result.content[0].text);
  const [endpoint, params, headers] = client.callsTo('get')[0];
  assert.equal(endpoint, `accounts(${ID})?$select=name%2Cstatecode&$expand=${encodeURIComponent('primarycontactid($select=fullname)')}`);
  assert.equal(params, undefined);
  assert.equal(headers.Prefer, 'odata.include-annotations="*"');
  const record = payload(result);
  assert.equal(record['statecode@OData.Community.Display.V1.FormattedValue'], 'Active');
  assert.equal(record['@odata.etag'], undefined);
  assert.equal(record['@odata.context'], undefined);
});

test('get_dataverse_record drops annotations when formatted values are off', async () => {
  const client = fakeClient({ get: () => ({ name: 'Contoso', 'name@x': 'y', primarycontactid: { fullname: 'A', 'fullname@x': 'z' } }) });
  const result = await tools(client).call('get_dataverse_record', { entitySetName: 'accounts', alternateKey: { accountnumber: 'A-1' }, includeFormattedValues: false });
  assert.deepEqual(payload(result), { name: 'Contoso', primarycontactid: { fullname: 'A' } });
  assert.equal(client.callsTo('get')[0][0], `accounts(accountnumber=${encodeURIComponent("'A-1'")})`);
});

test('get_dataverse_record needs exactly one of recordId and alternateKey', async () => {
  const client = fakeClient();
  for (const args of [{}, { recordId: ID, alternateKey: { accountnumber: 'A' } }, { alternateKey: {} }]) {
    const result = await tools(client).call('get_dataverse_record', { entitySetName: 'accounts', ...args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exactly one of recordId or alternateKey/);
  }
  assert.equal(client.callsTo('get').length, 0);
});

test('get_dataverse_record rejects entity-set names with path characters', async () => {
  await assert.rejects(() => tools(fakeClient()).call('get_dataverse_record', { entitySetName: 'accounts/../x', recordId: ID }));
  await assert.rejects(() => tools(fakeClient()).call('get_dataverse_record', { entitySetName: 'https://evil', recordId: ID }));
});

test('query_dataverse_records follows nextLink until maxRecords and returns the next link', async () => {
  const pages = [
    { value: [{ n: 1 }, { n: 2 }], '@odata.count': 7, '@odata.nextLink': `${ENV}/api/data/v9.2/accounts?$select=name&$skiptoken=p2` },
    { value: [{ n: 3 }, { n: 4 }], '@odata.nextLink': `${ENV}/api/data/v9.2/accounts?$select=name&$skiptoken=p3` }
  ];
  const client = fakeClient({ get: () => pages.shift() });
  const result = await tools(client).call('query_dataverse_records', { entitySetName: 'accounts', select: ['name'], count: true, maxRecords: 4 });
  assert.ok(!result.isError, result.content[0].text);
  const calls = client.callsTo('get');
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'accounts?$select=name&$count=true');
  assert.equal(calls[0][2].Prefer, 'odata.maxpagesize=4,odata.include-annotations="*"');
  assert.equal(calls[1][0], 'accounts?$select=name&$skiptoken=p2');
  assert.equal(calls[1][2].Prefer, 'odata.maxpagesize=2,odata.include-annotations="*"');
  const body = payload(result);
  assert.equal(body.returned, 4);
  assert.equal(body.totalCount, 7);
  assert.equal(body.moreRecords, true);
  assert.equal(body.nextLink, `${ENV}/api/data/v9.2/accounts?$select=name&$skiptoken=p3`);
  assert.deepEqual(body.records.map((r) => r.n), [1, 2, 3, 4]);
  assert.match(result.content[0].text, /^Read 4 record\(s\) from 'accounts'\. Matching rows: 7\. More rows are available/);
});

test('query_dataverse_records stops on the last page', async () => {
  const client = fakeClient({ get: () => ({ value: [{ n: 1 }] }) });
  const body = payload(await tools(client).call('query_dataverse_records', { entitySetName: 'accounts' }));
  assert.equal(body.moreRecords, false);
  assert.equal(body.nextLink, undefined);
  assert.equal(client.callsTo('get')[0][2].Prefer, 'odata.maxpagesize=50,odata.include-annotations="*"');
});

test('query_dataverse_records continues from a nextLink', async () => {
  const client = fakeClient({ get: () => ({ value: [{ n: 9 }] }) });
  const result = await tools(client).call('query_dataverse_records', { entitySetName: 'accounts', nextLink: `${ENV}/api/data/v9.2/accounts?$skiptoken=x` });
  assert.ok(!result.isError);
  assert.equal(client.callsTo('get')[0][0], 'accounts?$skiptoken=x');
});

test('query_dataverse_records refuses a nextLink to another host', async () => {
  const client = fakeClient();
  const result = await tools(client).call('query_dataverse_records', { entitySetName: 'accounts', nextLink: 'https://evil.example.com/api/data/v9.2/accounts' });
  assert.equal(result.isError, true);
  assert.equal(client.callsTo('get').length, 0);
});

test('query_dataverse_records does not follow a nextLink from Dataverse to another host', async () => {
  const client = fakeClient({ get: () => ({ value: [{ n: 1 }], '@odata.nextLink': 'https://evil.example.com/api/data/v9.2/accounts?$skiptoken=1' }) });
  const result = await tools(client).call('query_dataverse_records', { entitySetName: 'accounts', maxRecords: 5 });
  assert.equal(result.isError, true);
  assert.equal(client.callsTo('get').length, 1);
});

test('query_dataverse_records runs FetchXML and reports its paging cookie', async () => {
  const inner = '<cookie page="1"><accountid last="{A}" /></cookie>';
  const client = fakeClient({
    get: () => ({
      value: [{ name: 'A' }, { name: 'B' }],
      '@Microsoft.Dynamics.CRM.morerecords': true,
      '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie': `<cookie pagenumber="2" pagingcookie="${encodeURIComponent(encodeURIComponent(inner))}" istracking="False" />`
    })
  });
  const fetchXml = '<fetch count="2"><entity name="account"><attribute name="name" /></entity></fetch>';
  const result = await tools(client).call('query_dataverse_records', { entitySetName: 'accounts', fetchXml });
  assert.ok(!result.isError, result.content[0].text);
  const [endpoint, , headers] = client.callsTo('get')[0];
  assert.equal(endpoint, `accounts?fetchXml=${encodeURIComponent(fetchXml)}`);
  assert.equal(headers.Prefer, 'odata.include-annotations="*"');
  const body = payload(result);
  assert.equal(body.moreRecords, true);
  assert.equal(body.nextPage, 2);
  assert.equal(body.pagingCookie, inner);
});

test('query_dataverse_records truncates a FetchXML result to maxRecords', async () => {
  const client = fakeClient({ get: () => ({ value: [{ n: 1 }, { n: 2 }, { n: 3 }] }) });
  const result = await tools(client).call('query_dataverse_records', { entitySetName: 'accounts', fetchXml: '<fetch><entity name="account" /></fetch>', maxRecords: 2 });
  const body = payload(result);
  assert.equal(body.returned, 2);
  assert.equal(body.moreRecords, true);
  assert.match(result.content[0].text, /raise maxRecords or narrow the query/);
});

test('query_dataverse_records rejects mixing FetchXML, nextLink and OData options', async () => {
  const client = fakeClient();
  const cases = [
    [{ fetchXml: '<fetch/>', filter: 'statecode eq 0' }, /fetchXml cannot be combined with OData options \(filter\)/],
    [{ nextLink: `${ENV}/api/data/v9.2/accounts?x=1`, select: ['name'] }, /nextLink cannot be combined/],
    [{ fetchXml: '<fetch/>', nextLink: `${ENV}/api/data/v9.2/accounts?x=1` }, /fetchXml or nextLink, not both/]
  ];
  for (const [args, message] of cases) {
    const result = await tools(client).call('query_dataverse_records', { entitySetName: 'accounts', ...args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, message);
  }
  assert.equal(client.callsTo('get').length, 0);
});

test('query_dataverse_records reports Dataverse errors', async () => {
  const client = fakeClient({ get: () => { throw new Error("Dataverse API Error: Could not find a property named 'nme'. (Code: 0x0)"); } });
  const result = await tools(client).call('query_dataverse_records', { entitySetName: 'accounts', select: ['nme'] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Error querying records in 'accounts': Dataverse API Error: Could not find a property named 'nme'/);
});
