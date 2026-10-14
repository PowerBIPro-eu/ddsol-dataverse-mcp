// Live end-to-end test of the business process flow tools against a Dataverse environment.
//
// Starts the built MCP server (build/index.js) over stdio, exactly like the plugin does, and
// drives it with the MCP SDK client. It reuses the cached device sign-in and the persisted
// solution context / environment of the folder given in DATAVERSE_MCP_CWD (defaults to cwd).
//
//   npm run build
//   DATAVERSE_MCP_CWD="C:/path/with/.dataverse-mcp" node test/test-bpf-live.mjs
//
// Optional: BPF_TEST_TABLE=<logical name of an existing BPF-enabled table> to skip creating one.
// Everything the test creates (table, process, generated BPF table) is deleted at the end.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverCwd = process.env.DATAVERSE_MCP_CWD || process.cwd();
const clientId = process.env.DATAVERSE_CLIENT_ID || "51f81489-12ee-4a9e-aaae-a2591f45987d";
const callTimeoutMs = Number(process.env.BPF_TEST_TIMEOUT_MS || 300000);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve(here, "..", "build", "index.js")],
  cwd: serverCwd,
  env: { ...process.env, DATAVERSE_CLIENT_ID: clientId, DATAVERSE_AUTH_MODE: "device" },
  stderr: "pipe"
});
transport.stderr?.on("data", chunk => process.stderr.write(`[server] ${chunk}`));

const client = new Client({ name: "bpf-live-test", version: "0.0.1" });
await client.connect(transport);

const log = [];
function note(line) {
  console.log(line);
  log.push(line);
}

