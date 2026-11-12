import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";

// Read-only access to Dataverse rows: one record by ID or alternate key, or a query by
// OData options or FetchXML. Every request is a GET against the active environment.

const WEB_API_PATH = "/api/data/v9.2/";
const MAXIMUM_PAGE_SIZE = 5000;
const DEFAULT_MAX_RECORDS = 50;

/** Collection annotations (paging cookie, more records) and per-row formatted values and lookup details. */
const ALL_ANNOTATIONS = 'odata.include-annotations="*"';

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const entitySetNameSchema = z.string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Use a Dataverse entity-set name without URL path characters.")
  .max(128);

const columnNameSchema = z.string()
  .regex(identifierPattern, "Use a column logical name without URL path characters.")
  .max(128);

export interface RecordQueryOptions {
  select?: string[];
  filter?: string;
  orderby?: string;
  expand?: string;
  top?: number;
  count?: boolean;
  apply?: string;
}

/** Builds the query string of an OData query. Values are percent-encoded; option names are not. */
export function buildODataQuery(options: RecordQueryOptions): string {
  const parts: string[] = [];
  const add = (name: string, value: string | undefined) => {
    if (value !== undefined && value !== "") {
      parts.push(`${name}=${encodeURIComponent(value)}`);
    }
  };
  add("$select", options.select && options.select.length > 0 ? options.select.join(",") : undefined);
  add("$filter", options.filter);
  add("$orderby", options.orderby);
  add("$expand", options.expand);
  add("$apply", options.apply);
  add("$top", options.top !== undefined ? String(options.top) : undefined);
  if (options.count) {
    parts.push("$count=true");
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/** The key segment of a record URL: `(<guid>)`, or `(col='text',num=5)` for an alternate key. */
export function buildRecordKey(recordId: string | undefined, alternateKey: Record<string, string | number | boolean> | undefined): string {
  if (recordId) {
    return `(${recordId})`;
  }
  const entries = Object.entries(alternateKey ?? {});
  const segments = entries.map(([column, value]) => {
    if (!identifierPattern.test(column)) {
      throw new Error(`'${column}' is not a valid column logical name for an alternate key.`);
    }
    const literal = typeof value === "string" ? `'${value.replace(/'/g, "''")}'` : String(value);
    return `${column}=${encodeURIComponent(literal)}`;
  });
  return `(${segments.join(",")})`;
}

/**
 * Turns an @odata.nextLink back into an endpoint relative to the Web API root. Only links to
 * the active environment's Web API are accepted, so the bearer token never leaves it.
 */
export function relativeNextLink(nextLink: string, environmentUrl: string, entitySetName: string): string {
  let link: URL;
  let environment: URL;
  try {
    link = new URL(nextLink);
    environment = new URL(environmentUrl);
  } catch {
    throw new Error("nextLink must be the absolute @odata.nextLink URL returned by query_dataverse_records.");
  }
  if (link.origin.toLowerCase() !== environment.origin.toLowerCase() || !link.pathname.toLowerCase().startsWith(WEB_API_PATH)) {
    throw new Error(`nextLink must point to the Web API of the active environment (${environment.origin}${WEB_API_PATH}).`);
  }
  const endpoint = `${link.pathname.slice(WEB_API_PATH.length)}${link.search}`;
  if (!endpoint.toLowerCase().startsWith(entitySetName.toLowerCase())) {
    throw new Error(`nextLink does not belong to the entity set '${entitySetName}'.`);
  }
  return endpoint;
}

/** Removes @odata.etag everywhere and, unless annotations are wanted, every other row annotation. */
export function cleanRecord(value: unknown, keepAnnotations: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cleanRecord(item, keepAnnotations));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === "@odata.etag" || key === "@odata.context") {
      continue;
    }
    if (!keepAnnotations && key.includes("@")) {
      continue;
    }
    result[key] = cleanRecord(inner, keepAnnotations);
  }
  return result;
}

/**
 * Reads the paging cookie from @Microsoft.Dynamics.CRM.fetchxmlpagingcookie. Its pagingcookie
 * attribute is URL-encoded twice; the result is the cookie XML for the fetch element's
 * paging-cookie attribute (XML-escape it there).
 */
export function parseFetchXmlPagingCookie(annotation: unknown): { pagingCookie: string; nextPage: number } | null {
  if (typeof annotation !== "string") {
    return null;
  }
  const cookie = /pagingcookie="([^"]*)"/.exec(annotation);
  const page = /pagenumber="(\d+)"/.exec(annotation);
  if (!cookie || !page) {
    return null;
  }
  try {
    return { pagingCookie: decodeURIComponent(decodeURIComponent(cookie[1])), nextPage: Number(page[1]) };
  } catch {
    return null;
  }
}

function errorResult(action: string, error: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: `Error ${action}: ${error instanceof Error ? error.message : "Unknown error"}`
    }],
    isError: true
  };
}

