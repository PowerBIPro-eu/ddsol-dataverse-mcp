import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";

const STATUS_ATTRIBUTE_LOGICAL_NAME = "statuscode";
const STATE_ATTRIBUTE_LOGICAL_NAME = "statecode";

const stateSchema = z.enum(["Active", "Inactive"]);

function getStateCode(state: "Active" | "Inactive"): number {
  return state === "Active" ? 0 : 1;
}

function createLocalizedLabel(text: string, languageCode = 1033) {
  return {
    LocalizedLabels: [{
      Label: text,
      LanguageCode: languageCode
    }]
  };
}

function statusReasonEndpoint(entityLogicalName: string, attributeLogicalName: string): string {
  const attributeType = attributeLogicalName === STATUS_ATTRIBUTE_LOGICAL_NAME
    ? "StatusAttributeMetadata"
    : "StateAttributeMetadata";
  return `EntityDefinitions(LogicalName='${entityLogicalName}')/Attributes(LogicalName='${attributeLogicalName}')/Microsoft.Dynamics.CRM.${attributeType}?$expand=OptionSet`;
}

async function getStatusMetadata(client: DataverseClient, entityLogicalName: string): Promise<any> {
  const metadata = await client.getMetadata<any>(
    statusReasonEndpoint(entityLogicalName, STATUS_ATTRIBUTE_LOGICAL_NAME)
  );

  return metadata;
}

