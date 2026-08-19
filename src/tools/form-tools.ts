import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";

// Form types for systemform records
const FORM_TYPES: Record<string, number> = {
  Dashboard: 0,
  AppointmentBook: 1,
  Main: 2,
  MiniCampaignBO: 3,
  Preview: 4,
  MobileExpress: 5,
  QuickView: 6,
  QuickCreate: 7,
  Dialog: 8,
  TaskFlow: 9,
  InteractionCentricDashboard: 10,
  Card: 11,
  MainInteractiveExperience: 12,
  ContextualDashboard: 13
};

// Solution component type for systemform
const FORM_COMPONENT_TYPE = 60;

async function addFormToSolutionIfContextSet(client: DataverseClient, formId: string): Promise<void> {
  const solutionUniqueName = client.getSolutionUniqueName();
  if (!solutionUniqueName) return;
  await client.callAction('AddSolutionComponent', {
    ComponentId: formId,
    ComponentType: FORM_COMPONENT_TYPE,
    SolutionUniqueName: solutionUniqueName,
    AddRequiredComponents: false,
    DoNotIncludeSubcomponents: true
  });
}

export function createFormTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "create_dataverse_form",
    {
      title: "Create Dataverse Form",
      description: "Creates a new form (systemform) for a table from raw FormXML. There is no schema-builder API for forms, so a complete, valid FormXML document must be supplied (e.g. exported/cloned from an existing form and modified). Automatically adds the form to the current solution context if one is set.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table the form is for (e.g. 'account')"),
        name: z.string().describe("Name of the form"),
        formXml: z.string().describe("Complete FormXML document defining tabs, sections, and controls"),
        type: z.enum(Object.keys(FORM_TYPES) as [string, ...string[]]).default("Main").describe("Type of form to create"),
        description: z.string().optional().describe("Description of the form"),
        isDefault: z.boolean().default(false).describe("Whether this is the default form of its type for the table")
      }
    },
    async (params) => {
      try {
        const systemForm = {
          name: params.name,
          objecttypecode: params.entityLogicalName,
          formxml: params.formXml,
          type: FORM_TYPES[params.type],
          description: params.description,
          isdefault: params.isDefault
        };

        const result = await client.post<{ formid: string }>("systemforms", systemForm);

        // The Web API doesn't return the created record body by default; fetch its id.
        let formId = result?.formid;
        if (!formId) {
          const created = await client.get<{ value: { formid: string }[] }>(
            `systemforms?$filter=name eq '${params.name.replace(/'/g, "''")}' and objecttypecode eq '${params.entityLogicalName}'&$select=formid&$orderby=overwritetime desc&$top=1`
          );
          formId = created.value?.[0]?.formid;
        }

        if (formId) {
          await addFormToSolutionIfContextSet(client, formId);
        }

        return {
          content: [
            {
              type: "text",
              text: `Successfully created ${params.type} form '${params.name}' for table '${params.entityLogicalName}'${formId ? ` (formid: ${formId})` : ''}.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating form: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function getFormTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_dataverse_form",
    {
      title: "Get Dataverse Form",
      description: "Retrieves a form (systemform) by its ID, including the FormXML. Useful for cloning an existing form's XML as the starting point for a new one.",
      inputSchema: {
        formId: z.string().describe("GUID of the form (formid)")
      }
    },
    async (params) => {
      try {
        const result = await client.get(`systemforms(${params.formId})`);
        return {
          content: [
            {
              type: "text",
              text: `Form information:\n\n${JSON.stringify(result, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error retrieving form: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function updateFormTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "update_dataverse_form",
    {
      title: "Update Dataverse Form",
      description: "Updates an existing form (systemform). Only provided fields are changed.",
      inputSchema: {
        formId: z.string().describe("GUID of the form (formid) to update"),
        name: z.string().optional().describe("New name for the form"),
        description: z.string().optional().describe("New description for the form"),
        formXml: z.string().optional().describe("New FormXML for the form"),
        isDefault: z.boolean().optional().describe("Whether this is the default form of its type for the table")
      }
    },
    async (params) => {
      try {
        const update: Record<string, any> = {};
        if (params.name !== undefined) update.name = params.name;
        if (params.description !== undefined) update.description = params.description;
        if (params.formXml !== undefined) update.formxml = params.formXml;
        if (params.isDefault !== undefined) update.isdefault = params.isDefault;

        if (Object.keys(update).length === 0) {
          throw new Error("At least one field to update must be provided");
        }

        await client.patch(`systemforms(${params.formId})`, update);

        return {
          content: [
            {
              type: "text",
              text: `Successfully updated form '${params.formId}'.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error updating form: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function deleteFormTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "delete_dataverse_form",
    {
      title: "Delete Dataverse Form",
      description: "Permanently deletes a form (systemform). WARNING: This action cannot be undone.",
      inputSchema: {
        formId: z.string().describe("GUID of the form (formid) to delete")
      }
    },
    async (params) => {
      try {
        await client.delete(`systemforms(${params.formId})`);
        return {
          content: [
            {
              type: "text",
              text: `Successfully deleted form '${params.formId}'.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error deleting form: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

export function listFormsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "list_dataverse_forms",
    {
      title: "List Dataverse Forms",
      description: "Lists forms (systemform) for a table, optionally filtered by form type.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table to list forms for (e.g. 'account')"),
        type: z.enum(Object.keys(FORM_TYPES) as [string, ...string[]]).optional().describe("Filter by form type"),
        includeManaged: z.boolean().default(true).describe("Whether to include managed forms")
      }
    },
    async (params) => {
      try {
        const filters = [`objecttypecode eq '${params.entityLogicalName}'`];
        if (params.type) {
          filters.push(`type eq ${FORM_TYPES[params.type]}`);
        }
        if (!params.includeManaged) {
          filters.push("ismanaged eq false");
        }

        const result = await client.get<{ value: any[] }>(
          `systemforms?$filter=${filters.join(" and ")}&$select=formid,name,description,type,isdefault,ismanaged`
        );

        return {
          content: [
            {
              type: "text",
              text: `Found ${result.value.length} form(s) for table '${params.entityLogicalName}':\n\n${JSON.stringify(result.value, null, 2)}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing forms: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ],
          isError: true
        };
      }
    }
  );
}
