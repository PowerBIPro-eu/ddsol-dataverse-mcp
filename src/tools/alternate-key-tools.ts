import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";
import { STRONG_CONSISTENCY } from "./metadata-readback.js";

interface EntityKeyMetadata {
  MetadataId: string;
  SchemaName: string;
  LogicalName?: string;
  DisplayName?: {
    UserLocalizedLabel?: {
      Label?: string;
    };
  };
  KeyAttributes: string[];
  EntityKeyIndexStatus?: number | string;
  AsyncJob?: string;
  IsManaged?: boolean;
  IsCustomizable?: {
    Value?: boolean;
  };
}

interface MetadataCollection<T> {
  value: T[];
}

function getIndexStatusName(status: number | string | undefined): string {
  const statusNames: Record<number, string> = {
    0: "Pending",
    1: "InProgress",
    2: "Active",
    3: "Failed"
  };

  if (typeof status === "number") {
    return statusNames[status] || `Unknown (${status})`;
  }

  return status || "Unknown";
}

function toKeySummary(key: EntityKeyMetadata) {
  return {
    keyId: key.MetadataId,
    schemaName: key.SchemaName,
    logicalName: key.LogicalName,
    displayName: key.DisplayName?.UserLocalizedLabel?.Label,
    keyAttributes: key.KeyAttributes,
    indexStatus: getIndexStatusName(key.EntityKeyIndexStatus),
    asyncJobId: key.AsyncJob,
    isManaged: key.IsManaged,
    isCustomizable: key.IsCustomizable?.Value
  };
}

function keysEndpoint(entityLogicalName: string): string {
  return `EntityDefinitions(LogicalName='${entityLogicalName}')/Keys`;
}

const KEY_SELECT = "MetadataId,SchemaName,LogicalName,DisplayName,KeyAttributes,EntityKeyIndexStatus,AsyncJob,IsManaged,IsCustomizable";

/** How often a freshly created key is looked up before reporting it as not visible yet. */
export const createdKeyLookup = { attempts: 5, delayMs: 3000 };

/** Extracts the key's MetadataId from an OData-EntityId header such as .../EntityDefinitions(<id>)/Keys(<id>). */
export function keyIdFromEntityIdHeader(header: string | undefined): string | undefined {
  return header ? /Keys\(([0-9a-fA-F-]{36})\)/.exec(header)?.[1] : undefined;
}

function isNotFound(error: unknown): boolean {
  const err = error as { status?: number; code?: string; message?: string };
  return err?.status === 404 || err?.code === "0x80040217" || err?.code === "0x80060888" || /0x80040217|0x80060888/.test(err?.message ?? "");
}

/**
 * Looks up a key that was just created. The create request has already succeeded, so
 * the key exists; metadata can take a moment to show it. Reads use Consistency: Strong,
 * and only "not found" is retried.
 */
