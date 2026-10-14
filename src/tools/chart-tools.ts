import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";

const chartScopeSchema = z.enum(["System", "User"]);

type ChartScope = "System" | "User";

function chartEntitySet(scope: ChartScope): string {
  return scope === "System" ? "savedqueryvisualizations" : "userqueryvisualizations";
}

function chartIdField(scope: ChartScope): string {
  return scope === "System" ? "savedqueryvisualizationid" : "userqueryvisualizationid";
}

function chartLabel(scope: ChartScope): string {
  return scope === "System" ? "system chart" : "user chart";
}

function chartEndpoint(scope: ChartScope, chartId: string): string {
  return `${chartEntitySet(scope)}(${chartId})`;
}

function chartPayload(params: any): Record<string, any> {
  return {
    name: params.name,
    description: params.description,
    primaryentitytypecode: params.primaryEntityLogicalName,
    datadescription: params.dataDescription,
    presentationdescription: params.presentationDescription,
    charttype: params.chartType,
    isdefault: params.isDefault,
    ...(params.type !== undefined && { type: params.type })
  };
}

function parseChartId(scope: ChartScope, response: any): string | undefined {
  const idField = chartIdField(scope);
  return response?.[idField] || response?.id || response?.["@odata.id"]?.match(/\(([^)]+)\)/)?.[1];
}

export function createChartTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "create_dataverse_chart",
    {
      title: "Create Dataverse Chart",
      description: "Creates a system or user chart for a Dataverse table. Supply valid chart data XML and presentation XML; the MCP does not generate chart definitions from partial input.",
      inputSchema: {
        chartScope: chartScopeSchema.describe("System chart shared with the solution or User chart for the current user"),
        primaryEntityLogicalName: z.string().describe("Logical name of the table the chart is attached to"),
        name: z.string().describe("Chart name"),
        description: z.string().optional().describe("Chart description"),
        dataDescription: z.string().min(1).describe("Chart data XML defining the measures, groupings, and filters"),
        presentationDescription: z.string().min(1).describe("Chart presentation XML defining the visual layout"),
        chartType: z.number().int().min(0).max(1).default(0).describe("Chart rendering library: 0 for ASP.NET Charts, 1 for Power BI"),
        isDefault: z.boolean().default(false).describe("Whether this is the default chart for the table or view"),
        type: z.number().int().optional().describe("Optional chart usage type: 0 for data-centric and interaction-centric, 1 for interaction-centric")
      }
    },
    async (params) => {
      try {
        if (params.chartScope === "System" && !client.getSolutionContext()) {
          throw new Error("No solution context available. Set a solution context before creating a system chart.");
        }

        const solutionHeaders = params.chartScope === "System"
          ? { "MSCRM.SolutionUniqueName": client.getSolutionUniqueName()! }
          : undefined;
        const response = await client.post<any>(chartEntitySet(params.chartScope), chartPayload(params), solutionHeaders);
        const chartId = parseChartId(params.chartScope, response);
        const idMessage = chartId ? ` (ID: ${chartId})` : "";

        return {
          content: [{
            type: "text",
            text: `Successfully created ${chartLabel(params.chartScope)} '${params.name}' for table '${params.primaryEntityLogicalName}'${idMessage}.`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error creating chart: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
}

export function getChartTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_dataverse_chart",
    {
      title: "Get Dataverse Chart",
      description: "Retrieves a system or user chart, including its data and presentation XML.",
      inputSchema: {
        chartScope: chartScopeSchema,
        chartId: z.string().describe("Chart GUID")
      }
    },
    async (params) => {
      try {
        const chart = await client.get<any>(chartEndpoint(params.chartScope, params.chartId));
        return {
          content: [{
            type: "text",
            text: `${chartLabel(params.chartScope)} information:\n\n${JSON.stringify(chart, null, 2)}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error retrieving chart: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
}

export function listChartsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "list_dataverse_charts",
    {
      title: "List Dataverse Charts",
      description: "Lists system or user charts, optionally filtered to a Dataverse table.",
      inputSchema: {
        chartScope: chartScopeSchema,
        primaryEntityLogicalName: z.string().optional().describe("Optional logical name of the table to filter charts by"),
        includeManaged: z.boolean().default(true).describe("Whether to include managed system charts")
      }
    },
    async (params) => {
      try {
        const filters: string[] = [];
        if (params.primaryEntityLogicalName) {
          filters.push(`primaryentitytypecode eq '${params.primaryEntityLogicalName.replace(/'/g, "''")}'`);
        }
        if (params.chartScope === "System" && !params.includeManaged) {
          filters.push("ismanaged eq false");
        }
        const query = filters.length ? `?$filter=${filters.join(" and ")}` : "";
        const response = await client.get<{ value: any[] }>(`${chartEntitySet(params.chartScope)}${query}`);

        return {
          content: [{
            type: "text",
            text: `Found ${response.value.length} ${chartLabel(params.chartScope)}(s):\n\n${JSON.stringify(response.value, null, 2)}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error listing charts: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
}

export function updateChartTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "update_dataverse_chart",
    {
      title: "Update Dataverse Chart",
      description: "Updates a system or user chart. Only supplied properties are changed.",
      inputSchema: {
        chartScope: chartScopeSchema,
        chartId: z.string().describe("Chart GUID to update"),
        name: z.string().optional().describe("New chart name"),
        description: z.string().optional().describe("New chart description"),
        dataDescription: z.string().min(1).optional().describe("New chart data XML"),
        presentationDescription: z.string().min(1).optional().describe("New chart presentation XML"),
        chartType: z.number().int().min(0).max(1).optional().describe("New chart rendering library"),
        isDefault: z.boolean().optional().describe("Whether this is the default chart"),
        type: z.number().int().optional().describe("New chart usage type")
      }
    },
    async (params) => {
      try {
        const update: Record<string, any> = {};
        if (params.name !== undefined) update.name = params.name;
        if (params.description !== undefined) update.description = params.description;
        if (params.dataDescription !== undefined) update.datadescription = params.dataDescription;
        if (params.presentationDescription !== undefined) update.presentationdescription = params.presentationDescription;
        if (params.chartType !== undefined) update.charttype = params.chartType;
        if (params.isDefault !== undefined) update.isdefault = params.isDefault;
        if (params.type !== undefined) update.type = params.type;
        if (Object.keys(update).length === 0) {
          throw new Error("At least one chart property to update must be provided.");
        }

        const solutionHeaders = params.chartScope === "System" && client.getSolutionUniqueName()
          ? { "MSCRM.SolutionUniqueName": client.getSolutionUniqueName()! }
          : undefined;
        await client.patch(chartEndpoint(params.chartScope, params.chartId), update, solutionHeaders);
        return {
          content: [{
            type: "text",
            text: `Successfully updated ${chartLabel(params.chartScope)} '${params.chartId}'.`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error updating chart: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
}

export function deleteChartTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "delete_dataverse_chart",
    {
      title: "Delete Dataverse Chart",
      description: "Permanently deletes a system or user chart by GUID.",
      inputSchema: {
        chartScope: chartScopeSchema,
        chartId: z.string().describe("Chart GUID to delete")
      }
    },
    async (params) => {
      try {
        await client.delete(chartEndpoint(params.chartScope, params.chartId));
        return {
          content: [{
            type: "text",
            text: `Successfully deleted ${chartLabel(params.chartScope)} '${params.chartId}'.`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error deleting chart: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
}
