import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelationshipTool } from '../../build/tools/relationship-tools.js';
import { fakeClient, registerTools } from './helpers/fake-tools.mjs';

const ONE_TO_MANY = {
  relationshipType: 'OneToMany',
  schemaName: 'cnt_resource_environment',
  referencedEntity: 'cnt_environment',
  referencingEntity: 'cnt_resource',
  referencingAttributeLogicalName: 'cnt_environmentid',
  referencingAttributeSchemaName: 'cnt_environmentid',
  referencingAttributeDisplayName: 'Environment'
};

async function lookupDefinition(args) {
  const client = fakeClient({ postMetadata: () => '' });
  const result = await registerTools([createRelationshipTool], client).call('create_dataverse_relationship', args);
  assert.ok(!result.isError, result.content[0].text);
  return client.callsTo('postMetadata')[0][1].Lookup;
}

test('the lookup column can be created required and with a description', async () => {
  const lookup = await lookupDefinition({
    ...ONE_TO_MANY,
    referencingAttributeRequiredLevel: 'ApplicationRequired',
    referencingAttributeDescription: 'Environment the resource runs in'
  });
  assert.equal(lookup.RequiredLevel.Value, 'ApplicationRequired');
  assert.equal(lookup.RequiredLevel.ManagedPropertyLogicalName, 'canmodifyrequirementlevelsettings');
  assert.equal(lookup.Description.LocalizedLabels[0].Label, 'Environment the resource runs in');
});

test('without the new parameters the lookup is optional and has no description, as before', async () => {
  const lookup = await lookupDefinition(ONE_TO_MANY);
  assert.equal(lookup.RequiredLevel.Value, 'None');
  assert.equal('Description' in lookup, false);
});