async function call(name, args, { allowError = false } = {}) {
  const started = Date.now();
  let timer;
  const result = await Promise.race([
    client.callTool({ name, arguments: args }, undefined, { timeout: callTimeoutMs }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out after ${callTimeoutMs} ms`)), callTimeoutMs); })
  ]).finally(() => clearTimeout(timer));
  const text = (result.content ?? []).map(c => c.text ?? "").join("\n");
  note(`\n### ${name} (${Date.now() - started} ms)${result.isError ? " [ERROR]" : ""}\n${text.length > 3000 ? `${text.slice(0, 3000)}\n...(${text.length} chars)` : text}`);
  if (result.isError && !allowError) throw new Error(`${name} failed: ${text}`);
  return { text, isError: !!result.isError };
}

// Metadata of a freshly generated table can lag behind for a while; retry until it is readable.
async function callUntil(name, args, predicate, { attempts = 12, delayMs = 10000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await call(name, args, { allowError: true });
    if (predicate(last)) return last;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return last;
}

const cleanup = [];
let failed = false;
let createdTable = null;
let workflowId = null;

try {
  const tools = await client.listTools();
  const names = tools.tools.map(t => t.name);
  const expected = ["create_business_process_flow", "get_business_process_flow", "list_business_process_flows", "update_business_process_flow", "activate_business_process_flow", "deactivate_business_process_flow", "delete_business_process_flow", "list_business_process_flow_stages", "build_business_process_flow_xaml"];
  const missing = expected.filter(n => !names.includes(n));
  if (missing.length) throw new Error(`Server does not expose: ${missing.join(", ")}`);
  note(`Server exposes ${names.length} tools including all ${expected.length} BPF tools.`);

  const env = await call("get_active_dataverse_environment", {});
  const ctx = await call("get_solution_context", {});
  const prefix = /"customizationPrefix":\s*"([a-z0-9]+)"/i.exec(ctx.text)?.[1] ?? /prefix[^a-z0-9]*([a-z0-9]+)/i.exec(ctx.text)?.[1];
  if (!prefix) throw new Error("Could not determine the customization prefix from get_solution_context.");
  note(`Prefix: ${prefix}; environment: ${/https?:\/\/[^\s"']+/.exec(env.text)?.[0] ?? "?"}`);

  // 1. Test table (BPF-enabled)
  let table = process.env.BPF_TEST_TABLE;
  if (!table) {
    table = `${prefix}_bpflivetesttable`;
    const existing = await call("get_dataverse_table", { logicalName: table }, { allowError: true });
    if (existing.isError) {
      await call("create_dataverse_table", {
        displayName: "BPF Live Test Table",
        displayCollectionName: "BPF Live Test Tables",
        logicalName: table,
        schemaName: table,
        description: "Temporary table created by test/test-bpf-live.mjs; safe to delete.",
        primaryNameDisplayName: "Name",
        primaryNameLogicalName: `${prefix}_name`,
        primaryNameSchemaName: `${prefix}_name`,
        isBusinessProcessEnabled: true
      });
      createdTable = table;
      cleanup.push(async () => call("delete_dataverse_table", { logicalName: table }, { allowError: true }));
    } else {
      if (/test-bpf-live/.test(existing.text)) {
        note(`Adopting leftover table ${table} from an earlier run; it will be deleted at the end.`);
        createdTable = table;
        cleanup.push(async () => call("delete_dataverse_table", { logicalName: table }, { allowError: true }));
      }
      if (!/"IsBusinessProcessEnabled":\s*true/.test(existing.text)) {
        await call("update_dataverse_table", { logicalName: table, isBusinessProcessEnabled: true });
      }
    }
  }
  const tableInfo = await callUntil("get_dataverse_table", { logicalName: table }, r => !r.isError);
  if (tableInfo.isError || !/"IsBusinessProcessEnabled":\s*true/.test(tableInfo.text)) throw new Error(`Table ${table} is not readable or not BPF-enabled.`);
  const nameColumn = /"PrimaryNameAttribute":\s*"([^"]+)"/.exec(tableInfo.text)?.[1] ?? `${prefix}_name`;

  // 2. Negative check: disabling must be rejected (one-way flag)
  const disable = await call("update_dataverse_table", { logicalName: table, isBusinessProcessEnabled: false }, { allowError: true });
  if (!disable.isError) throw new Error("update_dataverse_table accepted isBusinessProcessEnabled: false on an enabled table.");

  // 3. Build XAML only (no write)
  const uniqueName = `${prefix}_bpflivetest`;
  const twoStages = {
    segments: [{
      entity: table,
      stages: [
        { name: "Intake", category: "Identify", steps: [{ column: nameColumn, required: true }, { column: "statuscode" }], branches: [{ column: "statuscode", value: 1, nextStage: "Done", label: "Still active" }] },
        { name: "Done", category: "Close", steps: [{ column: nameColumn, label: "Final name" }] }
      ]
    }]
  };
  const built = await call("build_business_process_flow_xaml", { definition: twoStages });
  if (!/<Activity x:Class="XrmWorkflow[0-9a-f]{32}"/.test(built.text)) throw new Error("build_business_process_flow_xaml did not return XAML.");

  // 4. Create (from definition), read back, list
  const before = await call("list_business_process_flows", { primaryEntity: table });
  if (before.text.includes(`"uniquename": "${uniqueName}"`)) throw new Error(`Leftover process ${uniqueName} exists; delete it first.`);
  const created = await call("create_business_process_flow", {
    name: "BPF Live Test",
    uniqueName,
    primaryEntity: table,
    definition: twoStages,
    description: "Temporary process created by test/test-bpf-live.mjs",
    processOrder: 999
  });
  workflowId = /workflowid ([0-9a-f-]{36})/i.exec(created.text)?.[1];
  if (!workflowId) throw new Error("Could not read the workflowid from create_business_process_flow.");
  cleanup.push(async () => {
    await call("deactivate_business_process_flow", { workflowId }, { allowError: true });
    await call("delete_business_process_flow", { workflowId, confirmDelete: true }, { allowError: true });
  });

  const got = await call("get_business_process_flow", { workflowId, includeXaml: false });
  if (!/"statecode":\s*0/.test(got.text)) throw new Error("New process is not in Draft state.");
  const byName = await call("get_business_process_flow", { uniqueName, includeXaml: true });
  if (!byName.text.includes(`XrmWorkflow${workflowId.replace(/-/g, "")}`)) throw new Error("Stored XAML does not embed the workflowid.");
  const listed = await call("list_business_process_flows", { primaryEntity: table, includeManaged: false });
  if (!listed.text.includes(workflowId)) throw new Error("list_business_process_flows does not list the new process.");

  const draftStages = await call("list_business_process_flow_stages", { workflowId });
  note(draftStages.text.includes("Found 0 stage") ? "Draft process has no processstage rows yet (expected)." : "Draft process already has processstage rows.");

  // 5. Activate -> generated table + stages
  const activated = await call("activate_business_process_flow", { workflowId });
  if (!activated.text.includes(`Generated BPF table: ${uniqueName}`)) throw new Error("Activation did not report the generated BPF table.");
  const activeStages = await call("list_business_process_flow_stages", { workflowId });
  if (!activeStages.text.includes("Found 2 stage")) throw new Error("Expected 2 processstage rows after activation.");
  const bpfTable = await callUntil("get_dataverse_table", { logicalName: uniqueName }, r => !r.isError);
  if (bpfTable.isError || !/"IsBPFEntity":\s*true/.test(bpfTable.text)) throw new Error("Generated table is not readable or not flagged IsBPFEntity.");

  // 6. Update while active must be rejected
  const rejected = await call("update_business_process_flow", { workflowId, definition: twoStages }, { allowError: true });
  if (!rejected.isError || !/Draft/.test(rejected.text)) throw new Error("update_business_process_flow accepted a definition change on an active process.");
  await call("update_business_process_flow", { workflowId, description: "Updated description while active" });

  // 7. Deactivate, update definition (3 stages), reactivate
  await call("deactivate_business_process_flow", { workflowId });
  const threeStages = {
    segments: [{
      entity: table,
      stages: [
        { name: "Intake", category: "Identify", steps: [{ column: nameColumn, required: true }] },
        { name: "Review", category: "Research", steps: [{ column: "statuscode" }] },
        { name: "Done", category: "Close", steps: [{ column: nameColumn, label: "Final name" }] }
      ]
    }]
  };
  await call("update_business_process_flow", { workflowId, name: "BPF Live Test (updated)", definition: threeStages });
  const reactivated = await call("activate_business_process_flow", { workflowId });
  if (!reactivated.text.includes(`Generated BPF table: ${uniqueName}`)) throw new Error("Re-activation did not report the BPF table.");
  const stagesAfter = await call("list_business_process_flow_stages", { workflowId });
  if (!stagesAfter.text.includes("Found 3 stage")) throw new Error("Expected 3 processstage rows after re-activation.");

  // 8. Delete must be rejected while active, then deactivate + delete
  const deleteActive = await call("delete_business_process_flow", { workflowId, confirmDelete: true }, { allowError: true });
  if (!deleteActive.isError) throw new Error("delete_business_process_flow deleted an active process.");
  await call("deactivate_business_process_flow", { workflowId });
  await call("delete_business_process_flow", { workflowId, confirmDelete: true });
  cleanup.pop();
  const gone = await call("get_business_process_flow", { workflowId }, { allowError: true });
  if (!gone.isError) throw new Error("Process still exists after delete.");
  const tableGone = await callUntil("get_dataverse_table", { logicalName: uniqueName }, r => r.isError, { attempts: 6 });
  note(tableGone.isError ? `Generated table ${uniqueName} is gone after deleting the process.` : `NOTE: generated table ${uniqueName} still exists after deleting the process.`);
} catch (error) {
  failed = true;
  note(`\nLIVE TEST FAILED: ${error.message}`);
} finally {
  for (const step of cleanup.reverse()) {
    try { await step(); } catch (error) { note(`cleanup error: ${error.message}`); }
  }
  await client.close();
}

note(`\n${failed ? "LIVE TEST FAILED" : "LIVE TEST PASSED"}${createdTable ? ` (temporary table ${createdTable} created and deleted)` : ""}`);
process.exit(failed ? 1 : 0);