export function getDataverseRecordTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_dataverse_record",
    {
      title: "Get Dataverse Record",
      description: "Reads one row of any Dataverse table by its GUID or by an alternate key. Read-only. Use $select-style column names to keep the result small; formatted values (choice labels, lookup names, formatted dates and money) are included by default.",
      inputSchema: {
        entitySetName: entitySetNameSchema.describe("Plural Dataverse entity-set name, for example accounts, contacts or new_tickets (EntitySetName in the table metadata)"),
        recordId: z.string().uuid("Use a Dataverse record GUID.").optional().describe("GUID of the record. Give recordId or alternateKey, not both."),
        alternateKey: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Alternate key column values, for example { \"accountnumber\": \"A-1001\" }. All columns of one alternate key are required."),
        select: z.array(columnNameSchema).max(200).optional().describe("Column logical names to return. Lookups are read as _<lookup>_value. Omit to return every column."),
        expand: z.string().max(4000).optional().describe("OData $expand, for example primarycontactid($select=fullname,emailaddress1)"),
        includeFormattedValues: z.boolean().default(true).describe("Include formatted values and lookup annotations (<column>@OData.Community.Display.V1.FormattedValue, lookuplogicalname, associatednavigationproperty)")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params) => {
      try {
        const hasId = !!params.recordId;
        const hasKey = !!params.alternateKey && Object.keys(params.alternateKey).length > 0;
        if (hasId === hasKey) {
          throw new Error("Give exactly one of recordId or alternateKey.");
        }
        const endpoint = `${params.entitySetName}${buildRecordKey(params.recordId, params.alternateKey)}` +
          buildODataQuery({ select: params.select, expand: params.expand });
        const record = await client.get(endpoint, undefined, { Prefer: ALL_ANNOTATIONS });
        return {
          content: [{
            type: "text",
            text: `Record from '${params.entitySetName}':\n\n${JSON.stringify(cleanRecord(record, params.includeFormattedValues), null, 2)}`
          }]
        };
      } catch (error) {
        return errorResult(`reading a record from '${params.entitySetName}'`, error);
      }
    }
  );
}

export function queryDataverseRecordsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "query_dataverse_records",
    {
      title: "Query Dataverse Records",
      description: "Reads rows of any Dataverse table with OData query options ($select, $filter, $orderby, $expand, $top, $count, $apply) or with FetchXML. Read-only. Follows Dataverse paging up to maxRecords (default 50) and returns a nextLink to continue. Use select to keep results small. Works for any entity set, including system tables such as systemusers, solutions, workflows, sdkmessageprocessingsteps, webresourceset and environmentvariabledefinitions.",
      inputSchema: {
        entitySetName: entitySetNameSchema.describe("Plural Dataverse entity-set name, for example accounts, contacts or new_tickets (EntitySetName in the table metadata)"),
        select: z.array(columnNameSchema).max(200).optional().describe("Column logical names to return ($select). Lookups are read as _<lookup>_value."),
        filter: z.string().max(8000).optional().describe("OData $filter, for example \"statecode eq 0 and contains(name,'Contoso')\""),
        orderby: z.string().max(2000).optional().describe("OData $orderby, for example \"createdon desc\""),
        expand: z.string().max(4000).optional().describe("OData $expand, for example primarycontactid($select=fullname)"),
        top: z.number().int().min(1).max(MAXIMUM_PAGE_SIZE).optional().describe("OData $top: the most rows Dataverse returns in total"),
        count: z.boolean().optional().describe("OData $count=true: also return the number of matching rows (Dataverse counts up to 5000)"),
        apply: z.string().max(4000).optional().describe("OData $apply for aggregation, for example \"groupby((statecode),aggregate($count as total))\""),
        fetchXml: z.string().max(30000).optional().describe("A FetchXML query instead of OData options. Its entity must belong to entitySetName. Page with the fetch element's page, count and paging-cookie attributes."),
        nextLink: z.string().url().max(32000).optional().describe("The nextLink of a previous query_dataverse_records result, to read the next page. Give it with the same entitySetName and no other query options."),
        maxRecords: z.number().int().min(1).max(MAXIMUM_PAGE_SIZE).default(DEFAULT_MAX_RECORDS).describe("The most rows this call returns, across pages (default 50, at most 5000)"),
        includeFormattedValues: z.boolean().default(true).describe("Include formatted values and lookup annotations (<column>@OData.Community.Display.V1.FormattedValue, lookuplogicalname, associatednavigationproperty)")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params) => {
      try {
        const odataOptions = ["select", "filter", "orderby", "expand", "top", "count", "apply"] as const;
        const usedOData = odataOptions.filter((name) => params[name] !== undefined && !(Array.isArray(params[name]) && (params[name] as unknown[]).length === 0));
        if (params.fetchXml && params.nextLink) {
          throw new Error("Give fetchXml or nextLink, not both. FetchXML pages with the page and paging-cookie attributes.");
        }
        if ((params.fetchXml || params.nextLink) && usedOData.length > 0) {
          throw new Error(`${params.fetchXml ? "fetchXml" : "nextLink"} cannot be combined with OData options (${usedOData.join(", ")}).`);
        }

        const result = params.fetchXml
          ? await runFetchXml(client, params.entitySetName, params.fetchXml, params.maxRecords)
          : await runODataQuery(
            client,
            params.nextLink
              ? relativeNextLink(params.nextLink, client.getActiveEnvironment(), params.entitySetName)
              : `${params.entitySetName}${buildODataQuery(params)}`,
            params.maxRecords
          );

        const records = cleanRecord(result.records, params.includeFormattedValues) as unknown[];
        const summary = [`Read ${records.length} record(s) from '${params.entitySetName}'.`];
        if (result.totalCount !== undefined) {
          summary.push(`Matching rows: ${result.totalCount}${result.totalCountLimited ? " or more (Dataverse counts up to 5000)" : ""}.`);
        }
        if (result.nextLink) {
          summary.push("More rows are available: call query_dataverse_records again with this nextLink and the same entitySetName.");
        } else if (result.fetchXmlPaging) {
          summary.push(`More rows are available: add page="${result.fetchXmlPaging.nextPage}" and the XML-escaped pagingCookie as paging-cookie to the fetch element (with a count attribute) and call again.`);
        } else if (result.moreRecords) {
          summary.push("More rows match than were returned; raise maxRecords or narrow the query.");
        }

        const payload: Record<string, unknown> = {
          entitySetName: params.entitySetName,
          returned: records.length,
          moreRecords: result.moreRecords
        };
        if (result.totalCount !== undefined) payload.totalCount = result.totalCount;
        if (result.nextLink) payload.nextLink = result.nextLink;
        if (result.fetchXmlPaging) {
          payload.nextPage = result.fetchXmlPaging.nextPage;
          payload.pagingCookie = result.fetchXmlPaging.pagingCookie;
        }
        payload.records = records;

        return {
          content: [{ type: "text", text: `${summary.join(" ")}\n\n${JSON.stringify(payload, null, 2)}` }]
        };
      } catch (error) {
        return errorResult(`querying records in '${params.entitySetName}'`, error);
      }
    }
  );
}

