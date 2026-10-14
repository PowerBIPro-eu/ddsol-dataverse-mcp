import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";

// Query types for savedquery (view) records
const QUERY_TYPES: Record<string, number> = {
  Public: 0,
  AdvancedFind: 1,
  Associated: 2,
  QuickFind: 4,
  Lookup: 64,
  MobileClient: 8192
};

// Solution component type for savedquery
const VIEW_COMPONENT_TYPE = 26;

// Generates a minimal, valid FetchXML for a view given an entity and column list.
function generateFetchXml(entityLogicalName: string, primaryIdAttribute: string, columns: string[]): string {
  const attributes = Array.from(new Set([primaryIdAttribute, ...columns]))
    .map(attr => `    <attribute name="${attr}" />`)
    .join("\n");

  return `<fetch>\n  <entity name="${entityLogicalName}">\n${attributes}\n  </entity>\n</fetch>`;
}

// Generates a minimal, valid LayoutXML (grid) for a view given an entity and column list.
function generateLayoutXml(entityLogicalName: string, primaryIdAttribute: string, columns: string[], columnWidth: number = 150): string {
  const cells = columns
    .map(attr => `      <cell name="${attr}" width="${columnWidth}" />`)
    .join("\n");

  return `<grid name="resultset" object="1" jump="${columns[0] || primaryIdAttribute}" select="1" icon="1" preview="1">\n  <row name="result" id="${primaryIdAttribute}">\n${cells}\n  </row>\n</grid>`;
}

// Updates of Quick Find views have failed with "An unexpected error occurred"
// (0x80040216) while regular views on the same tables updated fine; the cause is not
// known yet. The error details above the note come from Dataverse.
async function quickFindHint(client: DataverseClient, savedQueryId: string): Promise<string> {
  try {
    const view = await client.get<{ querytype?: number; isquickfindquery?: boolean }>(
      `savedqueries(${savedQueryId})?$select=name,querytype,isquickfindquery`
    );
    if (view?.isquickfindquery || view?.querytype === QUERY_TYPES.QuickFind) {
      return '\n\nThis is the Quick Find view of the table. Dataverse rejected the update with an unexpected error. ' +
        'If the error details above do not point to something you can fix in the FetchXML or LayoutXML, ' +
        'edit the Quick Find view in the maker portal (make.powerapps.com) instead.';
    }
  } catch {
    // Keep the original error; the note is only a hint.
  }
  return '';
}

async function addViewToSolutionIfContextSet(client: DataverseClient, savedQueryId: string): Promise<void> {
  const solutionUniqueName = client.getSolutionUniqueName();
  if (!solutionUniqueName) return;
  await client.callAction('AddSolutionComponent', {
    ComponentId: savedQueryId,
    ComponentType: VIEW_COMPONENT_TYPE,
    SolutionUniqueName: solutionUniqueName,
    AddRequiredComponents: false,
    DoNotIncludeSubcomponents: true
  });
}

