import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";
import { OneToManyRelationshipMetadata, ManyToManyRelationshipMetadata, ODataResponse, LocalizedLabel } from "../types.js";

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

export function createRelationshipTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "create_dataverse_relationship",
    {
      title: "Create Dataverse Relationship",
      description: "Creates a relationship between two Dataverse tables. Supports One-to-Many relationships (parent-child with lookup field) and Many-to-Many relationships (junction table). Use this to establish data connections between tables, enable navigation, and maintain referential integrity.",
      inputSchema: {
        relationshipType: z.enum(["OneToMany", "ManyToMany"]).describe("Type of relationship to create"),
        schemaName: z.string().describe("Schema name for the relationship (e.g., 'new_account_contact')"),
        
        // One-to-Many specific fields
        referencedEntity: z.string().optional().describe("Referenced (parent) entity logical name for One-to-Many relationships"),
        referencingEntity: z.string().optional().describe("Referencing (child) entity logical name for One-to-Many relationships"),
        referencingAttributeLogicalName: z.string().optional().describe("Complete logical name for the lookup attribute to be created"),
        referencingAttributeSchemaName: z.string().optional().describe("Complete schema name for the lookup attribute. Must exactly match referencingAttributeLogicalName."),
        referencingAttributeDisplayName: z.string().optional().describe("Display name for the lookup attribute"),
        
        // Many-to-Many specific fields
        entity1LogicalName: z.string().optional().describe("First entity logical name for Many-to-Many relationships"),
        entity2LogicalName: z.string().optional().describe("Second entity logical name for Many-to-Many relationships"),
        intersectEntityName: z.string().optional().describe("Name for the intersect entity"),
        
        // Cascade configuration for One-to-Many
        cascadeAssign: z.enum(["NoCascade", "Cascade", "Active", "UserOwned", "RemoveLink", "Restrict"]).default("NoCascade").describe("Cascade behavior for assign operations"),
        cascadeDelete: z.enum(["NoCascade", "Cascade", "Active", "UserOwned", "RemoveLink", "Restrict"]).default("RemoveLink").describe("Cascade behavior for delete operations"),
        cascadeMerge: z.enum(["NoCascade", "Cascade", "Active", "UserOwned", "RemoveLink", "Restrict"]).default("NoCascade").describe("Cascade behavior for merge operations"),
        cascadeReparent: z.enum(["NoCascade", "Cascade", "Active", "UserOwned", "RemoveLink", "Restrict"]).default("NoCascade").describe("Cascade behavior for reparent operations"),
        cascadeShare: z.enum(["NoCascade", "Cascade", "Active", "UserOwned", "RemoveLink", "Restrict"]).default("NoCascade").describe("Cascade behavior for share operations"),
        cascadeUnshare: z.enum(["NoCascade", "Cascade", "Active", "UserOwned", "RemoveLink", "Restrict"]).default("NoCascade").describe("Cascade behavior for unshare operations"),
        cascadeRollupView: z.enum(["NoCascade", "Cascade", "Active", "UserOwned", "RemoveLink", "Restrict"]).default("NoCascade").describe("Cascade behavior for the Activity Associated View rollup"),
        
        // Associated menu configuration
        menuBehavior: z.enum(["UseCollectionName", "UseLabel", "DoNotDisplay"]).default("UseCollectionName").describe("How the relationship appears in associated menus. For Many-to-Many, used as the default for both entities unless entity1MenuBehavior/entity2MenuBehavior are supplied."),
        menuGroup: z.enum(["Details", "Sales", "Service", "Marketing"]).default("Details").describe("Menu group for the relationship"),
        menuLabel: z.string().optional().describe("Custom label for the menu (required if menuBehavior is UseLabel)"),
        menuOrder: z.number().optional().describe("Order in the menu"),

        // Many-to-Many per-entity menu configuration overrides
        entity1MenuBehavior: z.enum(["UseCollectionName", "UseLabel", "DoNotDisplay"]).optional().describe("Overrides menuBehavior for entity1's associated menu (Many-to-Many only)"),
        entity1MenuGroup: z.enum(["Details", "Sales", "Service", "Marketing"]).optional().describe("Overrides menuGroup for entity1's associated menu (Many-to-Many only)"),
        entity1MenuLabel: z.string().optional().describe("Overrides menuLabel for entity1's associated menu (Many-to-Many only)"),
        entity1MenuOrder: z.number().optional().describe("Overrides menuOrder for entity1's associated menu (Many-to-Many only)"),
        entity2MenuBehavior: z.enum(["UseCollectionName", "UseLabel", "DoNotDisplay"]).optional().describe("Overrides menuBehavior for entity2's associated menu (Many-to-Many only)"),
        entity2MenuGroup: z.enum(["Details", "Sales", "Service", "Marketing"]).optional().describe("Overrides menuGroup for entity2's associated menu (Many-to-Many only)"),
        entity2MenuLabel: z.string().optional().describe("Overrides menuLabel for entity2's associated menu (Many-to-Many only)"),
        entity2MenuOrder: z.number().optional().describe("Overrides menuOrder for entity2's associated menu (Many-to-Many only)"),

        isValidForAdvancedFind: z.boolean().default(true).describe("Whether the relationship is valid for Advanced Find"),
        isHierarchical: z.boolean().default(false).describe("Whether this is a hierarchical relationship (One-to-Many only)")
      }
    },
    async (params) => {
      try {
        if (params.relationshipType === "OneToMany") {
          if (!params.referencedEntity || !params.referencingEntity || !params.referencingAttributeLogicalName || !params.referencingAttributeSchemaName || !params.referencingAttributeDisplayName) {
            throw new Error("For One-to-Many relationships, referencedEntity, referencingEntity, referencingAttributeLogicalName, referencingAttributeSchemaName, and referencingAttributeDisplayName are required");
          }

          const cascadeConfig = {
            Assign: getCascadeValue(params.cascadeAssign),
            Delete: getCascadeValue(params.cascadeDelete),
            Merge: getCascadeValue(params.cascadeMerge),
            Reparent: getCascadeValue(params.cascadeReparent),
            Share: getCascadeValue(params.cascadeShare),
            Unshare: getCascadeValue(params.cascadeUnshare),
            RollupView: getCascadeValue(params.cascadeRollupView)
          };

          const menuConfig = {
            Behavior: getMenuBehaviorValue(params.menuBehavior),
            Group: getMenuGroupValue(params.menuGroup),
            Label: params.menuLabel ? createLocalizedLabel(params.menuLabel) : undefined,
            Order: params.menuOrder
          };

          const relationshipDefinition = {
            "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
            SchemaName: params.schemaName,
            ReferencedEntity: params.referencedEntity,
            ReferencingEntity: params.referencingEntity,
            CascadeConfiguration: cascadeConfig,
            AssociatedMenuConfiguration: menuConfig,
            IsValidForAdvancedFind: params.isValidForAdvancedFind,
            IsHierarchical: params.isHierarchical,
            IsCustomRelationship: true,
            Lookup: {
              "@odata.type": "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
              LogicalName: params.referencingAttributeLogicalName,
              SchemaName: params.referencingAttributeSchemaName,
              DisplayName: createLocalizedLabel(params.referencingAttributeDisplayName),
              RequiredLevel: {
                Value: "None",
                CanBeChanged: true,
                ManagedPropertyLogicalName: "canmodifyrequirementlevelsettings"
              },
              Targets: [params.referencedEntity],
              IsCustomAttribute: true
            }
          };

          const result = await client.postMetadata("RelationshipDefinitions", relationshipDefinition);

          return {
            content: [
              {
                type: "text",
                text: `Successfully created One-to-Many relationship '${params.schemaName}' between '${params.referencedEntity}' and '${params.referencingEntity}'.\n\nResponse: ${JSON.stringify(result, null, 2)}`
              }
            ]
          };

        } else { // ManyToMany
          if (!params.entity1LogicalName || !params.entity2LogicalName || !params.intersectEntityName) {
            throw new Error("For Many-to-Many relationships, entity1LogicalName, entity2LogicalName, and intersectEntityName are required");
          }

          const menuConfig1 = {
            Behavior: getMenuBehaviorValue(params.entity1MenuBehavior ?? params.menuBehavior),
            Group: getMenuGroupValue(params.entity1MenuGroup ?? params.menuGroup),
            Label: (params.entity1MenuLabel ?? params.menuLabel) ? createLocalizedLabel((params.entity1MenuLabel ?? params.menuLabel)!) : undefined,
            Order: params.entity1MenuOrder ?? params.menuOrder
          };

          const menuConfig2 = {
            Behavior: getMenuBehaviorValue(params.entity2MenuBehavior ?? params.menuBehavior),
            Group: getMenuGroupValue(params.entity2MenuGroup ?? params.menuGroup),
            Label: (params.entity2MenuLabel ?? params.menuLabel) ? createLocalizedLabel((params.entity2MenuLabel ?? params.menuLabel)!) : undefined,
            Order: params.entity2MenuOrder ?? params.menuOrder
          };

          const relationshipDefinition = {
            "@odata.type": "Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata",
            SchemaName: params.schemaName,
            Entity1LogicalName: params.entity1LogicalName,
            Entity1AssociatedMenuConfiguration: menuConfig1,
            Entity2LogicalName: params.entity2LogicalName,
            Entity2AssociatedMenuConfiguration: menuConfig2,
            IntersectEntityName: params.intersectEntityName,
            IsValidForAdvancedFind: params.isValidForAdvancedFind,
            IsCustomRelationship: true
          };

          const result = await client.postMetadata("RelationshipDefinitions", relationshipDefinition);

          return {
            content: [
              {
                type: "text",
                text: `Successfully created Many-to-Many relationship '${params.schemaName}' between '${params.entity1LogicalName}' and '${params.entity2LogicalName}'.\n\nResponse: ${JSON.stringify(result, null, 2)}`
              }
            ]
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating relationship: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

const cascadeEnum = z.enum(["NoCascade", "Cascade", "Active", "UserOwned", "RemoveLink", "Restrict"]);
const menuBehaviorEnum = z.enum(["UseCollectionName", "UseLabel", "DoNotDisplay"]);
const menuGroupEnum = z.enum(["Details", "Sales", "Service", "Marketing"]);

export function updateRelationshipTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "update_dataverse_relationship",
    {
      title: "Update Dataverse Relationship",
      description: "Updates an existing Dataverse relationship's cascade behaviors, associated menu configuration, and Advanced Find/hierarchical flags. Only supplied fields are changed; every other setting is read from the current relationship and preserved unchanged.",
      inputSchema: {
        relationshipType: z.enum(["OneToMany", "ManyToMany"]).describe("Type of the existing relationship being updated"),
        schemaName: z.string().describe("Schema name of the relationship to update"),

        // One-to-Many cascade configuration (optional; unset fields keep their current value)
        cascadeAssign: cascadeEnum.optional().describe("Cascade behavior for assign operations (One-to-Many only)"),
        cascadeDelete: cascadeEnum.optional().describe("Cascade behavior for delete operations (One-to-Many only)"),
        cascadeMerge: cascadeEnum.optional().describe("Cascade behavior for merge operations (One-to-Many only)"),
        cascadeReparent: cascadeEnum.optional().describe("Cascade behavior for reparent operations (One-to-Many only)"),
        cascadeShare: cascadeEnum.optional().describe("Cascade behavior for share operations (One-to-Many only)"),
        cascadeUnshare: cascadeEnum.optional().describe("Cascade behavior for unshare operations (One-to-Many only)"),
        cascadeRollupView: cascadeEnum.optional().describe("Cascade behavior for the Activity Associated View rollup (One-to-Many only)"),
        isHierarchical: z.boolean().optional().describe("Whether this is the hierarchical self-referential relationship (One-to-Many only)"),

        // One-to-Many associated menu configuration (optional)
        menuBehavior: menuBehaviorEnum.optional().describe("How the relationship appears in associated menus (One-to-Many only)"),
        menuGroup: menuGroupEnum.optional().describe("Menu group for the relationship (One-to-Many only)"),
        menuLabel: z.string().optional().describe("Custom label for the menu, required if menuBehavior is UseLabel (One-to-Many only)"),
        menuOrder: z.number().optional().describe("Order in the menu (One-to-Many only)"),

        // Many-to-Many per-entity associated menu configuration (optional)
        entity1MenuBehavior: menuBehaviorEnum.optional().describe("How the relationship appears in entity1's associated menu (Many-to-Many only)"),
        entity1MenuGroup: menuGroupEnum.optional().describe("Menu group for entity1's associated menu (Many-to-Many only)"),
        entity1MenuLabel: z.string().optional().describe("Custom label for entity1's associated menu (Many-to-Many only)"),
        entity1MenuOrder: z.number().optional().describe("Order in entity1's associated menu (Many-to-Many only)"),
        entity2MenuBehavior: menuBehaviorEnum.optional().describe("How the relationship appears in entity2's associated menu (Many-to-Many only)"),
        entity2MenuGroup: menuGroupEnum.optional().describe("Menu group for entity2's associated menu (Many-to-Many only)"),
        entity2MenuLabel: z.string().optional().describe("Custom label for entity2's associated menu (Many-to-Many only)"),
        entity2MenuOrder: z.number().optional().describe("Order in entity2's associated menu (Many-to-Many only)"),

        isValidForAdvancedFind: z.boolean().optional().describe("Whether the relationship is valid for Advanced Find")
      }
    },
    async (params) => {
      try {
        if (params.relationshipType === "OneToMany") {
          const current = await client.getMetadata<any>(
            `RelationshipDefinitions(SchemaName='${params.schemaName}')/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata`,
            { $select: "SchemaName,CascadeConfiguration,AssociatedMenuConfiguration,IsValidForAdvancedFind,IsHierarchical" }
          );

          const currentCascade = current.CascadeConfiguration || {};
          const currentMenu = current.AssociatedMenuConfiguration || {};

          const cascadeConfig = {
            Assign: params.cascadeAssign !== undefined ? getCascadeValue(params.cascadeAssign) : currentCascade.Assign,
            Delete: params.cascadeDelete !== undefined ? getCascadeValue(params.cascadeDelete) : currentCascade.Delete,
            Merge: params.cascadeMerge !== undefined ? getCascadeValue(params.cascadeMerge) : currentCascade.Merge,
            Reparent: params.cascadeReparent !== undefined ? getCascadeValue(params.cascadeReparent) : currentCascade.Reparent,
            Share: params.cascadeShare !== undefined ? getCascadeValue(params.cascadeShare) : currentCascade.Share,
            Unshare: params.cascadeUnshare !== undefined ? getCascadeValue(params.cascadeUnshare) : currentCascade.Unshare,
            RollupView: params.cascadeRollupView !== undefined ? getCascadeValue(params.cascadeRollupView) : currentCascade.RollupView
          };

          const menuConfig = {
            Behavior: params.menuBehavior !== undefined ? getMenuBehaviorValue(params.menuBehavior) : currentMenu.Behavior,
            Group: params.menuGroup !== undefined ? getMenuGroupValue(params.menuGroup) : currentMenu.Group,
            Label: params.menuLabel !== undefined ? createLocalizedLabel(params.menuLabel) : currentMenu.Label,
            Order: params.menuOrder !== undefined ? params.menuOrder : currentMenu.Order
          };

          const updatePayload = {
            "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
            CascadeConfiguration: cascadeConfig,
            AssociatedMenuConfiguration: menuConfig,
            IsValidForAdvancedFind: params.isValidForAdvancedFind !== undefined ? params.isValidForAdvancedFind : current.IsValidForAdvancedFind,
            IsHierarchical: params.isHierarchical !== undefined ? params.isHierarchical : current.IsHierarchical
          };

          await client.patchMetadata(`RelationshipDefinitions(SchemaName='${params.schemaName}')`, updatePayload);

          return {
            content: [
              {
                type: "text",
                text: `Successfully updated One-to-Many relationship '${params.schemaName}'.\n\nApplied cascade configuration: ${JSON.stringify(cascadeConfig, null, 2)}\n\nApplied menu configuration: ${JSON.stringify(menuConfig, null, 2)}`
              }
            ]
          };
        } else { // ManyToMany
          const current = await client.getMetadata<any>(
            `RelationshipDefinitions(SchemaName='${params.schemaName}')/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata`,
            { $select: "SchemaName,Entity1AssociatedMenuConfiguration,Entity2AssociatedMenuConfiguration,IsValidForAdvancedFind" }
          );

          const currentMenu1 = current.Entity1AssociatedMenuConfiguration || {};
          const currentMenu2 = current.Entity2AssociatedMenuConfiguration || {};

          const menuConfig1 = {
            Behavior: params.entity1MenuBehavior !== undefined ? getMenuBehaviorValue(params.entity1MenuBehavior) : currentMenu1.Behavior,
            Group: params.entity1MenuGroup !== undefined ? getMenuGroupValue(params.entity1MenuGroup) : currentMenu1.Group,
            Label: params.entity1MenuLabel !== undefined ? createLocalizedLabel(params.entity1MenuLabel) : currentMenu1.Label,
            Order: params.entity1MenuOrder !== undefined ? params.entity1MenuOrder : currentMenu1.Order
          };

          const menuConfig2 = {
            Behavior: params.entity2MenuBehavior !== undefined ? getMenuBehaviorValue(params.entity2MenuBehavior) : currentMenu2.Behavior,
            Group: params.entity2MenuGroup !== undefined ? getMenuGroupValue(params.entity2MenuGroup) : currentMenu2.Group,
            Label: params.entity2MenuLabel !== undefined ? createLocalizedLabel(params.entity2MenuLabel) : currentMenu2.Label,
            Order: params.entity2MenuOrder !== undefined ? params.entity2MenuOrder : currentMenu2.Order
          };

          const updatePayload = {
            "@odata.type": "Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata",
            Entity1AssociatedMenuConfiguration: menuConfig1,
            Entity2AssociatedMenuConfiguration: menuConfig2,
            IsValidForAdvancedFind: params.isValidForAdvancedFind !== undefined ? params.isValidForAdvancedFind : current.IsValidForAdvancedFind
          };

          await client.patchMetadata(`RelationshipDefinitions(SchemaName='${params.schemaName}')`, updatePayload);

          return {
            content: [
              {
                type: "text",
                text: `Successfully updated Many-to-Many relationship '${params.schemaName}'.\n\nApplied entity1 menu configuration: ${JSON.stringify(menuConfig1, null, 2)}\n\nApplied entity2 menu configuration: ${JSON.stringify(menuConfig2, null, 2)}`
              }
            ]
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error updating relationship: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

function getCascadeValue(cascade: string): string {
  // Return the string value directly instead of numeric
  return cascade;
}

function getMenuBehaviorValue(behavior: string): string {
  // Return the string value directly instead of numeric
  return behavior;
}

function getMenuGroupValue(group: string): string {
  // Return the string value directly instead of numeric
  return group;
}

export function getRelationshipTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_dataverse_relationship",
    {
      title: "Get Dataverse Relationship",
      description: "Retrieves detailed information about a specific relationship between Dataverse tables, including its configuration, cascade settings, and menu behavior. Use this to inspect relationship definitions and understand table connections.",
      inputSchema: {
        schemaName: z.string().describe("Schema name of the relationship to retrieve")
      }
    },
    async (params) => {
      try {
        const result = await client.getMetadata(
          `RelationshipDefinitions(SchemaName='${params.schemaName}')`
        );

        return {
          content: [
            {
              type: "text",
              text: `Relationship information for '${params.schemaName}':\n\n${JSON.stringify(result, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error retrieving relationship: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function deleteRelationshipTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "delete_dataverse_relationship",
    {
      title: "Delete Dataverse Relationship",
      description: "Permanently deletes a relationship between Dataverse tables. WARNING: This action cannot be undone and will remove the connection between tables, including any lookup fields for One-to-Many relationships. Use with extreme caution.",
      inputSchema: {
        schemaName: z.string().describe("Schema name of the relationship to delete")
      }
    },
    async (params) => {
      try {
        await client.deleteMetadata(`RelationshipDefinitions(SchemaName='${params.schemaName}')`);

        return {
          content: [
            {
              type: "text",
              text: `Successfully deleted relationship '${params.schemaName}'.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error deleting relationship: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function listRelationshipsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "list_dataverse_relationships",
    {
      title: "List Dataverse Relationships",
      description: "Retrieves a list of relationships in the Dataverse environment with filtering options. Use this to discover table connections, find custom relationships, or get an overview of the data model relationships. Supports filtering by entity, relationship type, and managed/unmanaged status.",
      inputSchema: {
        entityLogicalName: z.string().optional().describe("Filter relationships for a specific entity"),
        relationshipType: z.enum(["OneToMany", "ManyToMany", "All"]).default("All").describe("Type of relationships to list"),
        customOnly: z.boolean().default(false).describe("Whether to list only custom relationships"),
        includeManaged: z.boolean().default(false).describe("Whether to include managed relationships"),
        filter: z.string().optional().describe("OData filter expression")
      }
    },
    async (params) => {
      try {
        let allRelationships: (OneToManyRelationshipMetadata | ManyToManyRelationshipMetadata)[] = [];

        // Build base filters
        const baseFilters = [];
        if (params.customOnly) {
          baseFilters.push("IsCustomRelationship eq true");
        }
        if (!params.includeManaged) {
          baseFilters.push("IsManaged eq false");
        }
        if (params.filter) {
          baseFilters.push(params.filter);
        }

        // Handle different relationship type scenarios using the correct cast syntax
        if (params.relationshipType === "OneToMany" || params.relationshipType === "All") {
          // Query OneToMany relationships using cast syntax
          const oneToManyFilters = [...baseFilters];
          if (params.entityLogicalName) {
            oneToManyFilters.push(`(ReferencedEntity eq '${params.entityLogicalName}' or ReferencingEntity eq '${params.entityLogicalName}')`);
          }

          const oneToManyParams: Record<string, any> = {
            $select: "SchemaName,RelationshipType,IsCustomRelationship,IsManaged,IsValidForAdvancedFind,ReferencedEntity,ReferencingEntity,ReferencingAttribute,IsHierarchical"
          };
          
          if (oneToManyFilters.length > 0) {
            oneToManyParams.$filter = oneToManyFilters.join(" and ");
          }


          const oneToManyResult = await client.getMetadata<ODataResponse<OneToManyRelationshipMetadata>>(
            "RelationshipDefinitions/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
            oneToManyParams
          );
          allRelationships.push(...oneToManyResult.value);
        }

        if (params.relationshipType === "ManyToMany" || params.relationshipType === "All") {
          // Query ManyToMany relationships using cast syntax
          const manyToManyFilters = [...baseFilters];
          if (params.entityLogicalName) {
            manyToManyFilters.push(`(Entity1LogicalName eq '${params.entityLogicalName}' or Entity2LogicalName eq '${params.entityLogicalName}')`);
          }

          const manyToManyParams: Record<string, any> = {
            $select: "SchemaName,RelationshipType,IsCustomRelationship,IsManaged,IsValidForAdvancedFind,Entity1LogicalName,Entity2LogicalName,IntersectEntityName"
          };
          
          if (manyToManyFilters.length > 0) {
            manyToManyParams.$filter = manyToManyFilters.join(" and ");
          }


          const manyToManyResult = await client.getMetadata<ODataResponse<ManyToManyRelationshipMetadata>>(
            "RelationshipDefinitions/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata",
            manyToManyParams
          );
          allRelationships.push(...manyToManyResult.value);
        }

        // Note: $top parameter is not supported by Dataverse metadata endpoints

        const relationshipList = allRelationships.map(relationship => {
          // Determine relationship type based on the presence of specific properties
          // rather than the RelationshipType enum value
          const isOneToMany = 'ReferencedEntity' in relationship && 'ReferencingEntity' in relationship;
          const relationshipType = isOneToMany ? "OneToMany" : "ManyToMany";
          
          const baseInfo = {
            schemaName: relationship.SchemaName,
            relationshipType: relationshipType,
            isCustom: relationship.IsCustomRelationship,
            isManaged: relationship.IsManaged,
            isValidForAdvancedFind: relationship.IsValidForAdvancedFind
          };

          if (isOneToMany) {
            // OneToMany
            const oneToMany = relationship as OneToManyRelationshipMetadata;
            return {
              ...baseInfo,
              referencedEntity: oneToMany.ReferencedEntity,
              referencingEntity: oneToMany.ReferencingEntity,
              referencingAttribute: oneToMany.ReferencingAttribute,
              isHierarchical: oneToMany.IsHierarchical
            };
          } else {
            // ManyToMany
            const manyToMany = relationship as ManyToManyRelationshipMetadata;
            return {
              ...baseInfo,
              entity1LogicalName: manyToMany.Entity1LogicalName,
              entity2LogicalName: manyToMany.Entity2LogicalName,
              intersectEntityName: manyToMany.IntersectEntityName
            };
          }
        });

        return {
          content: [
            {
              type: "text",
              text: `Found ${relationshipList.length} relationships${params.entityLogicalName ? ` for entity '${params.entityLogicalName}'` : ''}:\n\n${JSON.stringify(relationshipList, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing relationships: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}