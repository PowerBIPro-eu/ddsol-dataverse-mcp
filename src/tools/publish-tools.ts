import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";

export function publishDataverseCustomizationsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "publish_dataverse_customizations",
    {
      title: "Publish Dataverse Customizations",
      description: "Publishes pending unmanaged customizations so they take effect for end users. Use entityLogicalName to publish a single table's forms/views/columns, or omit it to publish all customizations in the environment.",
      inputSchema: {
        entityLogicalName: z.string().optional().describe("Logical name of the table to publish (e.g. 'ddsol_sample'). If omitted, publishes ALL customizations in the environment.")
      }
    },
    async (params) => {
      try {
        if (params.entityLogicalName) {
          const parameterXml = `<importexportxml><entities><entity>${params.entityLogicalName}</entity></entities><nodes /><roles /><workflows /></importexportxml>`;
          await client.callAction('PublishXml', { ParameterXml: parameterXml });
          return {
            content: [
              {
                type: "text",
                text: `Successfully published customizations for table '${params.entityLogicalName}'.`
              }
            ]
          };
        }

        await client.callAction('PublishAllXml', {});
        return {
          content: [
            {
              type: "text",
              text: `Successfully published all pending customizations in the environment.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error publishing customizations: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}
