import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";
import { AttributeMetadata, ODataResponse, LocalizedLabel } from "../types.js";

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

export function createColumnTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "create_dataverse_column",
    {
      title: "Create Dataverse Column",
      description: "Creates a new column (field) in a Dataverse table with the specified data type and configuration. The caller must provide matching schemaName and logicalName values, including the publisher prefix, using its own naming conventions. Requires a solution context to be set first.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table to add the column to"),
        displayName: z.string().describe("Display name for the column (e.g., 'Customer Email')"),
        schemaName: z.string().describe("Complete schema name, including the publisher prefix. Must exactly match logicalName."),
        logicalName: z.string().describe("Complete logical name, including the publisher prefix. Must exactly match schemaName."),
        description: z.string().optional().describe("Description of the column"),
        columnType: z.enum([
          "String", "Integer", "Decimal", "Money", "Boolean", "DateTime",
          "Picklist", "Lookup", "Memo", "Double", "BigInt"
        ]).describe("Type of the column"),
        requiredLevel: z.enum(["None", "SystemRequired", "ApplicationRequired", "Recommended"]).default("None").describe("Required level of the column"),
        isAuditEnabled: z.boolean().optional().describe("Whether auditing is enabled for this column"),
        isValidForAdvancedFind: z.boolean().optional().describe("Whether the column appears in Advanced Find"),
        isValidForCreate: z.boolean().optional().describe("Whether the column can be set during create"),
        isValidForUpdate: z.boolean().optional().describe("Whether the column can be updated"),
        // String-specific options
        maxLength: z.number().optional().describe("Maximum length for string columns (default: 100)"),
        format: z.enum(["Email", "Text", "TextArea", "Url", "Phone"]).optional().describe("Format for string columns"),
        memoFormat: z.enum(["PlainText", "RichText"]).default("PlainText").describe("Format for Memo columns. RichText stores formatted HTML; PlainText creates a standard multiline text field."),
        // Integer-specific options
        minValue: z.number().optional().describe("Minimum value for integer/decimal columns"),
        maxValue: z.number().optional().describe("Maximum value for integer/decimal columns"),
        // Decimal-specific options
        precision: z.number().optional().describe("Precision for decimal columns (default: 2)"),
        // DateTime-specific options
        dateTimeFormat: z.enum(["DateOnly", "DateAndTime"]).optional().describe("Format for datetime columns"),
        dateTimeBehavior: z.enum(["UserLocal", "TimeZoneIndependent", "DateOnly"]).default("UserLocal").describe("Storage behavior for DateTime columns. UserLocal adjusts displayed values for each user's time zone; TimeZoneIndependent preserves the entered date/time without time-zone adjustment; DateOnly stores only the date."),
        // Boolean-specific options
        trueOptionLabel: z.string().optional().describe("Label for true option in boolean columns (default: 'Yes')"),
        falseOptionLabel: z.string().optional().describe("Label for false option in boolean columns (default: 'No')"),
        defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional().describe("Default value for the column"),
        // Lookup-specific options
        targetEntity: z.string().optional().describe("Target entity for lookup columns"),
        // Picklist-specific options
        optionSetName: z.string().optional().describe("Name of the option set for picklist columns"),
        options: z.array(z.object({
          value: z.number(),
          label: z.string(),
          description: z.string().optional()
        })).optional().describe("Options for picklist columns"),
        defaultOptionValue: z.number().optional().describe("Default option value for Picklist columns. The value must exist in the selected local or global option set.")
      }
    },
    async (params) => {
      try {
        if (!client.getSolutionContext()) {
          throw new Error('No solution context available. Please set a solution context using set_solution_context tool first.');
        }

        const { logicalName, schemaName } = params;

        let attributeDefinition: any = {
          LogicalName: logicalName,
          SchemaName: schemaName,
          DisplayName: createLocalizedLabel(params.displayName),
          Description: params.description ? createLocalizedLabel(params.description) : undefined,
          RequiredLevel: {
            Value: params.requiredLevel,
            CanBeChanged: true,
            ManagedPropertyLogicalName: "canmodifyrequirementlevelsettings"
          },
          IsCustomAttribute: true
        };

        // Set type-specific properties
        switch (params.columnType) {
          case "String":
            attributeDefinition["@odata.type"] = "Microsoft.Dynamics.CRM.StringAttributeMetadata";
            attributeDefinition.MaxLength = params.maxLength || 100;
            // Remove Format property for now to avoid enum issues
            if (params.defaultValue && typeof params.defaultValue === "string") {
              attributeDefinition.DefaultValue = params.defaultValue;
            }
            break;

          case "Integer":
            attributeDefinition["@odata.type"] = "Microsoft.Dynamics.CRM.IntegerAttributeMetadata";
            // Remove Format property for now to avoid enum issues
            if (params.minValue !== undefined) attributeDefinition.MinValue = params.minValue;
            if (params.maxValue !== undefined) attributeDefinition.MaxValue = params.maxValue;
            // Note: IntegerAttributeMetadata doesn't support DefaultValue property
            break;

          case "Decimal":
            attributeDefinition["@odata.type"] = "Microsoft.Dynamics.CRM.DecimalAttributeMetadata";
            attributeDefinition.Precision = params.precision || 2;
            if (params.minValue !== undefined) attributeDefinition.MinValue = params.minValue;
            if (params.maxValue !== undefined) attributeDefinition.MaxValue = params.maxValue;
            if (params.defaultValue && typeof params.defaultValue === "number") {
              attributeDefinition.DefaultValue = params.defaultValue;
            }
            break;

          case "Money":
            attributeDefinition["@odata.type"] = "Microsoft.Dynamics.CRM.MoneyAttributeMetadata";
            attributeDefinition.Precision = params.precision || 2;
            if (params.minValue !== undefined) attributeDefinition.MinValue = params.minValue;
            if (params.maxValue !== undefined) attributeDefinition.MaxValue = params.maxValue;
            break;

          case "Boolean":
            attributeDefinition["@odata.type"] = "Microsoft.Dynamics.CRM.BooleanAttributeMetadata";
            attributeDefinition.OptionSet = {
              "@odata.type": "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata",
              TrueOption: {
                Value: 1,
                Label: createLocalizedLabel(params.trueOptionLabel || "Yes")
              },
              FalseOption: {
                Value: 0,
                Label: createLocalizedLabel(params.falseOptionLabel || "No")
              }
            };
            if (params.defaultValue && typeof params.defaultValue === "boolean") {
              attributeDefinition.DefaultValue = params.defaultValue;
            }
            break;

          case "DateTime":
            attributeDefinition["@odata.type"] = "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata";
            attributeDefinition.DateTimeBehavior = { Value: params.dateTimeBehavior };
            attributeDefinition.Format = params.dateTimeBehavior === "DateOnly" || params.dateTimeFormat === "DateOnly" ? 0 : 1;
            break;

          case "Memo":
            attributeDefinition["@odata.type"] = "Microsoft.Dynamics.CRM.MemoAttributeMetadata";
            attributeDefinition.MaxLength = params.maxLength || 2000;
            if (params.memoFormat === "RichText") {
              attributeDefinition.Format = 9;
              attributeDefinition.FormatName = { Value: "RichText" };
            } else {
              attributeDefinition.Format = 2;
              attributeDefinition.FormatName = { Value: "TextArea" };
            }
            break;

          case "Double":
            attributeDefinition["@odata.type"] = "Microsoft.Dynamics.CRM.DoubleAttributeMetadata";
            if (params.minValue !== undefined) attributeDefinition.MinValue = params.minValue;
            if (params.maxValue !== undefined) attributeDefinition.MaxValue = params.maxValue;
            attributeDefinition.Precision = params.precision || 2;
            break;

          case "BigInt":
            attributeDefinition["@odata.type"] = "Microsoft.Dynamics.CRM.BigIntAttributeMetadata";
            break;

          case "Lookup":
            if (!params.targetEntity) {
              throw new Error("targetEntity is required for Lookup columns");
            }
            attributeDefinition["@odata.type"] = "Microsoft.Dynamics.CRM.LookupAttributeMetadata";
            attributeDefinition.Targets = [params.targetEntity];
            break;

          case "Picklist":
            attributeDefinition["@odata.type"] = "Microsoft.Dynamics.CRM.PicklistAttributeMetadata";
            if (params.defaultOptionValue !== undefined) {
              attributeDefinition.DefaultFormValue = params.defaultOptionValue;
            }
            if (params.optionSetName) {
              // Reference an existing global option set using the MetadataId
              // First get the option set to retrieve its MetadataId
              try {
                const globalOptionSet = await client.getMetadata(
                  `GlobalOptionSetDefinitions(Name='${params.optionSetName}')`
                );
                attributeDefinition["GlobalOptionSet@odata.bind"] = `/GlobalOptionSetDefinitions(${globalOptionSet.MetadataId})`;
              } catch (error) {
                throw new Error(`Global option set '${params.optionSetName}' not found: ${error instanceof Error ? error.message : 'Unknown error'}`);
              }
            } else if (params.options && params.options.length > 0) {
              if (params.defaultOptionValue !== undefined && !params.options.some(option => option.value === params.defaultOptionValue)) {
                throw new Error(`defaultOptionValue '${params.defaultOptionValue}' must match a value in the local options array.`);
              }
              // Create a new local option set
              attributeDefinition.OptionSet = {
                "@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata",
                Name: `${params.entityLogicalName}_${logicalName}`,
                DisplayName: createLocalizedLabel(`${params.displayName} Options`),
                IsGlobal: false,
                OptionSetType: "Picklist", // Use string value instead of numeric
                Options: params.options.map(option => ({
                  Value: option.value,
                  Label: createLocalizedLabel(option.label),
                  Description: option.description ? createLocalizedLabel(option.description) : undefined
                }))
              };
            } else {
              throw new Error("Either optionSetName (for global option set) or options array (for local option set) is required for Picklist columns");
            }
            break;

          default:
            throw new Error(`Unsupported column type: ${params.columnType}`);
        }

        const result = await client.postMetadata(
          `EntityDefinitions(LogicalName='${params.entityLogicalName}')/Attributes`,
          attributeDefinition
        );

        return {
          content: [
            {
              type: "text",
              text: `Successfully created column '${logicalName}' with display name '${params.displayName}' of type '${params.columnType}' in table '${params.entityLogicalName}'.\n\nProvided names:\n- Logical Name: ${logicalName}\n- Schema Name: ${schemaName}\n\nResponse: ${JSON.stringify(result, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating column: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function getColumnTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_dataverse_column",
    {
      title: "Get Dataverse Column",
      description: "Retrieves detailed information about a specific column in a Dataverse table, including its data type, properties, and configuration settings. Use this to inspect column definitions and understand field structure.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table"),
        logicalName: z.string().describe("Logical name of the column to retrieve")
      }
    },
    async (params) => {
      try {
        // Retrieve the base attribute metadata
        const attribute = await client.getMetadata<AttributeMetadata>(
          `EntityDefinitions(LogicalName='${params.entityLogicalName}')/Attributes(LogicalName='${params.logicalName}')`
        );

        // Prepare enhanced payload that can include navigationProperty when applicable
        const enhanced: any = { ...attribute };

        // Determine if this is a Lookup attribute using multiple heuristics for robustness
        const attrType: any = (attribute as any)?.AttributeType;
        const odataType: string | undefined = (attribute as any)?.["@odata.type"];
        const isLookup =
          (typeof attrType === "string" && attrType.toLowerCase() === "lookup") ||
          (typeof attrType === "number" && attrType === 6) || // AttributeTypeCode.Lookup
          (typeof odataType === "string" && odataType.toLowerCase().includes("lookupattributemetadata"));

        if (isLookup) {
          try {
            // Query ManyToOneRelationships for this entity to map ReferencingAttribute -> ReferencingEntityNavigationPropertyName
            const relationshipsUrl =
              `EntityDefinitions(LogicalName='${params.entityLogicalName}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencingEntityNavigationPropertyName`;

            const relationshipsResponse: any = await client.getMetadata(relationshipsUrl);

            // Find the relationship entry that matches the current attribute logical name
            const match = relationshipsResponse?.value?.find(
              (rel: any) =>
                typeof rel?.ReferencingAttribute === "string" &&
                rel.ReferencingAttribute.toLowerCase() === params.logicalName.toLowerCase()
            );

            if (match?.ReferencingEntityNavigationPropertyName) {
              enhanced.navigationProperty = match.ReferencingEntityNavigationPropertyName;
            }
          } catch (relError) {
            // Do not fail the tool for relationship lookup issues; just omit navigationProperty
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Column information for '${params.logicalName}' in table '${params.entityLogicalName}':\n\n${JSON.stringify(enhanced, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error retrieving column: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function updateColumnTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "update_dataverse_column",
    {
      title: "Update Dataverse Column",
      description: "Updates the properties and configuration of an existing column in a Dataverse table. Use this to modify column settings like display names, descriptions, required levels, or audit settings. Note that data type cannot be changed after creation.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table"),
        logicalName: z.string().describe("Logical name of the column to update"),
        displayName: z.string().optional().describe("New display name for the column"),
        description: z.string().optional().describe("New description of the column"),
        requiredLevel: z.enum(["None", "SystemRequired", "ApplicationRequired", "Recommended"]).optional().describe("New required level of the column"),
        isAuditEnabled: z.boolean().optional().describe("Whether auditing is enabled for this column"),
        isValidForAdvancedFind: z.boolean().optional().describe("Whether the column appears in Advanced Find"),
        isValidForCreate: z.boolean().optional().describe("Whether the column can be set during create"),
        isValidForUpdate: z.boolean().optional().describe("Whether the column can be updated"),
        memoFormat: z.enum(["PlainText", "RichText"]).optional().describe("New format for a Memo column. RichText stores formatted HTML; PlainText creates a standard multiline text field."),
        dateTimeBehavior: z.enum(["UserLocal", "TimeZoneIndependent", "DateOnly"]).optional().describe("New storage behavior for a DateTime column. Dataverse permits behavior changes only when the column is customizable and its current behavior supports the requested transition."),
        dateTimeFormat: z.enum(["DateOnly", "DateAndTime"]).optional().describe("New display format for a DateTime column"),
        defaultOptionValue: z.number().optional().describe("New default option value for a Picklist column. The value must exist in the column's option set.")
      }
    },
    async (params) => {
      try {
        // First, retrieve the current attribute definition
        const currentAttribute = await client.getMetadata<AttributeMetadata>(
          `EntityDefinitions(LogicalName='${params.entityLogicalName}')/Attributes(LogicalName='${params.logicalName}')`
        );

        // Create the updated attribute definition by merging current with new values
        const updatedAttribute: any = {
          ...currentAttribute,
          "@odata.type": currentAttribute["@odata.type"]
        };
        const attributeType = (currentAttribute as any).AttributeType;
        const attributeTypeName = (currentAttribute as any).AttributeTypeName?.Value;
        const odataType = currentAttribute["@odata.type"] || "";
        const isDateTime = attributeType === 2 || attributeTypeName === "DateTimeType" || odataType.includes("DateTimeAttributeMetadata");
        const isMemo = attributeType === 7 || attributeTypeName === "MemoType" || odataType.includes("MemoAttributeMetadata");
        const isPicklist = attributeType === 11 || attributeTypeName === "PicklistType" || odataType.includes("PicklistAttributeMetadata");

        // Update only the specified properties
        if (params.displayName) {
          updatedAttribute.DisplayName = createLocalizedLabel(params.displayName);
        }
        if (params.description) {
          updatedAttribute.Description = createLocalizedLabel(params.description);
        }
        if (params.requiredLevel) {
          updatedAttribute.RequiredLevel = {
            Value: params.requiredLevel,
            CanBeChanged: true,
            ManagedPropertyLogicalName: "canmodifyrequirementlevelsettings"
          };
        }
        if (params.isAuditEnabled !== undefined) {
          updatedAttribute.IsAuditEnabled = {
            Value: params.isAuditEnabled,
            CanBeChanged: true,
            ManagedPropertyLogicalName: "canmodifyauditsettings"
          };
        }
        if (params.isValidForAdvancedFind !== undefined) {
          updatedAttribute.IsValidForAdvancedFind = params.isValidForAdvancedFind;
        }
        if (params.isValidForCreate !== undefined) {
          updatedAttribute.IsValidForCreate = params.isValidForCreate;
        }
        if (params.isValidForUpdate !== undefined) {
          updatedAttribute.IsValidForUpdate = params.isValidForUpdate;
        }
        if (params.memoFormat) {
          if (!isMemo) {
            throw new Error("memoFormat can only be updated on a Memo column.");
          }
          if (params.memoFormat === "RichText") {
            updatedAttribute.Format = 9;
            updatedAttribute.FormatName = { Value: "RichText" };
          } else {
            updatedAttribute.Format = 2;
            updatedAttribute.FormatName = { Value: "TextArea" };
          }
        }
        if (params.dateTimeBehavior || params.dateTimeFormat) {
          if (!isDateTime) {
            throw new Error("dateTimeBehavior and dateTimeFormat can only be updated on a DateTime column.");
          }

          const currentBehavior = (currentAttribute as any).DateTimeBehavior?.Value;
          const canChangeBehavior = (currentAttribute as any).CanChangeDateTimeBehavior?.Value;
          if (params.dateTimeBehavior && params.dateTimeBehavior !== currentBehavior) {
            if (canChangeBehavior === false) {
              throw new Error(`DateTime behavior for column '${params.logicalName}' cannot be changed.`);
            }
            if (currentBehavior === "DateOnly" || currentBehavior === "TimeZoneIndependent") {
              throw new Error(`DateTime behavior cannot be changed from '${currentBehavior}' to '${params.dateTimeBehavior}'. Dataverse only permits supported transitions from UserLocal.`);
            }
            updatedAttribute.DateTimeBehavior = { Value: params.dateTimeBehavior };
          }

          const effectiveBehavior = params.dateTimeBehavior || currentBehavior;
          const effectiveFormat = params.dateTimeFormat || (currentAttribute as any).FormatName?.Value;
          if (effectiveBehavior === "DateOnly" && effectiveFormat === "DateAndTime") {
            throw new Error("DateOnly behavior requires dateTimeFormat to be DateOnly.");
          }
          if (params.dateTimeFormat) {
            updatedAttribute.Format = params.dateTimeFormat === "DateOnly" ? 0 : 1;
            updatedAttribute.FormatName = { Value: params.dateTimeFormat };
          }
        }
        if (params.defaultOptionValue !== undefined) {
          if (!isPicklist) {
            throw new Error("defaultOptionValue can only be updated on a Picklist column.");
          }
          updatedAttribute.DefaultFormValue = params.defaultOptionValue;
        }

        // Use PUT method with MSCRM.MergeLabels header as per Microsoft documentation
        await client.putMetadata(
          `EntityDefinitions(LogicalName='${params.entityLogicalName}')/Attributes(LogicalName='${params.logicalName}')`,
          updatedAttribute,
          {
            'MSCRM.MergeLabels': 'true'
          }
        );

        if (params.dateTimeBehavior || params.dateTimeFormat) {
          await client.callAction("PublishXml", {
            ParameterXml: `<importexportxml><entities><entity>${params.entityLogicalName}</entity></entities></importexportxml>`
          });
        }

        return {
          content: [
            {
              type: "text",
              text: `Successfully updated column '${params.logicalName}' in table '${params.entityLogicalName}'.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error updating column: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function deleteColumnTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "delete_dataverse_column",
    {
      title: "Delete Dataverse Column",
      description: "Permanently deletes a column from a Dataverse table. WARNING: This action cannot be undone and will remove all data stored in this column. Use with extreme caution and only for columns that are no longer needed.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table"),
        logicalName: z.string().describe("Logical name of the column to delete")
      }
    },
    async (params) => {
      try {
        await client.deleteMetadata(
          `EntityDefinitions(LogicalName='${params.entityLogicalName}')/Attributes(LogicalName='${params.logicalName}')`
        );

        return {
          content: [
            {
              type: "text",
              text: `Successfully deleted column '${params.logicalName}' from table '${params.entityLogicalName}'.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error deleting column: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function listColumnsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "list_dataverse_columns",
    {
      title: "List Dataverse Columns",
      description: "Retrieves a list of columns in a specific Dataverse table with filtering options. Use this to discover available fields in a table, find custom columns, or get an overview of the table structure. Supports filtering by custom/system columns and managed/unmanaged status.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table"),
        customOnly: z.boolean().default(false).describe("Whether to list only custom columns"),
        includeManaged: z.boolean().default(false).describe("Whether to include managed columns"),
        filter: z.string().optional().describe("OData filter expression")
      }
    },
    async (params) => {
      try {
        let queryParams: Record<string, any> = {
          $select: "LogicalName,DisplayName,AttributeType,AttributeTypeName,IsCustomAttribute,IsManaged,RequiredLevel,IsPrimaryId,IsPrimaryName"
        };

        let filters: string[] = [];
        
        if (params.customOnly) {
          filters.push("IsCustomAttribute eq true");
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

        const result = await client.getMetadata<ODataResponse<AttributeMetadata>>(
          `EntityDefinitions(LogicalName='${params.entityLogicalName}')/Attributes`,
          queryParams
        );

        const columnList = result.value.map(attribute => ({
          logicalName: attribute.LogicalName,
          displayName: attribute.DisplayName?.UserLocalizedLabel?.Label || attribute.LogicalName,
          attributeType: attribute.AttributeType,
          attributeTypeName: attribute.AttributeTypeName?.Value || "",
          isCustom: attribute.IsCustomAttribute,
          isManaged: attribute.IsManaged,
          requiredLevel: attribute.RequiredLevel?.Value || "None",
          isPrimaryId: attribute.IsPrimaryId,
          isPrimaryName: attribute.IsPrimaryName
        }));

        return {
          content: [
            {
              type: "text",
              text: `Found ${columnList.length} columns in table '${params.entityLogicalName}':\n\n${JSON.stringify(columnList, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing columns: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}