async function findCreatedKey(
  client: DataverseClient,
  entityLogicalName: string,
  schemaName: string,
  keyId: string | undefined
): Promise<{ key?: EntityKeyMetadata; error?: string }> {
  for (let attempt = 1; attempt <= createdKeyLookup.attempts; attempt++) {
    try {
      if (keyId) {
        return { key: await client.getMetadata<EntityKeyMetadata>(`${keysEndpoint(entityLogicalName)}(${keyId})`, { $select: KEY_SELECT }, STRONG_CONSISTENCY) };
      }
      const response = await client.getMetadata<MetadataCollection<EntityKeyMetadata>>(keysEndpoint(entityLogicalName), { $select: KEY_SELECT }, STRONG_CONSISTENCY);
      const key = response.value.find((item) => item.SchemaName === schemaName);
      if (key) {
        return { key };
      }
    } catch (error) {
      if (!isNotFound(error)) {
        return { error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
      }
    }
    if (attempt < createdKeyLookup.attempts) {
      await new Promise((resolve) => setTimeout(resolve, createdKeyLookup.delayMs));
    }
  }
  return {};
}

async function getKeyBySchemaName(
  client: DataverseClient,
  entityLogicalName: string,
  schemaName: string
): Promise<EntityKeyMetadata> {
  const response = await client.getMetadata<MetadataCollection<EntityKeyMetadata>>(
    keysEndpoint(entityLogicalName),
    {
      $select: "MetadataId,SchemaName,LogicalName,DisplayName,KeyAttributes,EntityKeyIndexStatus,AsyncJob,IsManaged,IsCustomizable"
    }
  );

  const key = response.value.find((item) => item.SchemaName === schemaName);
  if (!key) {
    throw new Error(`Alternate key '${schemaName}' was not found on table '${entityLogicalName}'.`);
  }

  return key;
}

export function createAlternateKeyTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "create_dataverse_alternate_key",
    {
      title: "Create Dataverse Alternate Key",
      description: "Creates an alternate key on a Dataverse table using one or more existing columns. The caller supplies the key schema name and key attributes. Dataverse creates the unique index asynchronously; use get_dataverse_alternate_key or list_dataverse_alternate_keys to monitor its status.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table that owns the alternate key"),
        schemaName: z.string().describe("Schema name for the alternate key"),
        displayName: z.string().optional().describe("Display name for the alternate key"),
        keyAttributes: z.array(z.string()).min(1).max(16).describe("Logical names of existing columns that form the unique key, in key order")
      }
    },
    async (params) => {
      try {
        if (!client.getSolutionContext()) {
          throw new Error("No solution context available. Please set a solution context using set_solution_context tool first.");
        }

        const metadata = {
          "@odata.type": "Microsoft.Dynamics.CRM.EntityKeyMetadata",
          SchemaName: params.schemaName,
          KeyAttributes: params.keyAttributes,
          ...(params.displayName && {
            DisplayName: {
              LocalizedLabels: [{
                Label: params.displayName,
                LanguageCode: 1033
              }]
            }
          })
        };

        const response = await client.postMetadataWithResponse(keysEndpoint(params.entityLogicalName), metadata);
        const keyId = keyIdFromEntityIdHeader(response.headers["odata-entityid"]);
        const { key, error } = await findCreatedKey(client, params.entityLogicalName, params.schemaName, keyId);

        if (key) {
          return {
            content: [
              {
                type: "text",
                text: `Successfully created alternate key '${params.schemaName}' on table '${params.entityLogicalName}'. Index status: ${getIndexStatusName(key.EntityKeyIndexStatus)}.\n\n${JSON.stringify(toKeySummary(key), null, 2)}\n\nThe unique index is created asynchronously. Wait until indexStatus is 'Active' before relying on this key for upsert or key-based record references.`
              }
            ]
          };
        }

        // The create request succeeded, so the key exists even though metadata does not
        // show it yet. Reporting a failure here would invite creating it a second time.
        return {
          content: [
            {
              type: "text",
              text: `Successfully created alternate key '${params.schemaName}' on table '${params.entityLogicalName}'${keyId ? ` (keyId: ${keyId})` : ''}, but it is not visible in the table metadata yet${error ? ` (lookup failed: ${error})` : ''}.\n\nDo not create it again. Dataverse builds the unique index asynchronously; check the key with get_dataverse_alternate_key or list_dataverse_alternate_keys and wait until indexStatus is 'Active' before relying on it.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating alternate key: ${error instanceof Error ? error.message : "Unknown error"}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function getAlternateKeyTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_dataverse_alternate_key",
    {
      title: "Get Dataverse Alternate Key",
      description: "Retrieves an alternate key and its asynchronous index status. Provide either the key metadata ID or schema name.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table that owns the alternate key"),
        keyId: z.string().optional().describe("Metadata ID of the alternate key"),
        schemaName: z.string().optional().describe("Schema name of the alternate key")
      }
    },
    async (params) => {
      try {
        if (!params.keyId && !params.schemaName) {
          throw new Error("Provide either keyId or schemaName.");
        }
        if (params.keyId && params.schemaName) {
          throw new Error("Provide either keyId or schemaName, not both.");
        }

        const key = params.keyId
          ? await client.getMetadata<EntityKeyMetadata>(`${keysEndpoint(params.entityLogicalName)}(${params.keyId})`)
          : await getKeyBySchemaName(client, params.entityLogicalName, params.schemaName!);

        return {
          content: [
            {
              type: "text",
              text: `Alternate key information for table '${params.entityLogicalName}':\n\n${JSON.stringify(toKeySummary(key), null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error retrieving alternate key: ${error instanceof Error ? error.message : "Unknown error"}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function listAlternateKeysTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "list_dataverse_alternate_keys",
    {
      title: "List Dataverse Alternate Keys",
      description: "Lists alternate keys for a Dataverse table, including their key attributes and asynchronous index status.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table whose alternate keys to list")
      }
    },
    async (params) => {
      try {
        const response = await client.getMetadata<MetadataCollection<EntityKeyMetadata>>(
          keysEndpoint(params.entityLogicalName),
          {
            $select: "MetadataId,SchemaName,LogicalName,DisplayName,KeyAttributes,EntityKeyIndexStatus,AsyncJob,IsManaged,IsCustomizable"
          }
        );
        const keys = response.value.map(toKeySummary);

        return {
          content: [
            {
              type: "text",
              text: `Found ${keys.length} alternate key(s) on table '${params.entityLogicalName}':\n\n${JSON.stringify(keys, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing alternate keys: ${error instanceof Error ? error.message : "Unknown error"}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function deleteAlternateKeyTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "delete_dataverse_alternate_key",
    {
      title: "Delete Dataverse Alternate Key",
      description: "Permanently deletes an alternate key by metadata ID. Deleting a key also removes or cancels its unique index.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table that owns the alternate key"),
        keyId: z.string().describe("Metadata ID of the alternate key to delete")
      }
    },
    async (params) => {
      try {
        await client.deleteMetadata(`${keysEndpoint(params.entityLogicalName)}(${params.keyId})`);

        return {
          content: [
            {
              type: "text",
              text: `Successfully deleted alternate key '${params.keyId}' from table '${params.entityLogicalName}'.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error deleting alternate key: ${error instanceof Error ? error.message : "Unknown error"}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function reactivateAlternateKeyTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "reactivate_dataverse_alternate_key",
    {
      title: "Reactivate Dataverse Alternate Key",
      description: "Restarts asynchronous index creation for a failed alternate key. Use get_dataverse_alternate_key first to confirm that the key index status is Failed.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table that owns the alternate key"),
        keyLogicalName: z.string().describe("Logical name of the failed alternate key")
      }
    },
    async (params) => {
      try {
        await client.callAction("ReactivateEntityKey", {
          EntityLogicalName: params.entityLogicalName,
          EntityKeyLogicalName: params.keyLogicalName
        });

        return {
          content: [
            {
              type: "text",
              text: `Successfully requested reactivation for alternate key '${params.keyLogicalName}' on table '${params.entityLogicalName}'. Use get_dataverse_alternate_key to monitor the asynchronous index status.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error reactivating alternate key: ${error instanceof Error ? error.message : "Unknown error"}`
            }
          ],
          isError: true
        };
      }
    }
  );
}
