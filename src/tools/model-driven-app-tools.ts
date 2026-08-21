import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";

const appIdSchema = z.string().uuid("Use a model-driven app GUID.");
const sitemapIdSchema = z.string().uuid("Use a sitemap GUID.");

const appComponentTypes = {
  Table: 1,
  View: 26,
  BusinessProcessFlow: 29,
  Chart: 59,
  Form: 60,
  Sitemap: 62
} as const;

const appComponentEntityKeys = {
  Table: { entityType: "entity", key: "entityid" },
  View: { entityType: "savedquery", key: "savedqueryid" },
  BusinessProcessFlow: { entityType: "workflow", key: "workflowid" },
  Chart: { entityType: "savedqueryvisualization", key: "savedqueryvisualizationid" },
  Form: { entityType: "systemform", key: "formid" },
  Sitemap: { entityType: "sitemap", key: "sitemapid" }
} as const;

const appComponentSpecSchema = z.object({
  componentType: z.enum(["Table", "View", "BusinessProcessFlow", "Chart", "Form", "Sitemap"]).describe("Dataverse app component type"),
  objectId: z.string().uuid("Use the artifact GUID for the selected non-table component type.").optional(),
  entityLogicalName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Use a Dataverse table logical name.").optional().describe("Required for Table components. The MCP resolves this to the entity record ID required by AddAppComponents.")
});

type AppComponentSpec = z.infer<typeof appComponentSpecSchema>;
type ResolvedAppComponent = {
  componentType: AppComponentSpec["componentType"];
  objectId: string;
  entityLogicalName?: string;
};

function writeError(operation: string, error: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: `Error ${operation}: ${error instanceof Error ? error.message : "Unknown error"}`
    }],
    isError: true
  };
}

function requireSolutionContext(client: DataverseClient): string {
  const context = client.getSolutionContext();
  if (!context) {
    throw new Error("Set and confirm a solution context before creating a model-driven app.");
  }
  return context.solutionUniqueName;
}

export function createModelDrivenAppTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "create_dataverse_model_driven_app",
    {
      title: "Create Model-Driven App",
      description: "Creates a model-driven app in the active solution. Provide the app's Dataverse-required client, form-factor, navigation, and application-shell web resource values from an approved app design. The tool re-fetches the created app for verification.",
      inputSchema: {
        name: z.string().min(1).max(100).describe("Display name of the app"),
        uniqueName: z.string().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Use an app unique name without spaces or punctuation.").describe("Unique name of the app"),
        publisherId: z.string().uuid("Use a publisher GUID.").describe("Publisher GUID for the app"),
        webResourceId: z.string().uuid("Use a web resource GUID.").describe("Required appmodule webresourceid. Obtain it by retrieving a compatible existing model-driven app; do not invent a GUID."),
        clientType: z.number().int().min(1).max(31).describe("Dataverse AppModule clienttype value approved for this app"),
        formFactor: z.number().int().min(1).max(8).describe("Dataverse AppModule formfactor value approved for this app"),
        navigationType: z.enum(["0", "1"]).default("0").describe("0=Single session, 1=Multi session"),
        description: z.string().max(2000).optional(),
        appGraph: z.string().optional().describe("Optional approved appgraph JSON"),
        configXml: z.string().optional().describe("Optional approved app configuration XML"),
        confirmCreate: z.literal(true).describe("Must be true to create the app")
      }
    },
    async (params) => {
      try {
        const solutionUniqueName = requireSolutionContext(client);
        const created = await client.post("appmodules", {
          name: params.name,
          uniquename: params.uniqueName,
          clienttype: params.clientType,
          formfactor: params.formFactor,
          navigationtype: Number(params.navigationType),
          webresourceid: params.webResourceId,
          isdefault: false,
          description: params.description,
          appgraph: params.appGraph,
          configxml: params.configXml,
          "publisher_appmodule_appmodule@odata.bind": `/publishers(${params.publisherId})`
        }, {
          Prefer: "return=representation",
          "MSCRM.SolutionUniqueName": solutionUniqueName
        });

        const appId = created.appmoduleid;
        if (!appId) {
          throw new Error("Dataverse did not return an appmoduleid for the new app.");
        }
        await addAppToSolution(client, appId, solutionUniqueName);
        const verified = await getUnpublishedApp(client, appId);
        await verifyAppSolutionMembership(client, appId, solutionUniqueName);
        return { content: [{ type: "text", text: `Successfully created and verified model-driven app '${params.name}'.\n\n${JSON.stringify(verified, null, 2)}` }] };
      } catch (error) {
        return writeError("creating model-driven app", error);
      }
    }
  );
}

