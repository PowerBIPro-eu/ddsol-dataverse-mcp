import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";

const entitySetNameSchema = z.string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Use a Dataverse entity-set name without URL path characters.")
  .max(128);

export function createDataverseRecordTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "create_dataverse_record",
    {
      title: "Create Dataverse Record",
      description: "Creates one record in a Dataverse entity set. Provide structural column logical names and case-sensitive navigation-property names for lookup @odata.bind keys. This changes business data and runs only when confirmCreate is true.",
      inputSchema: {
        entitySetName: entitySetNameSchema.describe("Plural Dataverse entity-set name, for example accounts or new_tickets"),
        record: z.record(z.unknown()).describe("Record payload. Lookup bindings use '<NavigationProperty>@odata.bind': '/<entitySet>(<guid>)'. Choice values are integers."),
        confirmCreate: z.literal(true).describe("Must be true to create the record")
      }
    },
    async (params) => {
      try {
        const createdRecord = await client.post(
          params.entitySetName,
          params.record,
          { Prefer: "return=representation" }
        );

        return {
          content: [
            {
              type: "text",
              text: `Successfully created a record in '${params.entitySetName}'.\n\n${JSON.stringify(createdRecord, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating record in '${params.entitySetName}': ${error instanceof Error ? error.message : "Unknown error"}`
            }
          ],
          isError: true
        };
      }
    }
  );
}