export function createViewTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "create_dataverse_view",
    {
      title: "Create Dataverse View",
      description: "Creates a new system view (savedquery) for a table. Provide either 'columns' to auto-generate FetchXML/LayoutXML, or supply 'fetchXml'/'layoutXml' directly for full control. Automatically adds the view to the current solution context if one is set.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table the view is for (e.g. 'account')"),
        primaryIdAttribute: z.string().describe("Logical name of the table's primary key attribute (e.g. 'accountid')"),
        name: z.string().describe("Name of the view"),
        description: z.string().optional().describe("Description of the view"),
        columns: z.array(z.string()).optional().describe("Column logical names to display, used to auto-generate FetchXML/LayoutXML when fetchXml/layoutXml are not provided"),
        fetchXml: z.string().optional().describe("Full FetchXML for the view. Overrides auto-generation from 'columns'."),
        layoutXml: z.string().optional().describe("Full LayoutXML for the view grid. Overrides auto-generation from 'columns'."),
        queryType: z.enum(Object.keys(QUERY_TYPES) as [string, ...string[]]).default("Public").describe("Type of view"),
        isDefault: z.boolean().default(false).describe("Whether this is the default public view for the table")
      }
    },
    async (params) => {
      try {
        if (!params.fetchXml && (!params.columns || params.columns.length === 0)) {
          throw new Error("Either 'fetchXml' or a non-empty 'columns' array must be provided");
        }

        const fetchXml = params.fetchXml || generateFetchXml(params.entityLogicalName, params.primaryIdAttribute, params.columns!);
        const layoutXml = params.layoutXml || generateLayoutXml(params.entityLogicalName, params.primaryIdAttribute, params.columns!);

        const savedQuery = {
          name: params.name,
          description: params.description,
          returnedtypecode: params.entityLogicalName,
          fetchxml: fetchXml,
          layoutxml: layoutXml,
          querytype: QUERY_TYPES[params.queryType],
          isdefault: params.isDefault
        };

        const result = await client.post<{ savedqueryid: string }>("savedqueries", savedQuery);

        // The Web API doesn't return the created record body by default; fetch its id.
        let savedQueryId = result?.savedqueryid;
        if (!savedQueryId) {
          const created = await client.get<{ value: { savedqueryid: string }[] }>(
            `savedqueries?$filter=name eq '${params.name.replace(/'/g, "''")}' and returnedtypecode eq '${params.entityLogicalName}'&$select=savedqueryid&$orderby=createdon desc&$top=1`
          );
          savedQueryId = created.value?.[0]?.savedqueryid;
        }

        if (savedQueryId) {
          await addViewToSolutionIfContextSet(client, savedQueryId);
        }

        return {
          content: [
            {
              type: "text",
              text: `Successfully created view '${params.name}' for table '${params.entityLogicalName}'${savedQueryId ? ` (savedqueryid: ${savedQueryId})` : ''}.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating view: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function getViewTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_dataverse_view",
    {
      title: "Get Dataverse View",
      description: "Retrieves a system view (savedquery) by its ID, including FetchXML and LayoutXML.",
      inputSchema: {
        savedQueryId: z.string().describe("GUID of the view (savedqueryid)")
      }
    },
    async (params) => {
      try {
        const result = await client.get(`savedqueries(${params.savedQueryId})`);
        return {
          content: [
            {
              type: "text",
              text: `View information:\n\n${JSON.stringify(result, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error retrieving view: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function updateViewTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "update_dataverse_view",
    {
      title: "Update Dataverse View",
      description: "Updates an existing system view (savedquery). Only provided fields are changed.",
      inputSchema: {
        savedQueryId: z.string().describe("GUID of the view (savedqueryid) to update"),
        name: z.string().optional().describe("New name for the view"),
        description: z.string().optional().describe("New description for the view"),
        fetchXml: z.string().optional().describe("New FetchXML for the view"),
        layoutXml: z.string().optional().describe("New LayoutXML for the view grid"),
        isDefault: z.boolean().optional().describe("Whether this is the default public view for the table")
      }
    },
    async (params) => {
      try {
        const update: Record<string, any> = {};
        if (params.name !== undefined) update.name = params.name;
        if (params.description !== undefined) update.description = params.description;
        if (params.fetchXml !== undefined) update.fetchxml = params.fetchXml;
        if (params.layoutXml !== undefined) update.layoutxml = params.layoutXml;
        if (params.isDefault !== undefined) update.isdefault = params.isDefault;

        if (Object.keys(update).length === 0) {
          throw new Error("At least one field to update must be provided");
        }

        // If-Match: * makes this an update only: a wrong ID fails instead of attempting a create.
        await client.patch(`savedqueries(${params.savedQueryId})`, update, { 'If-Match': '*' });

        return {
          content: [
            {
              type: "text",
              text: `Successfully updated view '${params.savedQueryId}'.`
            }
          ]
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const quickFindNote = /0x80040216/.test(message) ? await quickFindHint(client, params.savedQueryId) : '';
        return {
          content: [
            {
              type: "text",
              text: `Error updating view: ${message}${quickFindNote}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function deleteViewTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "delete_dataverse_view",
    {
      title: "Delete Dataverse View",
      description: "Permanently deletes a system view (savedquery). WARNING: This action cannot be undone.",
      inputSchema: {
        savedQueryId: z.string().describe("GUID of the view (savedqueryid) to delete")
      }
    },
    async (params) => {
      try {
        await client.delete(`savedqueries(${params.savedQueryId})`);
        return {
          content: [
            {
              type: "text",
              text: `Successfully deleted view '${params.savedQueryId}'.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error deleting view: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function listViewsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "list_dataverse_views",
    {
      title: "List Dataverse Views",
      description: "Lists system views (savedquery) for a table, optionally filtered by query type.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table to list views for (e.g. 'account')"),
        queryType: z.enum(Object.keys(QUERY_TYPES) as [string, ...string[]]).optional().describe("Filter by view type"),
        includeManaged: z.boolean().default(true).describe("Whether to include managed views")
      }
    },
    async (params) => {
      try {
        const filters = [`returnedtypecode eq '${params.entityLogicalName}'`];
        if (params.queryType) {
          filters.push(`querytype eq ${QUERY_TYPES[params.queryType]}`);
        }
        if (!params.includeManaged) {
          filters.push("ismanaged eq false");
        }

        const result = await client.get<{ value: any[] }>(
          `savedqueries?$filter=${filters.join(" and ")}&$select=savedqueryid,name,description,querytype,isdefault,ismanaged`
        );

        return {
          content: [
            {
              type: "text",
              text: `Found ${result.value.length} view(s) for table '${params.entityLogicalName}':\n\n${JSON.stringify(result.value, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing views: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}
