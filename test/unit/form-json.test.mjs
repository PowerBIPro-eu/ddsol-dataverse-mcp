import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFormTool } from '../../build/tools/form-tools.js';
import { fakeClient, registerTools } from './helpers/fake-tools.mjs';

const FORM = { formid: 'f1', name: 'Main', formxml: '<form/>', formjson: '{"huge":true}' };

test('formjson is omitted by default and the result says so', async () => {
  const client = fakeClient({ get: () => ({ ...FORM }) });
  const result = await registerTools([getFormTool], client).call('get_dataverse_form', { formId: 'f1' });
  const text = result.content[0].text;
  assert.match(text, /"formxml": "<form\/>"/);
  assert.doesNotMatch(text, /"formjson"/);
  assert.match(text, /formjson omitted; pass includeFormJson: true to include it\./);
});

test('includeFormJson returns the full record', async () => {
  const client = fakeClient({ get: () => ({ ...FORM }) });
  const result = await registerTools([getFormTool], client).call('get_dataverse_form', { formId: 'f1', includeFormJson: true });
  assert.match(result.content[0].text, /"formjson": "\{\\"huge\\":true\}"/);
  assert.doesNotMatch(result.content[0].text, /formjson omitted/);
});
