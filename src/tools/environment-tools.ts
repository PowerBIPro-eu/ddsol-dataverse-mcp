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
      description: "Selects the Dataverse environment for the current session; all subsequent tool calls use it. Accepts a full environment URL, unique name, or friendly name (as returned by list_dataverse_environments). The choice is not carried into new sessions, which start without an environment unless DATAVERSE_URL is configured, so confirm the environment with the user at the start of each session. May require a sign-in if no cached sign-in covers the environment.",
      inputSchema: {
        environment: z.string().describe("Environment URL, unique name, or friendly name to switch to")
      }
    },
    async (params) => {
      try {
        const activeUrl = await client.setActiveEnvironment(params.environment);
        const solution = client.getSolutionContext();
        const solutionLine = solution
          ? `Solution for this session: '${solution.solutionUniqueName}' (${client.getSolutionContextSource() === 'session' ? 'override for this session' : 'project default from .dataverse-mcp'})`
          : 'Solution for this session: none set';
        return {
          content: [
            {
              type: "text",
              text: `Active Dataverse environment switched to: ${activeUrl}\n\nThis selection applies to the current session only.\n${solutionLine}\n\nRun any Dataverse tool to complete sign-in if prompted.`
            }
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

export function getDataverseAuthStatusTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_dataverse_auth_status",
    {
      title: "Get Dataverse Sign-in Status",
      description: "Shows the sign-in state without starting a sign-in: cached sign-ins and when they expire, sign-ins in progress (code, expiry and the result of the last check with Microsoft Entra) and the most recent authentication errors. Use it to find out why a sign-in seems stuck instead of asking the user to sign in again. Never shows tokens.",
      inputSchema: {}
    },
    async () => {
      try {
        return {
          content: [
            { type: "text", text: `Dataverse sign-in status:\n\n${JSON.stringify(client.getAuthStatus(), null, 2)}` }
          ]
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error reading the sign-in status: ${error instanceof Error ? error.message : 'Unknown error'}` }
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
      description: "Returns the Dataverse environment used by the current session and where it came from. When none is selected, it names the environment last used in this working folder as a suggestion to confirm with the user.",
      inputSchema: {}
    },
    async () => {
      const info = client.getEnvironmentInfo();
      let text: string;
      if (info.url) {
        const source = info.source === 'DATAVERSE_URL' ? 'DATAVERSE_URL (server configuration)' : 'selected in this session';
        text = `Active Dataverse environment: ${info.url}\nSource: ${source}`;
      } else if (info.lastUsedInFolder) {
        const when = info.lastUsedInFolder.at ? ` (selected ${info.lastUsedInFolder.at.slice(0, 10)})` : '';
        text = `Active Dataverse environment: (none selected for this session)\nLast used in this folder: ${info.lastUsedInFolder.url}${when}. Confirm it with the user before selecting it again with set_dataverse_environment.`;
      } else {
        text = 'Active Dataverse environment: (none selected for this session)\nAsk the user which environment to use, then call set_dataverse_environment.';
      }
      return {
        content: [
          { type: "text", text }
        ]
      };
    }
  );
}
