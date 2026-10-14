import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { DataverseClient } from "../dataverse-client.js";
import {
  ATTRIBUTE_TYPE_TO_BPF_COLUMN_TYPE,
  ATTRIBUTE_TYPE_TO_BPF_VALUE_TYPE,
  BPF_CONTROL_CLASS_IDS,
  BPF_STAGE_CATEGORIES,
  BpfBuildResult,
  BpfDefinition,
  buildBusinessProcessFlowXaml,
  extractWorkflowIdFromXaml,
  isGuid,
  parseBusinessProcessFlowXaml,
  setWorkflowIdInXaml,
  stageCategoryLabel,
  summarizeBusinessProcessFlow
} from "./bpf-xaml.js";

// Solution component type for workflow (process) rows
const WORKFLOW_COMPONENT_TYPE = 29;
const BPF_CATEGORY = 4;
const WORKFLOW_TYPE_DEFINITION = 1;
const BPF_SELECT = "workflowid,name,uniquename,description,primaryentity,category,type,businessprocesstype,scope,mode,statecode,statuscode,processorder,ismanaged,iscustomizable,createdon,modifiedon";

const STATE_LABELS: Record<number, string> = { 0: "Draft", 1: "Activated", 2: "Suspended" };
const BUSINESS_PROCESS_TYPES: Record<string, number> = { BusinessFlow: 0, TaskFlow: 1 };

// ---------------------------------------------------------------------------
// Zod schema for the compact BPF definition
// ---------------------------------------------------------------------------

const columnTypeSchema = z.enum(["boolean", "picklist", "status", "lookup", "string", "url", "memo", "integer", "decimal", "money", "datetime"]);
const valueTypeSchema = z.enum(["picklist", "status", "state", "boolean", "integer", "decimal", "string"]);
const operatorSchema = z.enum(["Equal", "NotEqual", "GreaterThan", "GreaterEqual", "LessThan", "LessEqual", "Contains", "DoesNotContain"]);
const literalSchema = z.union([z.string(), z.number(), z.boolean()]);

const stepSchema = z.object({
  id: z.string().optional().describe("ProcessStepId GUID; generated when omitted"),
  column: z.string().describe("Logical name of the column shown in the step"),
  label: z.string().optional().describe("Step label; defaults to the column display name"),
  controlDisplayName: z.string().optional().describe("Column display name; resolved from metadata when omitted"),
  type: columnTypeSchema.optional().describe("Column type used to pick the control ClassId; resolved from metadata when omitted"),
  classId: z.string().optional().describe("Explicit control ClassId (overrides type)"),
  required: z.boolean().optional().describe("Whether the step must be completed before leaving the stage")
});

const branchSchema = z.object({
  column: z.string().describe("Column of the stage's table that the condition reads"),
  operator: operatorSchema.optional().describe("Comparison operator; defaults to Equal"),
  valueType: valueTypeSchema.optional().describe("Type of the literal value(s); resolved from metadata when omitted"),
  values: z.array(literalSchema).optional().describe("Literal values; several values with Equal/NotEqual mean 'any of'"),
  value: literalSchema.optional().describe("Single literal value"),
  compareToColumn: z.string().optional().describe("Compare against another column of the same table instead of a literal"),
  nextStage: z.string().describe("Stage name (or id) to jump to when the condition is true"),
  label: z.string().optional().describe("Branch description shown in the designer")
});

const stageSchema = z.object({
  id: z.string().optional().describe("StageId GUID; generated when omitted"),
  name: z.string().describe("Stage name"),
  category: z.union([z.number().int(), z.string()]).optional().describe(`Stage category: -1..7 or ${Object.keys(BPF_STAGE_CATEGORIES).join("/")}; defaults to -1 (none)`),
  nextStage: z.string().nullable().optional().describe("Default next stage (name or id); defaults to the next stage in order, null ends the process"),
  relationship: z.object({
    sourceStage: z.string().describe("Stage on the previous table that leads into this stage"),
    relationshipName: z.string().describe("Schema name of the 1:N relationship from the previous table to this stage's table"),
    attributeName: z.string().describe("Lookup column on this stage's table that points to the previous table")
  }).optional().describe("Required when this stage's table differs from the stage it follows"),
  steps: z.array(stepSchema).optional().describe("Data steps shown in the stage"),
  branches: z.array(branchSchema).optional().describe("Conditional branches evaluated when leaving the stage"),
  elseStage: z.string().optional().describe("Stage taken when no branch matches"),
  isClosedLoop: z.boolean().optional().describe("EntityComposite IsClosedLoop flag; defaults to false")
});

