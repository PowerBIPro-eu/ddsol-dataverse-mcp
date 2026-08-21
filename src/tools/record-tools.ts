import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";

const entitySetNameSchema = z.string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Use a Dataverse entity-set name without URL path characters.")
  .max(128);

const recordIdSchema = z.string().uuid("Use a Dataverse record GUID.");
const maximumBulkRecords = 25;

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

export function createDataverseRecordsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "create_dataverse_records",
    {
      title: "Create Dataverse Records",
      description: "Creates up to 25 records in one Dataverse entity set. Each returned representation verifies its record was created. This changes business data and runs only when confirmWrite is true.",
      inputSchema: {
        entitySetName: entitySetNameSchema.describe("Plural Dataverse entity-set name, for example accounts or new_tickets"),
        records: z.array(z.record(z.unknown())).min(1).max(maximumBulkRecords).describe("Record payloads. Lookup bindings use '<NavigationProperty>@odata.bind': '/<entitySet>(<guid>)'."),
        confirmWrite: z.literal(true).describe("Must be true to create the records")
      }
    },
    async (params) => {
      const createdRecords = [];
      try {
        for (const record of params.records) {
          createdRecords.push(await client.post(
            params.entitySetName,
            record,
            { Prefer: "return=representation" }
          ));
        }

        return {
          content: [{
            type: "text",
            text: `Successfully created and verified ${createdRecords.length} record(s) in '${params.entitySetName}'.\n\n${JSON.stringify(createdRecords, null, 2)}`
          }]
        };
      } catch (error) {
        return recordWriteError("creating", params.entitySetName, error, createdRecords);
      }
    }
  );
}

export function updateDataverseRecordsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "update_dataverse_records",
    {
      title: "Update Dataverse Records",
      description: "Updates up to 25 records in one Dataverse entity set, then re-fetches each record to verify the update. This changes business data and runs only when confirmWrite is true.",
      inputSchema: {
        entitySetName: entitySetNameSchema.describe("Plural Dataverse entity-set name, for example accounts or new_tickets"),
        records: z.array(z.object({
          recordId: recordIdSchema.describe("Dataverse GUID of the record to update"),
          data: z.record(z.unknown()).describe("Fields to update. Lookup bindings use '<NavigationProperty>@odata.bind'.")
        })).min(1).max(maximumBulkRecords),
        confirmWrite: z.literal(true).describe("Must be true to update the records")
      }
    },
    async (params) => {
      const verifiedRecords = [];
      try {
        for (const record of params.records) {
          await client.patch(`${params.entitySetName}(${record.recordId})`, record.data);
          verifiedRecords.push(await client.get(`${params.entitySetName}(${record.recordId})`));
        }

        return {
          content: [{
            type: "text",
            text: `Successfully updated and verified ${verifiedRecords.length} record(s) in '${params.entitySetName}'.\n\n${JSON.stringify(verifiedRecords, null, 2)}`
          }]
        };
      } catch (error) {
        return recordWriteError("updating", params.entitySetName, error, verifiedRecords);
      }
    }
  );
}

export function deleteDataverseRecordsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "delete_dataverse_records",
    {
      title: "Delete Dataverse Records",
      description: "Deletes up to 25 records in one Dataverse entity set. A successful Dataverse delete response confirms each deletion. This operation cannot be undone and runs only when confirmDelete is true.",
      inputSchema: {
        entitySetName: entitySetNameSchema.describe("Plural Dataverse entity-set name, for example accounts or new_tickets"),
        recordIds: z.array(recordIdSchema).min(1).max(maximumBulkRecords).describe("Dataverse record GUIDs to delete"),
        confirmDelete: z.literal(true).describe("Must be true to delete the records")
      }
    },
    async (params) => {
      const deletedRecordIds = [];
      try {
        for (const recordId of params.recordIds) {
          await client.delete(`${params.entitySetName}(${recordId})`);
          deletedRecordIds.push(recordId);
        }

        return {
          content: [{
            type: "text",
            text: `Successfully deleted ${params.recordIds.length} record(s) from '${params.entitySetName}'. Dataverse confirmed each delete response.\n\n${JSON.stringify(params.recordIds, null, 2)}`
          }]
        };
      } catch (error) {
        return recordWriteError("deleting", params.entitySetName, error, deletedRecordIds);
      }
    }
  );
}

function recordWriteError(operation: string, entitySetName: string, error: unknown, completedRecords: unknown[]) {
  return {
    content: [{
      type: "text" as const,
      text: `Error ${operation} record(s) in '${entitySetName}': ${error instanceof Error ? error.message : "Unknown error"}\n\nConfirmed completed records before the failure:\n${JSON.stringify(completedRecords, null, 2)}`
    }],
    isError: true
  };
}