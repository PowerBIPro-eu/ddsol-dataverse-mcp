import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRolePrivilegesTool } from '../../build/tools/role-tools.js';
import { fakeClient, registerTools } from './helpers/fake-tools.mjs';

const ROLE_ID = '99999999-0000-0000-0000-000000000000';
const EXPANSION = {
  roleprivileges_association: [
    { privilegeid: 'p1', name: 'prvReadCnt_Resource' },
    { privilegeid: 'p2', name: 'prvCreateCnt_Resource' }
  ]
};

function privilegesFrom(result) {
  const text = result.content[0].text;
  return JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
}

async function call(get) {
  const client = fakeClient({ get });
  const result = await registerTools([getRolePrivilegesTool], client).call('get_role_privileges', { roleId: ROLE_ID });
  return { client, result };
}

test('each privilege is listed with its access depth', async () => {
  const { client, result } = await call((endpoint) => {
    assert.equal(endpoint, `RetrieveRolePrivilegesRole(RoleId=${ROLE_ID})`);
    return {
      RolePrivileges: [
        { PrivilegeId: 'p1', PrivilegeName: 'prvReadCnt_Resource', Depth: 'Global' },
        { PrivilegeId: 'p2', PrivilegeName: 'prvCreateCnt_Resource', Depth: 'Basic' }
      ]
    };
  });
  assert.deepEqual(privilegesFrom(result), [
    { privilegeId: 'p2', privilegeName: 'prvCreateCnt_Resource', depth: 'Basic' },
    { privilegeId: 'p1', privilegeName: 'prvReadCnt_Resource', depth: 'Global' }
  ]);
  assert.equal(client.callsTo('get').length, 1, 'names were present, no second call needed');
});

test('numeric depths are named and missing names come from the role expansion', async () => {
  const { result } = await call((endpoint) => endpoint.startsWith('RetrieveRolePrivilegesRole')
    ? { RolePrivileges: [{ PrivilegeId: 'p1', Depth: 2 }] }
    : EXPANSION);
  assert.deepEqual(privilegesFrom(result), [{ privilegeId: 'p1', privilegeName: 'prvReadCnt_Resource', depth: 'Deep' }]);
});

test('if the depth cannot be retrieved, the names are still returned with a note', async () => {
  const { result } = await call((endpoint) => {
    if (endpoint.startsWith('RetrieveRolePrivilegesRole')) {
      throw new Error('Dataverse API Error: Not supported. (Code: 0x1)\nHTTP status: 400');
    }
    return EXPANSION;
  });
  assert.ok(!result.isError);
  assert.deepEqual(privilegesFrom(result).map((privilege) => privilege.privilegeName), ['prvCreateCnt_Resource', 'prvReadCnt_Resource']);
  assert.match(result.content[0].text, /Access depth could not be retrieved: Dataverse API Error: Not supported\. \(Code: 0x1\)$/);
});