export function getStatusReasonsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_dataverse_status_reasons",
    {
      title: "Get Dataverse Status Reasons",
      description: "Lists the system Status Reason options for a table, grouped by Active and Inactive state. Includes the state association, option value, and current default status reason where available.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table")
      }
    },
    async (params) => {
      try {
        const statusMetadata = await getStatusMetadata(client, params.entityLogicalName);
        const stateMetadata = await client.getMetadata<any>(
          statusReasonEndpoint(params.entityLogicalName, STATE_ATTRIBUTE_LOGICAL_NAME)
        );
        const defaultStatusByState = new Map<number, number | undefined>(
          (stateMetadata?.OptionSet?.Options || []).map((option: any) => [option.Value, option.DefaultStatus])
        );
        const reasons = (statusMetadata?.OptionSet?.Options || []).map((option: any) => ({
          value: option.Value,
          label: option.Label?.UserLocalizedLabel?.Label || "",
          state: option.State === 0 ? "Active" : option.State === 1 ? "Inactive" : `StateCode ${option.State}`,
          stateCode: option.State,
          isDefaultForState: defaultStatusByState.get(option.State) === option.Value,
          isManaged: option.IsManaged
        }));

        return {
          content: [{
            type: "text",
            text: `Status Reasons for table '${params.entityLogicalName}':\n\n${JSON.stringify(reasons, null, 2)}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error retrieving Status Reasons: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
}

export function addStatusReasonTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "add_dataverse_status_reason",
    {
      title: "Add Dataverse Status Reason",
      description: "Adds a custom Status Reason to the Active or Inactive state of a table. Status Reasons are system statuscode options and are not ordinary Picklist values.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table"),
        state: stateSchema.describe("State to associate with the new Status Reason"),
        label: z.string().describe("Display label for the new Status Reason"),
        value: z.number().optional().describe("Optional numeric value for the new Status Reason. Omit to let Dataverse allocate a value."),
        description: z.string().optional().describe("Description of the new Status Reason"),
        color: z.string().optional().describe("Optional hexadecimal color for the new Status Reason")
      }
    },
    async (params) => {
      try {
        if (!client.getSolutionContext()) {
          throw new Error("No solution context available. Please set a solution context using set_solution_context tool first.");
        }
        await getStatusMetadata(client, params.entityLogicalName);

        const response = await client.callAction<any>("InsertStatusValue", {
          EntityLogicalName: params.entityLogicalName,
          AttributeLogicalName: STATUS_ATTRIBUTE_LOGICAL_NAME,
          StateCode: getStateCode(params.state),
          Label: createLocalizedLabel(params.label),
          ...(params.value !== undefined && { Value: params.value }),
          ...(params.description && { Description: createLocalizedLabel(params.description) }),
          ...(params.color && { Color: params.color }),
          SolutionUniqueName: client.getSolutionUniqueName()
        });

        return {
          content: [{
            type: "text",
            text: `Successfully added Status Reason '${params.label}' to the ${params.state} state of table '${params.entityLogicalName}'.\n\nResponse: ${JSON.stringify(response, null, 2)}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error adding Status Reason: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
}

export function updateStatusReasonTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "update_dataverse_status_reason",
    {
      title: "Update Dataverse Status Reason",
      description: "Updates the label, description, or color of an existing system Status Reason. The Status Reason remains associated with its existing Active or Inactive state.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table"),
        value: z.number().describe("Numeric value of the Status Reason to update"),
        label: z.string().optional().describe("New display label"),
        description: z.string().optional().describe("New description"),
        color: z.string().optional().describe("New hexadecimal color")
      }
    },
    async (params) => {
      try {
        if (!params.label && !params.description && !params.color) {
          throw new Error("Provide at least one of label, description, or color.");
        }
        await getStatusMetadata(client, params.entityLogicalName);

        await client.callAction("UpdateOptionValue", {
          EntityLogicalName: params.entityLogicalName,
          AttributeLogicalName: STATUS_ATTRIBUTE_LOGICAL_NAME,
          Value: params.value,
          MergeLabels: true,
          ...(params.label && { Label: createLocalizedLabel(params.label) }),
          ...(params.description && { Description: createLocalizedLabel(params.description) }),
          ...(params.color && { Color: params.color }),
          SolutionUniqueName: client.getSolutionUniqueName()
        });

        return {
          content: [{
            type: "text",
            text: `Successfully updated Status Reason '${params.value}' on table '${params.entityLogicalName}'.`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error updating Status Reason: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
}

export function deleteStatusReasonTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "delete_dataverse_status_reason",
    {
      title: "Delete Dataverse Status Reason",
      description: "Permanently deletes a custom Status Reason from a table. Dataverse does not allow deletion of required or managed system reasons.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table"),
        value: z.number().describe("Numeric value of the Status Reason to delete")
      }
    },
    async (params) => {
      try {
        await getStatusMetadata(client, params.entityLogicalName);
        await client.callAction("DeleteOptionValue", {
          EntityLogicalName: params.entityLogicalName,
          AttributeLogicalName: STATUS_ATTRIBUTE_LOGICAL_NAME,
          Value: params.value,
          SolutionUniqueName: client.getSolutionUniqueName()
        });

        return {
          content: [{
            type: "text",
            text: `Successfully deleted Status Reason '${params.value}' from table '${params.entityLogicalName}'.`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error deleting Status Reason: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
}

export function setStatusReasonDefaultTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "set_dataverse_status_reason_default",
    {
      title: "Set Dataverse Status Reason Default",
      description: "Sets the default Status Reason for the Active or Inactive state of a table.",
      inputSchema: {
        entityLogicalName: z.string().describe("Logical name of the table"),
        state: stateSchema.describe("State whose default Status Reason will be set"),
        statusReasonValue: z.number().describe("Status Reason value associated with the selected state")
      }
    },
    async (params) => {
      try {
        const statusMetadata = await getStatusMetadata(client, params.entityLogicalName);
        const stateCode = getStateCode(params.state);
        const statusReason = (statusMetadata?.OptionSet?.Options || []).find((option: any) => option.Value === params.statusReasonValue);
        if (!statusReason) {
          throw new Error(`Status Reason '${params.statusReasonValue}' was not found on table '${params.entityLogicalName}'.`);
        }
        if (statusReason.State !== stateCode) {
          throw new Error(`Status Reason '${params.statusReasonValue}' belongs to state code '${statusReason.State}', not the ${params.state} state.`);
        }

        await client.callAction("UpdateStateValue", {
          EntityLogicalName: params.entityLogicalName,
          AttributeLogicalName: STATE_ATTRIBUTE_LOGICAL_NAME,
          Value: stateCode,
          DefaultStatusCode: params.statusReasonValue,
          MergeLabels: true
        });

        return {
          content: [{
            type: "text",
            text: `Successfully set Status Reason '${params.statusReasonValue}' as the default for the ${params.state} state of table '${params.entityLogicalName}'.`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error setting default Status Reason: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
}