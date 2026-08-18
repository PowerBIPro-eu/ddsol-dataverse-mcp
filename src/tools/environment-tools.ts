import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";

export function listDataverseEnvironmentsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "list_dataverse_environments",
    {
      title: "List Dataverse Environments",
      description: "Lists all Dataverse environments (organizations) the signed-in user can access across the tenant, via the Global Discovery Service. Use this to see available environments before switching with set_dataverse_environment.",
      inputSchema: {}
    },
    async () => {
      try {
        const environments = await client.listEnvironments();
        return {
          content: [
            {
              type: "text",
              text: `Found ${environments.length} environment(s):\n\n${JSON.stringify(environments, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error listing Dataverse environments: ${error instanceof Error ? error.message : 'Unknown error'}` }
          ],
          isError: true
        };
      }
    }
  );
}

export function setDataverseEnvironmentTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "set_dataverse_environment",
    {
      title: "Set Active Dataverse Environment",
      description: "Switches the active Dataverse environment used by all subsequent tool calls. Accepts a full environment URL, unique name, or friendly name (as returned by list_dataverse_environments). May trigger a new sign-in if no cached token exists for the selected environment.",
      inputSchema: {
        environment: z.string().describe("Environment URL, unique name, or friendly name to switch to")
      }
    },
    async (params) => {
      try {
        const activeUrl = await client.setActiveEnvironment(params.environment);
        return {
          content: [
            { type: "text", text: `Active Dataverse environment switched to: ${activeUrl}\n\nRun any Dataverse tool to complete sign-in if prompted.` }
          ]
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error switching Dataverse environment: ${error instanceof Error ? error.message : 'Unknown error'}` }
          ],
          isError: true
        };
      }
    }
  );
}

export function getActiveDataverseEnvironmentTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_active_dataverse_environment",
    {
      title: "Get Active Dataverse Environment",
      description: "Returns the Dataverse environment URL currently in use by this MCP server.",
      inputSchema: {}
    },
    async () => {
      return {
        content: [
          { type: "text", text: `Active Dataverse environment: ${client.getActiveEnvironment()}` }
        ]
      };
    }
  );
}
