// Live read-only test of get_dataverse_record and query_dataverse_records against a Dataverse
// environment. Starts the built server (build/index.js) over stdio with the MCP SDK client and
// reuses the cached device sign-in. Nothing is written to Dataverse.
//
//   npm run build
//   DATAVERSE_URL=https://<org>.api.crm4.dynamics.com node test/test-records-read-live.mjs

import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATAVERSE_URL) {
  console.error("Set DATAVERSE_URL to the environment to read from.");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve(here, "..", "build", "index.js")],
  cwd: process.env.DATAVERSE_MCP_CWD || process.cwd(),
  env: { ...process.env, DATAVERSE_CLIENT_ID: process.env.DATAVERSE_CLIENT_ID || "51f81489-12ee-4a9e-aaae-a2591f45987d", DATAVERSE_AUTH_MODE: "device" },
  stderr: "pipe"
});
transport.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
const client = new Client({ name: "records-read-live-test", version: "0.0.1" });
await client.connect(transport);

async function call(name, args, { expectError = false } = {}) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
  console.log(`\n### ${name} ${JSON.stringify(args).slice(0, 200)} (${Date.now() - started} ms)${result.isError ? " [ERROR]" : ""}\n${text.length > 1500 ? `${text.slice(0, 1500)}\n...(${text.length} chars)` : text}`);
  assert.equal(!!result.isError, expectError, `${name} ${expectError ? "should have failed" : "failed"}: ${text}`);
  return text;
}
const json = (text) => JSON.parse(text.slice(text.indexOf("\n\n") + 2));
let passed = 0;
async function check(label, body) {
  await body();
  passed++;
  console.log(`--> PASS ${label}`);
}

try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  await check("both tools are listed and read-only", async () => {
    for (const name of ["get_dataverse_record", "query_dataverse_records"]) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} missing from ${names.length} tools`);
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
  });

  let firstPage;
  await check("OData query with select, filter, orderby, count and formatted values", async () => {
    firstPage = json(await call("query_dataverse_records", {
      entitySetName: "solutions",
      select: ["uniquename", "friendlyname", "ismanaged", "createdon"],
      filter: "isvisible eq true",
      orderby: "uniquename asc",
      count: true,
      maxRecords: 3
    }));
    assert.equal(firstPage.returned, 3);
    assert.ok(firstPage.totalCount > 3);
    assert.equal(firstPage.moreRecords, true);
    assert.ok(firstPage.nextLink.startsWith(process.env.DATAVERSE_URL.replace(/\/$/, "")));
    assert.ok("ismanaged@OData.Community.Display.V1.FormattedValue" in firstPage.records[0]);
    assert.ok(!("@odata.etag" in firstPage.records[0]));
  });

  await check("nextLink continues where the first page stopped", async () => {
    const second = json(await call("query_dataverse_records", { entitySetName: "solutions", nextLink: firstPage.nextLink, maxRecords: 3 }));
    assert.equal(second.returned, 3);
    assert.ok(second.records[0].uniquename.localeCompare(firstPage.records[2].uniquename, "en", { sensitivity: "base" }) >= 0);
    const seen = new Set(firstPage.records.map((r) => r.solutionid));
    assert.ok(second.records.every((r) => !seen.has(r.solutionid)));
  });

  await check("one call follows several pages internally", async () => {
    // The page size equals maxRecords, so force paging by reading more rows than one page holds.
    const all = json(await call("query_dataverse_records", { entitySetName: "solutions", select: ["uniquename"], maxRecords: Math.min(firstPage.totalCount, 12) }));
    assert.equal(all.returned, Math.min(firstPage.totalCount, 12));
  });

  await check("get_dataverse_record by GUID", async () => {
    const id = firstPage.records[0].solutionid;
    const record = json(await call("get_dataverse_record", { entitySetName: "solutions", recordId: id, select: ["uniquename", "version"], expand: "publisherid($select=customizationprefix)" }));
    assert.equal(record.uniquename, firstPage.records[0].uniquename);
    assert.ok(record.publisherid?.customizationprefix !== undefined);
  });

  await check("get_dataverse_record by alternate key (EntityDefinitions LogicalName)", async () => {
    const record = json(await call("get_dataverse_record", { entitySetName: "EntityDefinitions", alternateKey: { LogicalName: "account" }, select: ["SchemaName", "EntitySetName"] }));
    assert.equal(record.SchemaName, "Account");
    assert.equal(record.EntitySetName, "accounts");
  });

  await check("FetchXML with paging cookie, then page 2", async () => {
    const fetchXml = '<fetch count="2" returntotalrecordcount="true"><entity name="solution"><attribute name="uniquename" /><order attribute="uniquename" /></entity></fetch>';
    const page1 = json(await call("query_dataverse_records", { entitySetName: "solutions", fetchXml }));
    assert.equal(page1.returned, 2);
    assert.equal(page1.moreRecords, true);
    assert.equal(page1.nextPage, 2);
    assert.ok(page1.pagingCookie.startsWith("<cookie"));
    const escaped = page1.pagingCookie.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const page2 = json(await call("query_dataverse_records", { entitySetName: "solutions", fetchXml: fetchXml.replace('<fetch count="2"', `<fetch count="2" page="2" paging-cookie="${escaped}"`) }));
    assert.equal(page2.returned, 2);
    assert.ok(page2.records.every((r) => !page1.records.some((p) => p.solutionid === r.solutionid)));
  });

  await check("$apply aggregation", async () => {
    const result = json(await call("query_dataverse_records", { entitySetName: "solutions", apply: "groupby((ismanaged),aggregate($count as total))" }));
    assert.ok(result.returned >= 1);
    assert.ok(result.records.every((r) => typeof r.total === "number"));
  });

  await check("a wrong column name returns the Dataverse error", async () => {
    const text = await call("query_dataverse_records", { entitySetName: "solutions", select: ["notacolumn"] }, { expectError: true });
    assert.match(text, /notacolumn/);
  });

  await check("a missing record returns the Dataverse error", async () => {
    await call("get_dataverse_record", { entitySetName: "solutions", recordId: "00000000-0000-0000-0000-000000000001" }, { expectError: true });
  });

  await check("a nextLink to another host is refused", async () => {
    const text = await call("query_dataverse_records", { entitySetName: "solutions", nextLink: "https://example.com/api/data/v9.2/solutions?$skiptoken=1" }, { expectError: true });
    assert.match(text, /active environment/);
  });

  console.log(`\nAll ${passed} live checks passed.`);
} finally {
  await client.close();
}