export function getModelDrivenAppTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_dataverse_model_driven_app",
    {
      title: "Get Model-Driven App",
      description: "Retrieves a model-driven app by its AppModule GUID, including its editable configuration fields.",
      inputSchema: { appId: appIdSchema }
    },
    async (params) => {
      try {
        const app = await getUnpublishedApp(client, params.appId);
        return { content: [{ type: "text", text: JSON.stringify(app, null, 2) }] };
      } catch (error) {
        return writeError("retrieving model-driven app", error);
      }
    }
  );
}

export function listModelDrivenAppsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "list_dataverse_model_driven_apps",
    {
      title: "List Model-Driven Apps",
      description: "Lists model-driven apps in the active Dataverse environment.",
      inputSchema: { nameContains: z.string().max(100).optional().describe("Optional case-insensitive name fragment to filter locally") }
    },
    async (params) => {
      try {
        const response = await client.get("appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,name,uniquename,description,clienttype,formfactor,navigationtype,isdefault,statecode,statuscode,modifiedon");
        const apps = params.nameContains
          ? response.value.filter((app: { name?: string }) => app.name?.toLowerCase().includes(params.nameContains!.toLowerCase()))
          : response.value;
        return { content: [{ type: "text", text: JSON.stringify(apps, null, 2) }] };
      } catch (error) {
        return writeError("listing model-driven apps", error);
      }
    }
  );
}

export function updateModelDrivenAppTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "update_dataverse_model_driven_app",
    {
      title: "Update Model-Driven App",
      description: "Updates approved editable AppModule fields and re-fetches the app to verify the change.",
      inputSchema: {
        appId: appIdSchema,
        updates: z.record(z.unknown()).refine((value) => Object.keys(value).length > 0, "Provide at least one AppModule field to update."),
        confirmUpdate: z.literal(true).describe("Must be true to update the app")
      }
    },
    async (params) => {
      try {
        await client.patch(`appmodules(${params.appId})`, params.updates);
        const verified = await getUnpublishedApp(client, params.appId);
        return { content: [{ type: "text", text: `Successfully updated and verified model-driven app.\n\n${JSON.stringify(verified, null, 2)}` }] };
      } catch (error) {
        return writeError("updating model-driven app", error);
      }
    }
  );
}

export function deleteModelDrivenAppTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "delete_dataverse_model_driven_app",
    {
      title: "Delete Model-Driven App",
      description: "Deletes a model-driven app. This operation cannot be undone; a successful Dataverse delete response confirms completion.",
      inputSchema: { appId: appIdSchema, confirmDelete: z.literal(true).describe("Must be true to delete the app") }
    },
    async (params) => {
      try {
        await client.delete(`appmodules(${params.appId})`);
        return { content: [{ type: "text", text: `Successfully deleted model-driven app '${params.appId}'. Dataverse confirmed the delete response.` }] };
      } catch (error) {
        return writeError("deleting model-driven app", error);
      }
    }
  );
}

export function addModelDrivenAppComponentsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "add_dataverse_model_driven_app_components",
    {
      title: "Add Model-Driven App Components",
      description: "Adds approved typed AppModule components using Dataverse AddAppComponents. The tool serializes each item as the keyed target Dataverse entity and verifies every requested object ID is persisted exactly once.",
      inputSchema: {
        appId: appIdSchema,
        components: z.array(appComponentSpecSchema).min(1).describe("Components to add. For Table, prefer entityLogicalName; objectId is accepted only when it is an actual Dataverse entities.entityid."),
        confirmAdd: z.literal(true).describe("Must be true to add components")
      }
    },
    async (params) => {
      try {
        const resolvedComponents = await resolveAppComponents(client, params.components);
        const components = toActionEntities(resolvedComponents);
        await client.callAction("AddAppComponents", { AppId: params.appId, Components: components });
        const verified = await retrieveAppComponents(client, params.appId);
        verifyComponentObjectIds(verified.value ?? [], resolvedComponents, "add");
        return { content: [{ type: "text", text: `Successfully added components and retrieved the current app component list.\n\nResolved component identities:\n${JSON.stringify(resolvedComponents, null, 2)}\n\nPersisted components:\n${JSON.stringify(verified, null, 2)}` }] };
      } catch (error) {
        return writeError("adding model-driven app components", error);
      }
    }
  );
}

export function removeModelDrivenAppComponentsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "remove_dataverse_model_driven_app_components",
    {
      title: "Remove Model-Driven App Components",
      description: "Removes approved typed AppModule components using Dataverse RemoveAppComponents, then verifies the requested object IDs are absent from persisted app component records.",
      inputSchema: {
        appId: appIdSchema,
        components: z.array(appComponentSpecSchema).min(1).describe("Components to remove. For Table, prefer entityLogicalName; objectId is accepted only when it is an actual Dataverse entities.entityid."),
        confirmRemove: z.literal(true).describe("Must be true to remove components")
      }
    },
    async (params) => {
      try {
        const resolvedComponents = await resolveAppComponents(client, params.components);
        const components = toActionEntities(resolvedComponents);
        await client.callAction("RemoveAppComponents", { AppId: params.appId, Components: components });
        const verified = await retrieveAppComponents(client, params.appId);
        verifyComponentObjectIds(verified.value ?? [], resolvedComponents, "remove");
        return { content: [{ type: "text", text: `Successfully removed components and retrieved the current app component list.\n\nResolved component identities:\n${JSON.stringify(resolvedComponents, null, 2)}\n\nPersisted components:\n${JSON.stringify(verified, null, 2)}` }] };
      } catch (error) {
        return writeError("removing model-driven app components", error);
      }
    }
  );
}

export function getModelDrivenAppComponentsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_dataverse_model_driven_app_components",
    {
      title: "Get Model-Driven App Components",
      description: "Returns persisted app component records for a model-driven app.",
      inputSchema: { appId: appIdSchema }
    },
    async (params) => {
      try {
        const components = await retrieveAppComponents(client, params.appId);
        return { content: [{ type: "text", text: JSON.stringify(components, null, 2) }] };
      } catch (error) {
        return writeError("retrieving model-driven app components", error);
      }
    }
  );
}

export function getModelDrivenAppSitemapTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_dataverse_model_driven_app_sitemap",
    {
      title: "Get Model-Driven App Sitemap",
      description: "Retrieves a sitemap record and its sitemap XML. Use the app's component list to identify the sitemap ID.",
      inputSchema: { sitemapId: sitemapIdSchema }
    },
    async (params) => {
      try {
        const sitemap = await client.get(`sitemaps(${params.sitemapId})`);
        return { content: [{ type: "text", text: JSON.stringify(sitemap, null, 2) }] };
      } catch (error) {
        return writeError("retrieving model-driven app sitemap", error);
      }
    }
  );
}

export function updateModelDrivenAppSitemapTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "update_dataverse_model_driven_app_sitemap",
    {
      title: "Update Model-Driven App Sitemap",
      description: "Updates approved sitemap XML and re-fetches the sitemap to verify the stored configuration. Publishing remains a separate explicit operation.",
      inputSchema: {
        sitemapId: sitemapIdSchema,
        sitemapXml: z.string().min(1).describe("Complete approved sitemap XML"),
        confirmUpdate: z.literal(true).describe("Must be true to update the sitemap")
      }
    },
    async (params) => {
      try {
        await client.patch(`sitemaps(${params.sitemapId})`, { sitemapxml: params.sitemapXml });
        const verified = await client.get(`sitemaps(${params.sitemapId})`);
        return { content: [{ type: "text", text: `Successfully updated and retrieved sitemap '${params.sitemapId}'. Publish customizations explicitly before expecting the app navigation to change.\n\n${JSON.stringify(verified, null, 2)}` }] };
      } catch (error) {
        return writeError("updating model-driven app sitemap", error);
      }
    }
  );
}

export function validateModelDrivenAppTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "validate_dataverse_model_driven_app",
    {
      title: "Validate Model-Driven App",
      description: "Runs Dataverse ValidateApp for a model-driven app without publishing it.",
      inputSchema: { appId: appIdSchema }
    },
    async (params) => {
      try {
        const validation = await client.get(`Microsoft.Dynamics.CRM.ValidateApp(AppModuleId=${params.appId})`);
        return { content: [{ type: "text", text: JSON.stringify(validation, null, 2) }] };
      } catch (error) {
        return writeError("validating model-driven app", error);
      }
    }
  );
}