const definitionSchema = z.object({
  workflowId: z.string().optional().describe("workflowid GUID embedded in the XAML; generated when omitted"),
  segments: z.array(z.object({
    entity: z.string().describe("Logical name of the table whose columns these stages show"),
    stages: z.array(stageSchema).min(1)
  })).min(1).describe("Entity segments in process order; the first segment must be the primary entity")
}).describe("Compact BPF definition: entity segments -> stages -> steps/branches");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function solutionHeaders(client: DataverseClient): Record<string, string> | undefined {
  const name = client.getSolutionUniqueName();
  return name ? { "MSCRM.SolutionUniqueName": name } : undefined;
}

function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}

function errorResult(action: string, error: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error ${action}: ${error instanceof Error ? error.message : "Unknown error"}` }],
    isError: true
  };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function normalizeWorkflowId(id: string): string {
  const v = id.trim().replace(/^\{|\}$/g, "").toLowerCase();
  if (!isGuid(v)) throw new Error(`'${id}' is not a workflow GUID.`);
  return v;
}

function stateSummary(record: any): string {
  return `${STATE_LABELS[record.statecode] ?? record.statecode} (statecode ${record.statecode}, statuscode ${record.statuscode})`;
}

async function getBpf(client: DataverseClient, workflowId: string, includeXaml: boolean): Promise<any> {
  const select = includeXaml ? `${BPF_SELECT},xaml` : BPF_SELECT;
  const record = await client.get<any>(`workflows(${workflowId})?$select=${select}`);
  if (record.category !== BPF_CATEGORY) {
    throw new Error(`Workflow '${workflowId}' is '${record.name}' with category ${record.category}; it is not a business process flow (category 4).`);
  }
  return record;
}

async function findBpfByUniqueName(client: DataverseClient, uniqueName: string): Promise<any | null> {
  const result = await client.get<{ value: any[] }>(
    `workflows?$filter=uniquename eq '${escapeOData(uniqueName)}' and category eq ${BPF_CATEGORY} and type eq ${WORKFLOW_TYPE_DEFINITION}&$select=${BPF_SELECT}`
  );
  return result.value?.[0] ?? null;
}

async function addWorkflowToSolution(client: DataverseClient, workflowId: string, warnings: string[]): Promise<void> {
  const solutionUniqueName = client.getSolutionUniqueName();
  if (!solutionUniqueName) return;
  try {
    await client.callAction("AddSolutionComponent", {
      ComponentId: workflowId,
      ComponentType: WORKFLOW_COMPONENT_TYPE,
      SolutionUniqueName: solutionUniqueName,
      AddRequiredComponents: false,
      DoNotIncludeSubcomponents: true
    });
  } catch (error) {
    warnings.push(`Could not add the process to solution '${solutionUniqueName}': ${error instanceof Error ? error.message : "Unknown error"}. Add it with add_solution_component (Workflow, ${workflowId}) if it is missing.`);
  }
}

interface AttributeInfo {
  attributeType: string;
  displayName: string;
}

async function fetchAttributeInfo(client: DataverseClient, cache: Map<string, AttributeInfo>, entity: string, column: string): Promise<AttributeInfo> {
  const key = `${entity}.${column}`.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  let result: any;
  try {
    result = await client.getMetadata<any>(
      `EntityDefinitions(LogicalName='${entity.toLowerCase()}')/Attributes(LogicalName='${column.toLowerCase()}')`,
      { $select: "LogicalName,AttributeType,DisplayName" }
    );
  } catch (error) {
    throw new Error(`Could not read column '${column}' of table '${entity}' from metadata (${error instanceof Error ? error.message : "Unknown error"}). Check the logical names, or set resolveColumnsFromMetadata to false and supply type/label on every step.`);
  }
  const info: AttributeInfo = {
    attributeType: result.AttributeType,
    displayName: result.DisplayName?.UserLocalizedLabel?.Label ?? result.DisplayName?.LocalizedLabels?.[0]?.Label ?? column
  };
  cache.set(key, info);
  return info;
}

/** Fills in column types, display names and branch value types from live metadata. */
async function resolveDefinitionFromMetadata(client: DataverseClient, definition: BpfDefinition): Promise<BpfDefinition> {
  const cache = new Map<string, AttributeInfo>();
  const resolved: BpfDefinition = JSON.parse(JSON.stringify(definition));
  for (const segment of resolved.segments) {
    for (const stage of segment.stages) {
      for (const step of stage.steps ?? []) {
        const needsType = !step.classId && !step.type;
        const needsLabel = !step.controlDisplayName && !step.label;
        if (!needsType && !needsLabel && step.controlDisplayName) continue;
        const info = await fetchAttributeInfo(client, cache, segment.entity, step.column);
        if (needsType) {
          const type = ATTRIBUTE_TYPE_TO_BPF_COLUMN_TYPE[info.attributeType];
          if (!type) {
            throw new Error(`Stage '${stage.name}', step '${step.column}': column type '${info.attributeType}' has no confirmed BPF control ClassId. Supply classId explicitly (copy it from an exported BPF that binds a column of that type).`);
          }
          step.type = type;
        }
        if (!step.controlDisplayName) step.controlDisplayName = info.displayName;
        if (!step.label) step.label = info.displayName;
      }
      for (const branch of stage.branches ?? []) {
        if (branch.compareToColumn || branch.valueType) continue;
        const info = await fetchAttributeInfo(client, cache, segment.entity, branch.column);
        const valueType = ATTRIBUTE_TYPE_TO_BPF_VALUE_TYPE[info.attributeType];
        if (!valueType) {
          throw new Error(`Stage '${stage.name}', branch on '${branch.column}': column type '${info.attributeType}' cannot be compared with a literal in a BPF branch. Use compareToColumn or a choice/boolean/number/text column.`);
        }
        branch.valueType = valueType;
      }
    }
  }
  return resolved;
}

interface PreparedXaml {
  xaml: string;
  workflowId: string;
  build?: BpfBuildResult;
  warnings: string[];
}

async function prepareXaml(
  client: DataverseClient,
  params: { xaml?: string; definition?: BpfDefinition; workflowId?: string; resolveColumnsFromMetadata?: boolean },
  options: { forceWorkflowId?: string } = {}
): Promise<PreparedXaml> {
  const warnings: string[] = [];
  if (params.definition && params.xaml) {
    throw new Error("Supply either 'definition' or 'xaml', not both.");
  }
  if (params.definition) {
    const definition: BpfDefinition = { ...params.definition };
    definition.workflowId = options.forceWorkflowId ?? params.workflowId ?? definition.workflowId;
    const effective = params.resolveColumnsFromMetadata === false ? definition : await resolveDefinitionFromMetadata(client, definition);
    const build = buildBusinessProcessFlowXaml(effective);
    warnings.push(...build.warnings);
    return { xaml: build.xaml, workflowId: build.workflowId, build, warnings };
  }
  if (params.xaml) {
    const xaml = params.xaml.trim();
    if (!xaml.includes("<Activity") || !xaml.includes("<mxswa:Workflow")) {
      throw new Error("The xaml does not look like a BPF definition (expected an <Activity> root containing <mxswa:Workflow>).");
    }
    const embedded = extractWorkflowIdFromXaml(xaml);
    const workflowId = options.forceWorkflowId ?? (params.workflowId ? normalizeWorkflowId(params.workflowId) : embedded ?? randomUUID());
    let effectiveXaml = xaml;
    if (embedded !== workflowId) {
      effectiveXaml = embedded ? setWorkflowIdInXaml(xaml, workflowId) : xaml;
      if (embedded) warnings.push(`The XAML x:Class referenced workflow ${embedded}; it was rewritten to ${workflowId}.`);
      else warnings.push("The XAML has no XrmWorkflow<guid> x:Class; Dataverse may reject it.");
    }
    return { xaml: effectiveXaml, workflowId, warnings };
  }
  throw new Error("Supply either 'definition' (compact JSON) or 'xaml' (full BPF XAML).");
}

function describeStages(build: BpfBuildResult | undefined, xaml: string): string {
  try {
    const parsed = parseBusinessProcessFlowXaml(xaml);
    return summarizeBusinessProcessFlow(parsed);
  } catch (error) {
    if (build) {
      return build.stages.map((s, i) => `${i + 1}. [${s.entity}] ${s.name} (${stageCategoryLabel(s.category)}, id ${s.id})`).join("\n");
    }
    return `(could not parse stages from XAML: ${error instanceof Error ? error.message : "Unknown error"})`;
  }
}

function formatWarnings(warnings: string[]): string {
  return warnings.length ? `\n\nWarnings:\n${warnings.map(w => `- ${w}`).join("\n")}` : "";
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function createBusinessProcessFlowTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "create_business_process_flow",
    {
      title: "Create Business Process Flow",
      description: "Creates a business process flow (BPF) definition as a Draft workflow row (category 4). Supply either a compact JSON 'definition' (entity segments -> stages -> steps/branches; column types and labels are resolved from metadata) or complete BPF 'xaml'. The primary table must already be BPF-enabled (update_dataverse_table isBusinessProcessEnabled: true). The unique name must start with the solution's customization prefix and becomes the logical name of the table Dataverse generates on activation. Requires a solution context; the process is added to that solution. Activate it with activate_business_process_flow.",
      inputSchema: {
        name: z.string().min(1).describe("Display name of the process, e.g. 'Case Resolution Process'"),
        uniqueName: z.string().min(1).describe("Unique name with the solution prefix, lowercase, e.g. 'ddsol_caseresolutionprocess'. Becomes the generated BPF table's logical name."),
        primaryEntity: z.string().min(1).describe("Logical name of the table the process starts on (must be BPF-enabled)"),
        definition: definitionSchema.optional(),
        xaml: z.string().optional().describe("Complete BPF XAML (alternative to definition), e.g. from get_business_process_flow or build_business_process_flow_xaml"),
        workflowId: z.string().optional().describe("Optional workflowid GUID to assign; generated when omitted (it is embedded in the XAML x:Class)"),
        businessProcessType: z.enum(["BusinessFlow", "TaskFlow"]).default("BusinessFlow").describe("Business Flow (0, the normal BPF) or Task Flow (1)"),
        description: z.string().optional().describe("Process description"),
        processOrder: z.number().int().min(0).optional().describe("Process order used to pick the default BPF when a table has several (lower wins)"),
        resolveColumnsFromMetadata: z.boolean().default(true).describe("When using definition: look up column types and display names from the table metadata")
      }
    },
    async (params) => {
      try {
        if (!client.getSolutionContext()) {
          throw new Error("No solution context available. Set a solution context with set_solution_context first.");
        }
        const prefix = await client.getCustomizationPrefixAsync();
        const uniqueName = params.uniqueName.trim();
        if (uniqueName !== uniqueName.toLowerCase()) {
          throw new Error(`uniqueName '${uniqueName}' must be lowercase (it becomes a table logical name).`);
        }
        if (!uniqueName.startsWith(`${prefix}_`)) {
          throw new Error(`uniqueName '${uniqueName}' must start with the solution's customization prefix '${prefix}_'.`);
        }
        if (!/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(uniqueName)) {
          throw new Error(`uniqueName '${uniqueName}' may only contain lowercase letters, digits and underscores.`);
        }
        const primaryEntity = params.primaryEntity.trim().toLowerCase();
        if (params.definition && params.definition.segments[0].entity.toLowerCase() !== primaryEntity) {
          throw new Error(`The first entity segment ('${params.definition.segments[0].entity}') must be the primary entity '${primaryEntity}'.`);
        }

        const entity = await client.getMetadata<any>(`EntityDefinitions(LogicalName='${primaryEntity}')`, { $select: "LogicalName,IsBusinessProcessEnabled" });
        if (!entity.IsBusinessProcessEnabled) {
          throw new Error(`Table '${primaryEntity}' is not enabled for business process flows. Enable it first with update_dataverse_table (isBusinessProcessEnabled: true); note that this cannot be reversed.`);
        }

        const existing = await findBpfByUniqueName(client, uniqueName);
        if (existing) {
          throw new Error(`A business process flow with unique name '${uniqueName}' already exists (workflowid ${existing.workflowid}, '${existing.name}').`);
        }

        const prepared = await prepareXaml(client, params);
        const warnings = [...prepared.warnings];
        const body: Record<string, any> = {
          workflowid: prepared.workflowId,
          name: params.name,
          uniquename: uniqueName,
          category: BPF_CATEGORY,
          type: WORKFLOW_TYPE_DEFINITION,
          businessprocesstype: BUSINESS_PROCESS_TYPES[params.businessProcessType],
          primaryentity: primaryEntity,
          scope: 4,
          mode: 0,
          xaml: prepared.xaml
        };
        if (params.description !== undefined) body.description = params.description;
        if (params.processOrder !== undefined) body.processorder = params.processOrder;

        await client.post("workflows", body, solutionHeaders(client));

        let record: any;
        try {
          record = await getBpf(client, prepared.workflowId, false);
        } catch {
          record = await findBpfByUniqueName(client, uniqueName);
        }
        const workflowId = record?.workflowid ?? prepared.workflowId;
        await addWorkflowToSolution(client, workflowId, warnings);

        const stageText = describeStages(prepared.build, prepared.xaml);
        return textResult(
          `Successfully created business process flow '${params.name}' (uniquename ${uniqueName}, workflowid ${workflowId}) on table '${primaryEntity}' in state ${record ? stateSummary(record) : "Draft"}.\n\nStages:\n${stageText}\n\nNext: activate_business_process_flow (workflowId ${workflowId}) creates the BPF table '${uniqueName}'; then grant privileges on that table to the security roles that use the process.${formatWarnings(warnings)}`
        );
      } catch (error) {
        return errorResult("creating business process flow", error);
      }
    }
  );
}

