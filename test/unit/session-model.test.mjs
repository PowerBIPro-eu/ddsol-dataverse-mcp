// The session model: .dataverse-mcp is the committed project config, the environment is
// chosen per session, and only a "last used here" suggestion is kept per working folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, startServer } from './helpers/mcp-process.mjs';

const SOLUTIONS = {
  contosocore: { uniquename: 'contosocore', friendlyname: 'Contoso Core', publisherid: { uniquename: 'contoso', friendlyname: 'Contoso', customizationprefix: 'cnt' } },
  contosopatch: { uniquename: 'contosopatch', friendlyname: 'Contoso Patch', publisherid: { uniquename: 'contoso', friendlyname: 'Contoso', customizationprefix: 'cnt' } },
  wrongprefix: { uniquename: 'wrongprefix', friendlyname: 'Wrong Prefix', publisherid: { uniquename: 'other', friendlyname: 'Other', customizationprefix: 'xyz' } }
};

let server;
let baseUrl;
let cacheDir;
let DataverseClient;
let WorkspaceState;
let resolveStateDir;

before(async () => {
  server = createServer((req, res) => {
    const url = decodeURIComponent(req.url);
    const match = /uniquename eq '([^']+)'/.exec(url);
    const solution = match && SOLUTIONS[match[1]];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: solution ? [solution] : [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  cacheDir = makeTempDir('dvmcp-cache-');
  process.env.LOCALAPPDATA = cacheDir;
  process.env.HOME = cacheDir;
  process.env.DATAVERSE_MCP_STATE_DIR = join(cacheDir, 'state');
  const { TokenStore } = await import('../../build/auth/token-store.js');
  writeFileSync(new TokenStore(cacheDir).tokenPath('organizations', 'client-a', baseUrl), JSON.stringify({
    access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_at: Date.now() + 3_600_000
  }));
  ({ DataverseClient } = await import('../../build/dataverse-client.js'));
  ({ WorkspaceState, resolveStateDir } = await import('../../build/workspace-state.js'));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  process.chdir(process.env.TEMP || process.env.TMPDIR || '/');
  rmSync(cacheDir, { recursive: true, force: true });
});

// A new DataverseClient in a folder stands in for a new server session in that folder.
function session(workspace, { url = '' } = {}) {
  process.chdir(workspace);
  return new DataverseClient({ dataverseUrl: url, clientId: 'client-a', tenantId: 'organizations', authMode: 'device' });
}

function workspaceWithProject(t, config) {
  const workspace = makeTempDir('dvmcp-project-');
  t.after(() => {
    // Windows cannot delete the current directory of a process.
    process.chdir(cacheDir);
    rmSync(workspace, { recursive: true, force: true });
  });
  if (config) {
    writeFileSync(join(workspace, '.dataverse-mcp'), JSON.stringify(config, null, 2));
  }
  return workspace;
}

function projectFile(workspace) {
  return readFileSync(join(workspace, '.dataverse-mcp'), 'utf8');
}

test('a new session starts without an environment, but suggests the one last used here', async (t) => {
  const workspace = workspaceWithProject(t);
  const first = session(workspace);
  assert.equal(await first.setActiveEnvironment(`${baseUrl}/`), baseUrl);

  const second = session(workspace);
  assert.equal(second.getActiveEnvironment(), '');
  assert.equal(second.getEnvironmentInfo().lastUsedInFolder.url, baseUrl);
  await assert.rejects(second.get('accounts'), (error) => {
    assert.match(error.message, /^No Dataverse environment is selected for this session\. Ask the user/);
    assert.ok(error.message.includes(`Last environment used in this folder: ${baseUrl}`));
    return true;
  });
});

test('DATAVERSE_URL preselects the environment of every session', () => {
  const workspace = makeTempDir('dvmcp-project-');
  const client = session(workspace, { url: baseUrl });
  assert.deepEqual({ url: client.getEnvironmentInfo().url, source: client.getEnvironmentInfo().source }, { url: baseUrl, source: 'DATAVERSE_URL' });
  process.chdir(cacheDir);
  rmSync(workspace, { recursive: true, force: true });
});

test('without .dataverse-mcp, set_solution_context creates a stable project file', async (t) => {
  const workspace = workspaceWithProject(t);
  const client = session(workspace, { url: baseUrl });
  assert.equal(await client.setSolutionContext('contosocore'), 'project-created');
  assert.deepEqual(JSON.parse(projectFile(workspace)), {
    solutionUniqueName: 'contosocore',
    solutionDisplayName: 'Contoso Core',
    publisherUniqueName: 'contoso',
    publisherDisplayName: 'Contoso',
    customizationPrefix: 'cnt'
  });
  assert.ok(projectFile(workspace).endsWith('}\n'));
});

test('another solution is an override for this session only; the project file is untouched', async (t) => {
  const workspace = workspaceWithProject(t, { solutionUniqueName: 'contosocore', customizationPrefix: 'cnt' });
  const before = projectFile(workspace);
  const client = session(workspace, { url: baseUrl });

  assert.equal(await client.setSolutionContext('contosopatch'), 'session-override');
  assert.equal(client.getSolutionUniqueName(), 'contosopatch');
  assert.equal(client.getSolutionContextSource(), 'session');
  assert.equal(projectFile(workspace), before);

  const nextSession = session(workspace, { url: baseUrl });
  assert.equal(nextSession.getSolutionUniqueName(), 'contosocore');
  assert.equal(nextSession.getSolutionContextSource(), 'project');
});

test('saveAsProjectDefault changes the project default', async (t) => {
  const workspace = workspaceWithProject(t, { solutionUniqueName: 'contosocore' });
  const client = session(workspace, { url: baseUrl });
  assert.equal(await client.setSolutionContext('contosopatch', { saveAsProjectDefault: true }), 'project-updated');
  assert.equal(JSON.parse(projectFile(workspace)).solutionUniqueName, 'contosopatch');
});

test('clearing the solution context affects this session only', async (t) => {
  const workspace = workspaceWithProject(t, { solutionUniqueName: 'contosocore' });
  const before = projectFile(workspace);
  const client = session(workspace);
  client.clearSolutionContext();
  assert.equal(client.getSolutionContext(), null);
  assert.equal(client.getSolutionUniqueName(), null);
  assert.equal(projectFile(workspace), before);
  assert.equal(session(workspace).getSolutionUniqueName(), 'contosocore');
});

test('verification loads missing details without rewriting the project file', async (t) => {
  const workspace = workspaceWithProject(t, { solutionUniqueName: 'contosocore' });
  const before = projectFile(workspace);
  const client = session(workspace, { url: baseUrl });
  assert.equal(client.isSolutionContextVerified(), false);
  const verified = await client.verifySolutionContext();
  assert.equal(verified.customizationPrefix, 'cnt');
  assert.equal(client.isSolutionContextVerified(), true);
  assert.equal(projectFile(workspace), before);
});

test('verification refuses a solution whose publisher prefix differs from .dataverse-mcp', async (t) => {
  const workspace = workspaceWithProject(t, { solutionUniqueName: 'wrongprefix', customizationPrefix: 'cnt' });
  const client = session(workspace, { url: baseUrl });
  await assert.rejects(client.verifySolutionContext(), /prefix 'xyz', but \.dataverse-mcp expects 'cnt'/);
  await assert.rejects(client.setSolutionContext('wrongprefix'), /prefix 'xyz', but \.dataverse-mcp expects 'cnt'/);
});

test('verification reports a solution that does not exist in the environment', async (t) => {
  const workspace = workspaceWithProject(t, { solutionUniqueName: 'missing' });
  const client = session(workspace, { url: baseUrl });
  await assert.rejects(client.verifySolutionContext(), /Solution 'missing' from \.dataverse-mcp does not exist in http:\/\/127\.0\.0\.1/);
});

test('files earlier versions wrote into the working folder are migrated', (t) => {
  const workspace = workspaceWithProject(t);
  writeFileSync(join(workspace, '.dataverse-mcp-environment.json'), JSON.stringify({ dataverseUrl: 'https://Contoso.api.crm4.dynamics.com/' }));
  writeFileSync(join(workspace, '.dataverse-mcp-pending-org.json'), JSON.stringify({ device_code: 'x' }));
  writeFileSync(join(workspace, '.dataverse-mcp-pending-globaldisco.json'), JSON.stringify({ device_code: 'y' }));

  const client = session(workspace);
  for (const name of ['.dataverse-mcp-environment.json', '.dataverse-mcp-pending-org.json', '.dataverse-mcp-pending-globaldisco.json']) {
    assert.ok(!existsSync(join(workspace, name)), `${name} should be gone`);
  }
  const info = client.getEnvironmentInfo();
  assert.equal(info.url, null, 'the old selection must not be applied automatically');
  assert.equal(info.lastUsedInFolder.url, 'https://contoso.api.crm4.dynamics.com');
});

test('working-folder state lives outside the folder, one directory per folder', () => {
  assert.equal(resolveStateDir({ DATAVERSE_MCP_STATE_DIR: join(cacheDir, 'custom') }), join(cacheDir, 'custom'));
  const a = new WorkspaceState(join(cacheDir, 'project-a'), join(cacheDir, 'state'));
  const b = new WorkspaceState(join(cacheDir, 'project-b'), join(cacheDir, 'state'));
  const again = new WorkspaceState(join(cacheDir, 'project-a'), join(cacheDir, 'state'));
  assert.notEqual(a.folderStateDir, b.folderStateDir);
  assert.equal(a.folderStateDir, again.folderStateDir);
  assert.ok(a.folderStateDir.startsWith(join(cacheDir, 'state', 'workspaces', 'project-a-')));
});

test('solution and environment tools report the session model through MCP', async (t) => {
  const workspace = workspaceWithProject(t, {
    solutionUniqueName: 'contosocore', solutionDisplayName: 'Contoso Core',
    publisherUniqueName: 'contoso', publisherDisplayName: 'Contoso', customizationPrefix: 'cnt'
  });
  const mcp = startServer({ cwd: workspace });
  try {
    await mcp.initialize();
    const context = (await mcp.callTool('get_solution_context')).content[0].text;
    // The plugin's hook guard parses these exact phrases.
    assert.equal(/Current solution context:\s*'([^']+)'/i.exec(context)?.[1], 'contosocore');
    assert.equal(/Prefix:\s*([A-Za-z0-9]+)/.exec(context)?.[1], 'cnt');
    assert.match(context, /Source: project default \(\.dataverse-mcp\)/);
    assert.match(context, /Not verified yet: no environment is selected for this session\./);

    const environment = (await mcp.callTool('get_active_dataverse_environment')).content[0].text;
    assert.match(environment, /^Active Dataverse environment: \(none selected for this session\)/);

    const cleared = (await mcp.callTool('clear_solution_context')).content[0].text;
    assert.match(cleared, /^Solution context cleared for this session\. Previously set to 'contosocore'\./);
    assert.match(cleared, /The project default in \.dataverse-mcp \('contosocore'\) is unchanged/);
    const none = (await mcp.callTool('get_solution_context')).content[0].text;
    assert.match(none, /^No solution context is currently set\./);
    assert.ok(existsSync(join(workspace, '.dataverse-mcp')));
  } finally {
    await mcp.close();
  }
});