interface QueryResult {
  records: unknown[];
  moreRecords: boolean;
  nextLink?: string;
  totalCount?: number;
  totalCountLimited?: boolean;
  fetchXmlPaging?: { pagingCookie: string; nextPage: number };
}

async function runODataQuery(client: DataverseClient, firstEndpoint: string, maxRecords: number): Promise<QueryResult> {
  const records: unknown[] = [];
  let endpoint: string | undefined = firstEndpoint;
  let nextLink: string | undefined;
  let totalCount: number | undefined;
  let totalCountLimited = false;

  while (endpoint) {
    const pageSize = Math.min(maxRecords - records.length, MAXIMUM_PAGE_SIZE);
    const page: any = await client.get(endpoint, undefined, { Prefer: `odata.maxpagesize=${pageSize},${ALL_ANNOTATIONS}` });
    if (totalCount === undefined && typeof page?.["@odata.count"] === "number") {
      totalCount = page["@odata.count"];
      totalCountLimited = page["@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded"] === true;
    }
    const rows: unknown[] = Array.isArray(page?.value) ? page.value : [];
    records.push(...rows.slice(0, maxRecords - records.length));
    nextLink = typeof page?.["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
    if (rows.length > pageSize) {
      // Dataverse ignored the page size; the rows beyond it cannot be reached through nextLink.
      nextLink = undefined;
      return { records, moreRecords: true, totalCount, totalCountLimited };
    }
    if (!nextLink || records.length >= maxRecords) {
      break;
    }
    endpoint = relativeNextLink(nextLink, client.getActiveEnvironment(), firstEndpoint.split(/[?(/]/)[0]);
  }
  return { records, moreRecords: !!nextLink, nextLink, totalCount, totalCountLimited };
}

async function runFetchXml(client: DataverseClient, entitySetName: string, fetchXml: string, maxRecords: number): Promise<QueryResult> {
  const page: any = await client.get(`${entitySetName}?fetchXml=${encodeURIComponent(fetchXml)}`, undefined, { Prefer: ALL_ANNOTATIONS });
  const rows: unknown[] = Array.isArray(page?.value) ? page.value : [];
  const truncated = rows.length > maxRecords;
  const moreFromDataverse = page?.["@Microsoft.Dynamics.CRM.morerecords"] === true;
  const fetchXmlPaging = !truncated && moreFromDataverse ? parseFetchXmlPagingCookie(page["@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"]) ?? undefined : undefined;
  const totalCount = typeof page?.["@Microsoft.Dynamics.CRM.totalrecordcount"] === "number" && page["@Microsoft.Dynamics.CRM.totalrecordcount"] >= 0
    ? page["@Microsoft.Dynamics.CRM.totalrecordcount"]
    : undefined;
  return {
    records: rows.slice(0, maxRecords),
    moreRecords: truncated || moreFromDataverse,
    fetchXmlPaging,
    totalCount,
    totalCountLimited: page?.["@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded"] === true
  };
}
