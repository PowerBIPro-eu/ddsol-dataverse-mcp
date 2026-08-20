import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";
import { EntityMetadata, ODataResponse, LocalizedLabel } from "../types.js";

// Helper function to create localized labels
function createLocalizedLabel(text: string, languageCode: number = 1033): LocalizedLabel {
  return {
    LocalizedLabels: [
      {
        Label: text,
        LanguageCode: languageCode,
        IsManaged: false,
        MetadataId: "00000000-0000-0000-0000-000000000000"
      }
    ],
    UserLocalizedLabel: {
      Label: text,
      LanguageCode: languageCode,
      IsManaged: false,
      MetadataId: "00000000-0000-0000-0000-000000000000"
    }
  };
}

export function createTableTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "create_dataverse_table",
    {
      title: "Create Dataverse Table",
      description: "Creates a new custom table in Dataverse with the specified configuration. The caller must provide all table and primary-name identifiers; this tool does not derive names or pluralize display labels. Requires a solution context to be set first.",
      inputSchema: {
        displayName: z.string().describe("Display name for the table (e.g., 'Test Table')"),
        displayCollectionName: z.string().describe("Plural display name for the table (e.g., 'Test Tables')"),
        logicalName: z.string().describe("Complete logical name for the table, including the publisher prefix"),
        schemaName: z.string().describe("Complete schema name for the table, including the publisher prefix"),
        description: z.string().optional().describe("Description of the table"),
        ownershipType: z.enum(["UserOwned", "OrganizationOwned"]).default("UserOwned").describe("Ownership type of the table"),
        hasActivities: z.boolean().default(false).describe("Whether the table can have activities"),
        hasNotes: z.boolean().default(false).describe("Whether the table can have notes"),
        isAuditEnabled: z.boolean().default(false).describe("Whether auditing is enabled"),
        isDuplicateDetectionEnabled: z.boolean().default(false).describe("Whether duplicate detection is enabled"),
        isValidForQueue: z.boolean().default(false).describe("Whether records can be added to queues"),
        isConnectionsEnabled: z.boolean().default(false).describe("Whether connections are enabled"),
        isMailMergeEnabled: z.boolean().default(false).describe("Whether mail merge is enabled"),
        isDocumentManagementEnabled: z.boolean().default(false).describe("Whether document management is enabled"),
        primaryNameDisplayName: z.string().describe("Display name of the primary name attribute"),
        primaryNameLogicalName: z.string().describe("Complete logical name of the primary name attribute"),
        primaryNameSchemaName: z.string().describe("Complete schema name of the primary name attribute. Must exactly match primaryNameLogicalName."),
        primaryNameAutoNumberFormat: z.string().optional().describe("AutoNumber format for the primary name column using placeholders like 'PREFIX-{SEQNUM:4}-{RANDSTRING:3}-{DATETIMEUTC:yyyyMMdd}'. If specified, the primary name column will be created as an AutoNumber column.")
      }
    },
    async (params) => {
      try {
        if (!client.getSolutionContext()) {
          throw new Error('No solution context available. Please set a solution context using set_solution_context tool first.');
        }

        const ownershipTypeValue = params.ownershipType === "UserOwned" ? "UserOwned" : "OrganizationOwned";

        const entityDefinition = {
          "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
          LogicalName: params.logicalName,
          SchemaName: params.schemaName,
          DisplayName: createLocalizedLabel(params.displayName),
          DisplayCollectionName: createLocalizedLabel(params.displayCollectionName),
          Description: params.description ? createLocalizedLabel(params.description) : undefined,
          OwnershipType: ownershipTypeValue,
          HasActivities: params.hasActivities,
          HasNotes: params.hasNotes,
          IsActivity: false,
          IsCustomEntity: true,
          Attributes: [
            {
              "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
              LogicalName: params.primaryNameLogicalName,
              SchemaName: params.primaryNameSchemaName,
              DisplayName: createLocalizedLabel(params.primaryNameDisplayName),
              Description: createLocalizedLabel(params.primaryNameAutoNumberFormat ? "Primary name attribute (AutoNumber)" : "Primary name attribute"),
              RequiredLevel: {
                Value: "ApplicationRequired",
                CanBeChanged: false,
                ManagedPropertyLogicalName: "canmodifyrequirementlevelsettings"
              },
              MaxLength: params.primaryNameAutoNumberFormat ? 200 : 100, // Increase max length for AutoNumber to allow for format expansion
              Format: "Text",
              IsPrimaryName: true,
              IsCustomAttribute: true,
              ...(params.primaryNameAutoNumberFormat && { AutoNumberFormat: params.primaryNameAutoNumberFormat })
            }
          ]
        };

        const result = await client.postMetadata("EntityDefinitions", entityDefinition);

        return {
          content: [
            {
              type: "text",
              text: `Successfully created table '${params.logicalName}' with display name '${params.displayName}'.\n\nProvided values:\n- Logical Name: ${params.logicalName}\n- Schema Name: ${params.schemaName}\n- Display Collection Name: ${params.displayCollectionName}\n- Primary Name Attribute: ${params.primaryNameLogicalName}${params.primaryNameAutoNumberFormat ? `\n- AutoNumber Format: ${params.primaryNameAutoNumberFormat}` : ''}\n\nResponse: ${JSON.stringify(result, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating table: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function getTableTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_dataverse_table",
    {
      title: "Get Dataverse Table",
      description: "Retrieves detailed information about a specific Dataverse table including its metadata, properties, and configuration. Use this to inspect table definitions and understand table structure.",
      inputSchema: {
        logicalName: z.string().describe("Logical name of the table to retrieve")
      }
    },
    async (params) => {
      try {
        const result = await client.getMetadata<EntityMetadata>(
          `EntityDefinitions(LogicalName='${params.logicalName}')`
        );

        return {
          content: [
            {
              type: "text",
              text: `Table information for '${params.logicalName}':\n\n${JSON.stringify(result, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error retrieving table: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function updateTableTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "update_dataverse_table",
    {
      title: "Update Dataverse Table",
      description: "Updates the properties and configuration of an existing Dataverse table. Use this to modify table settings like display names, descriptions, or feature enablement (activities, notes, auditing, etc.). Changes are published automatically.",
      inputSchema: {
        logicalName: z.string().describe("Logical name of the table to update"),
        displayName: z.string().optional().describe("New display name for the table"),
        displayCollectionName: z.string().optional().describe("New display collection name for the table"),
        description: z.string().optional().describe("New description of the table"),
        hasActivities: z.boolean().optional().describe("Whether the table can have activities"),
        hasNotes: z.boolean().optional().describe("Whether the table can have notes"),
        isAuditEnabled: z.boolean().optional().describe("Whether auditing is enabled"),
        isDuplicateDetectionEnabled: z.boolean().optional().describe("Whether duplicate detection is enabled"),
        isValidForQueue: z.boolean().optional().describe("Whether records can be added to queues"),
        isConnectionsEnabled: z.boolean().optional().describe("Whether connections are enabled"),
        isMailMergeEnabled: z.boolean().optional().describe("Whether mail merge is enabled"),
        isDocumentManagementEnabled: z.boolean().optional().describe("Whether document management is enabled")
      }
    },
    async (params) => {
      try {
        // First, retrieve the current entity definition
        const currentEntity = await client.getMetadata<EntityMetadata>(
          `EntityDefinitions(LogicalName='${params.logicalName}')`
        );

        // Create the updated entity definition by merging current with new values
        const updatedEntity: any = {
          ...currentEntity,
          "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata"
        };

        // Update only the specified properties
        if (params.displayName) {
          updatedEntity.DisplayName = createLocalizedLabel(params.displayName);
        }
        if (params.displayCollectionName) {
          updatedEntity.DisplayCollectionName = createLocalizedLabel(params.displayCollectionName);
        }
        if (params.description) {
          updatedEntity.Description = createLocalizedLabel(params.description);
        }
        if (params.hasActivities !== undefined) {
          updatedEntity.HasActivities = params.hasActivities;
        }
        if (params.hasNotes !== undefined) {
          updatedEntity.HasNotes = params.hasNotes;
        }
        if (params.isAuditEnabled !== undefined) {
          updatedEntity.IsAuditEnabled = {
            Value: params.isAuditEnabled,
            CanBeChanged: true,
            ManagedPropertyLogicalName: "canmodifyauditsettings"
          };
        }
        if (params.isDuplicateDetectionEnabled !== undefined) {
          updatedEntity.IsDuplicateDetectionEnabled = {
            Value: params.isDuplicateDetectionEnabled,
            CanBeChanged: true,
            ManagedPropertyLogicalName: "canmodifyduplicatedetectionsettings"
          };
        }
        if (params.isValidForQueue !== undefined) {
          updatedEntity.IsValidForQueue = {
            Value: params.isValidForQueue,
            CanBeChanged: true,
            ManagedPropertyLogicalName: "canmodifyqueuesettings"
          };
        }
        if (params.isConnectionsEnabled !== undefined) {
          updatedEntity.IsConnectionsEnabled = {
            Value: params.isConnectionsEnabled,
            CanBeChanged: true,
            ManagedPropertyLogicalName: "canmodifyconnectionsettings"
          };
        }
        if (params.isMailMergeEnabled !== undefined) {
          updatedEntity.IsMailMergeEnabled = {
            Value: params.isMailMergeEnabled,
            CanBeChanged: true,
            ManagedPropertyLogicalName: "canmodifymailmergesettings"
          };
        }
        if (params.isDocumentManagementEnabled !== undefined) {
          updatedEntity.IsDocumentManagementEnabled = params.isDocumentManagementEnabled;
        }

        // Use PUT method with MSCRM.MergeLabels header as per Microsoft documentation
        await client.putMetadata(`EntityDefinitions(LogicalName='${params.logicalName}')`, updatedEntity, {
          'MSCRM.MergeLabels': 'true'
        });

        // Publish the changes as required by the API
        await client.callAction('PublishXml', {
          ParameterXml: `<importexportxml><entities><entity>${params.logicalName}</entity></entities></importexportxml>`
        });

        return {
          content: [
            {
              type: "text",
              text: `Successfully updated table '${params.logicalName}' and published changes.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error updating table: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function deleteTableTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "delete_dataverse_table",
    {
      title: "Delete Dataverse Table",
      description: "Permanently deletes a custom table from Dataverse. WARNING: This action cannot be undone and will remove all data in the table. Use with extreme caution and only for tables that are no longer needed.",
      inputSchema: {
        logicalName: z.string().describe("Logical name of the table to delete")
      }
    },
    async (params) => {
      try {
        await client.deleteMetadata(`EntityDefinitions(LogicalName='${params.logicalName}')`);

        return {
          content: [
            {
              type: "text",
              text: `Successfully deleted table '${params.logicalName}'.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error deleting table: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function listTablesTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "list_dataverse_tables",
    {
      title: "List Dataverse Tables",
      description: "Retrieves a list of tables in the Dataverse environment with filtering options. Use this to discover available tables, find custom tables, or get an overview of the data model. Supports filtering by custom/system tables and managed/unmanaged status.",
      inputSchema: {
        customOnly: z.boolean().default(false).describe("Whether to list only custom tables"),
        includeManaged: z.boolean().default(false).describe("Whether to include managed tables"),
        filter: z.string().optional().describe("OData filter expression")
      }
    },
    async (params) => {
      try {
        let queryParams: Record<string, any> = {
          $select: "LogicalName,DisplayName,DisplayCollectionName,IsCustomEntity,IsManaged,OwnershipType,HasActivities,HasNotes"
        };

        let filters: string[] = [];
        
        if (params.customOnly) {
          filters.push("IsCustomEntity eq true");
        }
        
        if (!params.includeManaged) {
          filters.push("IsManaged eq false");
        }

        if (params.filter) {
          filters.push(params.filter);
        }

        if (filters.length > 0) {
          queryParams.$filter = filters.join(" and ");
        }

        const result = await client.getMetadata<ODataResponse<EntityMetadata>>("EntityDefinitions", queryParams);

        const tableList = result.value.map(entity => ({
          logicalName: entity.LogicalName,
          displayName: entity.DisplayName?.UserLocalizedLabel?.Label || entity.LogicalName,
          displayCollectionName: entity.DisplayCollectionName?.UserLocalizedLabel?.Label || "",
          isCustom: entity.IsCustomEntity,
          isManaged: entity.IsManaged,
          ownershipType: entity.OwnershipType,
          hasActivities: entity.HasActivities,
          hasNotes: entity.HasNotes
        }));

        return {
          content: [
            {
              type: "text",
              text: `Found ${tableList.length} tables:\n\n${JSON.stringify(tableList, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing tables: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}