export function getBusinessProcessFlowTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "get_business_process_flow",
    {
      title: "Get Business Process Flow",
      description: "Retrieves a business process flow definition by workflowid or unique name, including its XAML, state, primary entity and process order, plus a parsed stage/step summary.",
      inputSchema: {
        workflowId: z.string().optional().describe("workflowid GUID of the process"),
        uniqueName: z.string().optional().describe("Unique name of the process (alternative to workflowId)"),
        includeXaml: z.boolean().default(true).describe("Whether to include the full XAML in the output")
      }
    },
    async (params) => {
      try {
        let record: any;
        if (params.workflowId) {
          record = await getBpf(client, normalizeWorkflowId(params.workflowId), true);
        } else if (params.uniqueName) {
          const found = await findBpfByUniqueName(client, params.uniqueName.trim());
          if (!found) throw new Error(`No business process flow with unique name '${params.uniqueName}' was found.`);
          record = await getBpf(client, found.workflowid, true);
        } else {
          throw new Error("Supply workflowId or uniqueName.");
        }

        const xaml: string = record.xaml ?? "";
        const { xaml: _omit, ...rest } = record;
        void _omit;
        const summary = xaml ? describeStages(undefined, xaml) : "(no xaml)";
        const output = [
          `Business process flow '${record.name}' (${stateSummary(record)}):`,
          "",
          JSON.stringify({ ...rest, statecodeLabel: STATE_LABELS[record.statecode] ?? record.statecode, businessprocesstypeLabel: record.businessprocesstype === 1 ? "TaskFlow" : "BusinessFlow" }, null, 2),
          "",
          "Stages (parsed from XAML):",
          summary
        ];
        if (params.includeXaml) output.push("", "XAML:", xaml);
        return textResult(output.join("\n"));
      } catch (error) {
        return errorResult("retrieving business process flow", error);
      }
    }
  );
}

export function listBusinessProcessFlowsTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "list_business_process_flows",
    {
      title: "List Business Process Flows",
      description: "Lists business process flow definitions (workflow rows with category 4 and type 1), optionally filtered to a primary table.",
      inputSchema: {
        primaryEntity: z.string().optional().describe("Logical name of the primary table to filter by"),
        includeManaged: z.boolean().default(true).describe("Whether to include managed processes")
      }
    },
    async (params) => {
      try {
        const filters = [`category eq ${BPF_CATEGORY}`, `type eq ${WORKFLOW_TYPE_DEFINITION}`];
        if (params.primaryEntity) filters.push(`primaryentity eq '${escapeOData(params.primaryEntity.trim().toLowerCase())}'`);
        if (!params.includeManaged) filters.push("ismanaged eq false");
        const result = await client.get<{ value: any[] }>(`workflows?$filter=${filters.join(" and ")}&$select=${BPF_SELECT}&$orderby=name asc`);
        const rows = result.value.map(r => ({
          workflowid: r.workflowid,
          name: r.name,
          uniquename: r.uniquename,
          primaryentity: r.primaryentity,
          state: STATE_LABELS[r.statecode] ?? r.statecode,
          statecode: r.statecode,
          statuscode: r.statuscode,
          businessprocesstype: r.businessprocesstype === 1 ? "TaskFlow" : "BusinessFlow",
          processorder: r.processorder,
          ismanaged: r.ismanaged,
          description: r.description,
          modifiedon: r.modifiedon
        }));
        return textResult(`Found ${rows.length} business process flow(s):\n\n${JSON.stringify(rows, null, 2)}`);
      } catch (error) {
        return errorResult("listing business process flows", error);
      }
    }
  );
}

export function updateBusinessProcessFlowTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "update_business_process_flow",
    {
      title: "Update Business Process Flow",
      description: "Updates a business process flow's name, description, process order or definition (xaml or compact definition). Definition changes require the process to be in Draft state: deactivate it first with deactivate_business_process_flow, then reactivate. Only supplied properties are changed.",
      inputSchema: {
        workflowId: z.string().describe("workflowid GUID of the process"),
        name: z.string().optional().describe("New display name"),
        description: z.string().optional().describe("New description"),
        processOrder: z.number().int().min(0).optional().describe("New process order"),
        definition: definitionSchema.optional(),
        xaml: z.string().optional().describe("New complete BPF XAML (alternative to definition)"),
        resolveColumnsFromMetadata: z.boolean().default(true).describe("When using definition: look up column types and display names from the table metadata")
      }
    },
    async (params) => {
      try {
        const workflowId = normalizeWorkflowId(params.workflowId);
        const update: Record<string, any> = {};
        const warnings: string[] = [];
        if (params.name !== undefined) update.name = params.name;
        if (params.description !== undefined) update.description = params.description;
        if (params.processOrder !== undefined) update.processorder = params.processOrder;

        let stageText: string | undefined;
        if (params.definition || params.xaml) {
          const current = await getBpf(client, workflowId, false);
          if (current.statecode !== 0) {
            throw new Error(`Business process flow '${current.name}' is ${stateSummary(current)}. The definition can only be changed in Draft state: run deactivate_business_process_flow first, update, then activate_business_process_flow again.`);
          }
          if (params.definition && params.definition.segments[0].entity.toLowerCase() !== current.primaryentity) {
            throw new Error(`The first entity segment ('${params.definition.segments[0].entity}') must be the process's primary entity '${current.primaryentity}'.`);
          }
          const prepared = await prepareXaml(client, params, { forceWorkflowId: workflowId });
          warnings.push(...prepared.warnings);
          update.xaml = prepared.xaml;
          stageText = describeStages(prepared.build, prepared.xaml);
        }

        if (Object.keys(update).length === 0) {
          throw new Error("At least one property to update must be provided (name, description, processOrder, definition or xaml).");
        }

        await client.patch(`workflows(${workflowId})`, update, solutionHeaders(client));
        const changed = Object.keys(update).join(", ");
        return textResult(`Successfully updated business process flow '${workflowId}' (${changed}).${stageText ? `\n\nStages:\n${stageText}` : ""}${formatWarnings(warnings)}`);
      } catch (error) {
        return errorResult("updating business process flow", error);
      }
    }
  );
}