async function retrieveAppComponents(client: DataverseClient, appId: string) {
  const app = await getUnpublishedApp(client, appId);
  const appModuleIdUnique = app.appmoduleidunique;
  if (!appModuleIdUnique) {
    throw new Error(`Model-driven app '${appId}' did not return appmoduleidunique for component lookup.`);
  }
  return client.get(`appmodulecomponents?$filter=_appmoduleidunique_value eq ${appModuleIdUnique}&$select=appmodulecomponentid,componenttype,objectid,isdefault,ismetadata,rootcomponentbehavior,rootappmodulecomponentid`);
}

async function getUnpublishedApp(client: DataverseClient, appId: string) {
  return client.get(`appmodules(${appId})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`);
}

async function resolveAppComponents(client: DataverseClient, components: AppComponentSpec[]): Promise<ResolvedAppComponent[]> {
  return Promise.all(components.map(async (component) => {
    if (component.componentType !== "Table") {
      if (!component.objectId) {
        throw new Error(`${component.componentType} components require objectId.`);
      }
      return { componentType: component.componentType, objectId: component.objectId as string };
    }

    const entity = component.entityLogicalName
      ? await getEntityByLogicalName(client, component.entityLogicalName)
      : component.objectId
        ? await getEntityById(client, component.objectId)
        : undefined;
    if (!entity?.entityid || entity.logicalname?.toLowerCase() === "entity") {
      throw new Error("Table components require entityLogicalName, or an objectId that is a valid concrete EntityDefinition MetadataId. The abstract base 'entity' definition cannot be added as an app table component.");
    }
    return {
      componentType: component.componentType,
      objectId: entity.entityid,
      entityLogicalName: entity.logicalname
    };
  }));
}

async function getEntityByLogicalName(client: DataverseClient, entityLogicalName: string) {
  const escapedLogicalName = entityLogicalName.replace(/'/g, "''");
  try {
    const definition = await client.getMetadata(`EntityDefinitions(LogicalName='${escapedLogicalName}')?$select=MetadataId,LogicalName`);
    return definition?.MetadataId
      ? { entityid: definition.MetadataId, logicalname: definition.LogicalName }
      : undefined;
  } catch {
    return undefined;
  }
}

async function getEntityById(client: DataverseClient, entityId: string) {
  try {
    const definition = await client.getMetadata(`EntityDefinitions(${entityId})?$select=MetadataId,LogicalName`);
    return definition?.MetadataId
      ? { entityid: definition.MetadataId, logicalname: definition.LogicalName }
      : undefined;
  } catch {
    return undefined;
  }
}

function toActionEntities(components: ResolvedAppComponent[]) {
  return components.map((component) => {
    const target = appComponentEntityKeys[component.componentType];
    return {
      "@odata.type": `Microsoft.Dynamics.CRM.${target.entityType}`,
      [target.key]: component.objectId
    };
  });
}

function verifyComponentObjectIds(
  persistedComponents: Array<{ componenttype?: number; objectid?: string }>,
  expectedComponents: ResolvedAppComponent[],
  operation: "add" | "remove"
) {
  const persistedKeys = new Set(persistedComponents.map((component) => `${component.componenttype}:${component.objectid?.toLowerCase()}`));
  const unexpected = expectedComponents.filter((component) => {
    const key = `${appComponentTypes[component.componentType]}:${component.objectId.toLowerCase()}`;
    return operation === "add" ? !persistedKeys.has(key) : persistedKeys.has(key);
  });

  if (unexpected.length > 0) {
    throw new Error(`App component ${operation} could not be verified for: ${unexpected.map((component) => `${component.componentType} ${component.entityLogicalName ?? component.objectId} (${component.objectId})`).join(", ")}. The operation may have created or retained different components; inspect the returned app component list before retrying.`);
  }
}

async function addAppToSolution(client: DataverseClient, appId: string, solutionUniqueName: string) {
  await client.callAction("AddSolutionComponent", {
    ComponentId: appId,
    ComponentType: 80,
    SolutionUniqueName: solutionUniqueName,
    AddRequiredComponents: false,
    DoNotIncludeSubcomponents: true
  });
}

async function verifyAppSolutionMembership(client: DataverseClient, appId: string, solutionUniqueName: string) {
  const components = await client.get(`solutioncomponents?$filter=objectid eq ${appId} and componenttype eq 80&$expand=solutionid($select=uniquename)`);
  const isMember = components.value?.some((component: { solutionid?: { uniquename?: string } }) => component.solutionid?.uniquename === solutionUniqueName);
  if (!isMember) {
    throw new Error(`Model-driven app '${appId}' was created but could not be verified as a component of solution '${solutionUniqueName}'.`);
  }
}