/**
 * Reads the generated BPF table back. Metadata of a table generated by activation can lag
 * behind the activation response, so the lookup is retried until maxWaitMs has elapsed.
 */
async function describeGeneratedTable(client: DataverseClient, uniqueName: string, maxWaitMs = 0): Promise<{ text: string; found: boolean }> {
  const started = Date.now();
  let lastError: string | null = null;
  for (;;) {
    try {
      const result = await client.getMetadata<{ value: any[] }>("EntityDefinitions", {
        $filter: `IsBPFEntity eq true and LogicalName eq '${escapeOData(uniqueName)}'`,
        $select: "LogicalName,SchemaName,EntitySetName,DisplayName,IsBPFEntity,IsCustomEntity"
      });
      const table = result.value?.[0];
      if (table) {
        const waited = Math.round((Date.now() - started) / 1000);
        return {
          text: `Generated BPF table: ${table.LogicalName} (schema ${table.SchemaName}, entity set ${table.EntitySetName}, display name '${table.DisplayName?.UserLocalizedLabel?.Label ?? ""}')${waited >= 5 ? ` (visible after ${waited} s)` : ""}`,
          found: true
        };
      }
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown error";
    }
    if (Date.now() - started >= maxWaitMs) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (lastError) return { text: `Could not read the generated BPF table: ${lastError}`, found: false };
  return {
    text: `BPF table '${uniqueName}' was not visible in EntityDefinitions (IsBPFEntity eq true)${maxWaitMs > 0 ? ` within ${Math.round(maxWaitMs / 1000)} s` : ""}; table metadata can lag behind activation, check again with get_dataverse_table.`,
    found: false
  };
}

export function activateBusinessProcessFlowTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "activate_business_process_flow",
    {
      title: "Activate Business Process Flow",
      description: "Activates a business process flow (statecode 1 / statuscode 2). On first activation Dataverse generates the BPF table named after the process unique name (the processstage rows already exist from the saved definition); the tool reads the generated table back. Only System Administrator and System Customizer get privileges on that table automatically: grant Create/Read/Write/Delete/Append/AppendTo on it to every other role that uses the process (grant_table_privileges). Requires the prvActivateBusinessProcessFlow privilege.",
      inputSchema: {
        workflowId: z.string().describe("workflowid GUID of the process")
      }
    },
    async (params) => {
      try {
        const workflowId = normalizeWorkflowId(params.workflowId);
        const before = await getBpf(client, workflowId, false);
        if (before.statecode === 1) {
          const table = await describeGeneratedTable(client, before.uniquename);
          return textResult(`Business process flow '${before.name}' is already ${stateSummary(before)}.\n${table.text}`);
        }
        await client.patch(`workflows(${workflowId})`, { statecode: 1, statuscode: 2 }, solutionHeaders(client));
        const after = await getBpf(client, workflowId, false);
        const table = await describeGeneratedTable(client, after.uniquename, 90000);

        let stageText = "";
        try {
          const stages = await client.get<{ value: any[] }>(`processstages?$filter=_processid_value eq ${workflowId}&$select=processstageid,stagename,stagecategory,primaryentitytypecode`);
          stageText = `\nProcess stages (${stages.value.length}): ${stages.value.map(s => `${s.stagename} [${s.primaryentitytypecode}]`).join(", ")}`;
        } catch {
          stageText = "";
        }

        const solution = client.getSolutionUniqueName();
        return textResult(
          `Successfully activated business process flow '${after.name}' (${stateSummary(after)}).\n${table.text}${stageText}\n\nReminder: only System Administrator and System Customizer have privileges on the generated table. Grant Create, Read, Write, Delete, Append and AppendTo on '${after.uniquename}' to every security role whose users run this process (grant_table_privileges).${solution ? ` Verify that table '${after.uniquename}' is part of solution '${solution}' (add_solution_component with componentType Entity if it is not).` : ""}`
        );
      } catch (error) {
        return errorResult("activating business process flow", error);
      }
    }
  );
}

export function deactivateBusinessProcessFlowTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "deactivate_business_process_flow",
    {
      title: "Deactivate Business Process Flow",
      description: "Deactivates a business process flow (statecode 0 / statuscode 1, Draft) so its definition can be edited or the process deleted. Existing process instances keep their data; the generated BPF table stays.",
      inputSchema: {
        workflowId: z.string().describe("workflowid GUID of the process")
      }
    },
    async (params) => {
      try {
        const workflowId = normalizeWorkflowId(params.workflowId);
        const before = await getBpf(client, workflowId, false);
        if (before.statecode === 0) {
          return textResult(`Business process flow '${before.name}' is already ${stateSummary(before)}.`);
        }
        await client.patch(`workflows(${workflowId})`, { statecode: 0, statuscode: 1 }, solutionHeaders(client));
        const after = await getBpf(client, workflowId, false);
        return textResult(`Successfully deactivated business process flow '${after.name}' (${stateSummary(after)}).`);
      } catch (error) {
        return errorResult("deactivating business process flow", error);
      }
    }
  );
}

export function deleteBusinessProcessFlowTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "delete_business_process_flow",
    {
      title: "Delete Business Process Flow",
      description: "Permanently deletes a business process flow definition. The process must be in Draft state (deactivate_business_process_flow first). Dataverse also removes the generated BPF table and its process instances. WARNING: This action cannot be undone.",
      inputSchema: {
        workflowId: z.string().describe("workflowid GUID of the process"),
        confirmDelete: z.boolean().default(false).describe("Must be true to delete")
      }
    },
    async (params) => {
      try {
        if (!params.confirmDelete) {
          throw new Error("Set confirmDelete to true to delete the business process flow.");
        }
        const workflowId = normalizeWorkflowId(params.workflowId);
        const current = await getBpf(client, workflowId, false);
        if (current.statecode !== 0) {
          throw new Error(`Business process flow '${current.name}' is ${stateSummary(current)}. Deactivate it first with deactivate_business_process_flow.`);
        }
        await client.delete(`workflows(${workflowId})`);
        return textResult(`Successfully deleted business process flow '${current.name}' (${workflowId}, uniquename ${current.uniquename}). Dataverse removes the generated table '${current.uniquename}' with it.`);
      } catch (error) {
        return errorResult("deleting business process flow", error);
      }
    }
  );
}

export function listBusinessProcessFlowStagesTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "list_business_process_flow_stages",
    {
      title: "List Business Process Flow Stages",
      description: "Lists the processstage rows of a business process flow (Dataverse creates them when the definition is saved, even in Draft), ordered like the process definition when the XAML can be read.",
      inputSchema: {
        workflowId: z.string().describe("workflowid GUID of the process")
      }
    },
    async (params) => {
      try {
        const workflowId = normalizeWorkflowId(params.workflowId);
        const result = await client.get<{ value: any[] }>(`processstages?$filter=_processid_value eq ${workflowId}&$select=processstageid,stagename,stagecategory,primaryentitytypecode`);
        let rows = result.value.map(s => ({
          processstageid: s.processstageid,
          stagename: s.stagename,
          stagecategory: s.stagecategory,
          stagecategoryLabel: typeof s.stagecategory === "number" ? stageCategoryLabel(s.stagecategory) : undefined,
          primaryentitytypecode: s.primaryentitytypecode
        }));
        let note = "";
        try {
          const record = await getBpf(client, workflowId, true);
          const parsed = parseBusinessProcessFlowXaml(record.xaml ?? "");
          const order = new Map(parsed.flatStages.map((s, i) => [s.id.toLowerCase(), i]));
          rows = rows.sort((a, b) => (order.get(String(a.processstageid).toLowerCase()) ?? 999) - (order.get(String(b.processstageid).toLowerCase()) ?? 999));
        } catch {
          note = "";
        }
        return textResult(`Found ${rows.length} stage(s) for business process flow '${workflowId}':\n\n${JSON.stringify(rows, null, 2)}${note}`);
      } catch (error) {
        return errorResult("listing business process flow stages", error);
      }
    }
  );
}

export function buildBusinessProcessFlowXamlTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "build_business_process_flow_xaml",
    {
      title: "Build Business Process Flow XAML",
      description: "Deterministically generates complete BPF XAML from a compact JSON definition (entity segments -> stages {name, category, steps [{column, label, required}], branches [{column, operator, value(s), nextStage}], elseStage, nextStage, relationship}). Column types and display names are resolved from table metadata unless resolveColumnsFromMetadata is false. Stage references use the stage name (or its id when names repeat). Returns the XAML, the workflowid embedded in it and the generated stage ids; pass the XAML to create_business_process_flow or update_business_process_flow, or pass the definition to those tools directly.",
      inputSchema: {
        definition: definitionSchema,
        workflowId: z.string().optional().describe("workflowid GUID to embed; generated when omitted"),
        resolveColumnsFromMetadata: z.boolean().default(true).describe("Look up column types and display names from the table metadata (requires an environment connection)")
      }
    },
    async (params) => {
      try {
        const prepared = await prepareXaml(client, params);
        const stages = prepared.build!.stages.map((s, i) => `${i + 1}. [${s.entity}] ${s.name} (${stageCategoryLabel(s.category)}) id ${s.id} -> ${s.nextStageId ?? "(end)"}`).join("\n");
        return textResult(`Built BPF XAML for workflowid ${prepared.workflowId} (${prepared.build!.stages.length} stage(s)).\n\nStages:\n${stages}${formatWarnings(prepared.warnings)}\n\nXAML:\n${prepared.xaml}`);
      } catch (error) {
        return errorResult("building business process flow XAML", error);
      }
    }
  );
}
