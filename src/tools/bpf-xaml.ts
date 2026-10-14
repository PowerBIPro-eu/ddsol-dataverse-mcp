import { randomUUID } from "node:crypto";

/**
 * Business Process Flow (BPF) XAML builder and parser.
 *
 * Dataverse stores a BPF definition as a `workflow` row (category 4) whose stages and
 * steps live entirely in the `xaml` column. Microsoft does not document the XAML dialect;
 * this module mirrors the structure of real solution exports (see test/fixtures) exactly:
 *
 *   Activity (x:Class="XrmWorkflow<workflowid without dashes>")
 *     mxswa:Workflow
 *       StageRelationshipCollectionComposite   (cross-table StageRelationship entries)
 *       EntityComposite  (one per stage, DisplayName "EntityStepN: <entity>")
 *         StageComposite (StageId, StageCategory, NextStageId, StepLabels)
 *           StepComposite (ProcessStepId, IsProcessRequired, StepLabels, mcwb:Control)
 *           ConditionSequence (branches: GetEntityProperty / EvaluateExpression /
 *                              EvaluateCondition / ConditionBranch / mcwc:SetNextStage)
 */

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type BpfColumnType =
  | "boolean"
  | "picklist"
  | "status"
  | "lookup"
  | "string"
  | "url"
  | "memo"
  | "integer"
  | "decimal"
  | "money"
  | "datetime";

export type BpfBranchValueType =
  | "picklist"
  | "status"
  | "state"
  | "boolean"
  | "integer"
  | "decimal"
  | "string";

export type BpfBranchOperator =
  | "Equal"
  | "NotEqual"
  | "GreaterThan"
  | "GreaterEqual"
  | "LessThan"
  | "LessEqual"
  | "Contains"
  | "DoesNotContain";

export interface BpfStepDefinition {
  /** ProcessStepId GUID. Generated when omitted. */
  id?: string;
  /** Logical name of the column shown in the step. */
  column: string;
  /** Step label shown in the process bar. Defaults to controlDisplayName. */
  label?: string;
  /** Display name of the bound column (ControlDisplayName). Defaults to label. */
  controlDisplayName?: string;
  /** Column type used to pick the control ClassId. Resolved from metadata by the tool when omitted. */
  type?: BpfColumnType;
  /** Explicit control ClassId; overrides the type lookup. */
  classId?: string;
  /** Whether the step must be completed before moving to the next stage. */
  required?: boolean;
}

export interface BpfBranchDefinition {
  /** Column of the stage's table that the condition reads. */
  column: string;
  /** Comparison operator. Defaults to Equal. */
  operator?: BpfBranchOperator;
  /** Type of the literal value(s). Resolved from metadata by the tool when omitted. */
  valueType?: BpfBranchValueType;
  /** Literal value(s). Several values with Equal mean "equals any of". */
  values?: Array<string | number | boolean>;
  /** Shorthand for a single literal value. */
  value?: string | number | boolean;
  /** Compare against another column of the same table instead of a literal. */
  compareToColumn?: string;
  /** Stage (name or id) to jump to when the condition is true. */
  nextStage: string;
  /** Branch description shown in the designer. */
  label?: string;
}

export interface BpfStageRelationshipDefinition {
  /** Stage (name or id) on the previous table that leads into this stage. */
  sourceStage: string;
  /** Schema name of the 1:N relationship between the previous table and this stage's table. */
  relationshipName: string;
  /** Logical name of the lookup column on this stage's table that points to the previous table. */
  attributeName: string;
}

export interface BpfStageDefinition {
  /** StageId GUID. Generated when omitted. */
  id?: string;
  /** Stage name (also the stage label). */
  name: string;
  /** Name shown in the designer tree (StageComposite DisplayName). Defaults to name; exports differ only when a stage was renamed after creation. */
  designerName?: string;
  /** Stage category: number (-1 none, 0 Qualify, 1 Develop, 2 Propose, 3 Close, 4 Identify, 5 Research, 6 Resolve, 7 Approval) or its name. Defaults to -1. */
  category?: number | string;
  /** Default next stage (name or id). Defaults to the next stage in document order; null ends the process. */
  nextStage?: string | null;
  /** Cross-table relationship when this stage's table differs from the stage it follows. */
  relationship?: BpfStageRelationshipDefinition;
  steps?: BpfStepDefinition[];
  /** Conditional branches evaluated when leaving the stage. */
  branches?: BpfBranchDefinition[];
  /** Stage (name or id) taken when no branch matches (the designer's "else" branch). */
  elseStage?: string;
  /** EntityComposite IsClosedLoop flag. Defaults to false. */
  isClosedLoop?: boolean;
}

export interface BpfEntitySegmentDefinition {
  /** Logical name of the table whose columns the stages show. */
  entity: string;
  stages: BpfStageDefinition[];
}

export interface BpfDefinition {
  /** workflowid GUID embedded in the XAML x:Class. Generated when omitted. */
  workflowId?: string;
  segments: BpfEntitySegmentDefinition[];
}

export interface BpfBuildResult {
  xaml: string;
  workflowId: string;
  stages: Array<{ id: string; name: string; entity: string; category: number; nextStageId: string | null }>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Reference tables
// ---------------------------------------------------------------------------

/**
 * Control ClassIds per column type. Each entry names where the value was confirmed:
 * "export" = seen in a real BPF XAML export, "formxml" = taken from the schema-builder
 * FormXML classid table (same control GUIDs, not yet seen in a BPF export).
 */
export const BPF_CONTROL_CLASS_IDS: Record<BpfColumnType, { classId: string; source: "export" | "formxml" }> = {
  boolean: { classId: "67fac785-cd58-4f9f-abb3-4b7ddc6ed5ed", source: "export" },
  picklist: { classId: "3ef39988-22bb-4f0b-bbbe-64b5a3748aee", source: "export" },
  status: { classId: "5d68b988-0661-4db2-bc3e-17598ad3be6c", source: "export" },
  lookup: { classId: "270bd3db-d9af-4782-9025-509e298dec0a", source: "export" },
  string: { classId: "4273edbd-ac1d-40d3-9fb2-095c621b552d", source: "export" },
  memo: { classId: "e0dece4b-6fc8-4a8f-a065-082708572369", source: "export" },
  integer: { classId: "c6d124ca-7eda-4a60-aea9-7fb8d318b68f", source: "export" },
  decimal: { classId: "c3efe0c3-0ec6-42be-8349-cbd9079dfd8e", source: "export" },
  datetime: { classId: "5b773807-9fb2-42db-97c3-7a91eff8adff", source: "export" },
  money: { classId: "533b9e00-756b-4312-95a0-dc888637ac78", source: "formxml" },
  url: { classId: "71716b6c-711e-476c-8ab8-5d11542bfb47", source: "formxml" }
};

/** Maps Dataverse AttributeMetadata.AttributeType values to BPF column types. */
export const ATTRIBUTE_TYPE_TO_BPF_COLUMN_TYPE: Record<string, BpfColumnType> = {
  Boolean: "boolean",
  Picklist: "picklist",
  Status: "status",
  Lookup: "lookup",
  String: "string",
  Memo: "memo",
  Integer: "integer",
  Decimal: "decimal",
  Money: "money",
  DateTime: "datetime"
};

/** Maps Dataverse AttributeMetadata.AttributeType values to branch literal value types. */
export const ATTRIBUTE_TYPE_TO_BPF_VALUE_TYPE: Record<string, BpfBranchValueType> = {
  Picklist: "picklist",
  Status: "status",
  State: "state",
  Boolean: "boolean",
  Integer: "integer",
  Decimal: "decimal",
  String: "string",
  Memo: "string"
};

export const BPF_STAGE_CATEGORIES: Record<string, number> = {
  None: -1,
  Qualify: 0,
  Develop: 1,
  Propose: 2,
  Close: 3,
  Identify: 4,
  Research: 5,
  Resolve: 6,
  Approval: 7
};

export function stageCategoryLabel(value: number): string {
  const entry = Object.entries(BPF_STAGE_CATEGORIES).find(([, v]) => v === value);
  return entry ? entry[0] : String(value);
}

export const BPF_BRANCH_OPERATORS: BpfBranchOperator[] = [
  "Equal", "NotEqual", "GreaterThan", "GreaterEqual", "LessThan", "LessEqual", "Contains", "DoesNotContain"
];

const ASSEMBLY = "Microsoft.Crm.Workflow, Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35";
const AQN = {
  stageRelationshipCollection: `Microsoft.Crm.Workflow.BusinessProcessFlowActivities.StageRelationshipCollectionComposite, ${ASSEMBLY}`,
  entity: `Microsoft.Crm.Workflow.Activities.EntityComposite, ${ASSEMBLY}`,
  stage: `Microsoft.Crm.Workflow.Activities.StageComposite, ${ASSEMBLY}`,
  step: `Microsoft.Crm.Workflow.Activities.StepComposite, ${ASSEMBLY}`,
  conditionSequence: `Microsoft.Crm.Workflow.Activities.ConditionSequence, ${ASSEMBLY}`,
  evaluateExpression: `Microsoft.Crm.Workflow.Activities.EvaluateExpression, ${ASSEMBLY}`,
  evaluateCondition: `Microsoft.Crm.Workflow.Activities.EvaluateCondition, ${ASSEMBLY}`,
  conditionBranch: `Microsoft.Crm.Workflow.Activities.ConditionBranch, ${ASSEMBLY}`,
  composite: `Microsoft.Crm.Workflow.Activities.Composite, ${ASSEMBLY}`
};

const XMLNS_BASE = [
  `xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"`,
  `xmlns:mcwb="clr-namespace:Microsoft.Crm.Workflow.BusinessProcessFlowActivities;assembly=Microsoft.Crm.Workflow, Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35"`
];
const XMLNS_MCWC = `xmlns:mcwc="clr-namespace:Microsoft.Crm.Workflow.ClientActivities;assembly=Microsoft.Crm.Workflow, Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35"`;
const XMLNS_MIDDLE = [
  `xmlns:mcwo="clr-namespace:Microsoft.Crm.Workflow.ObjectModel;assembly=Microsoft.Crm, Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35"`,
  `xmlns:mva="clr-namespace:Microsoft.VisualBasic.Activities;assembly=System.Activities, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35"`,
  `xmlns:mxs="clr-namespace:Microsoft.Xrm.Sdk;assembly=Microsoft.Xrm.Sdk, Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35"`
];
const XMLNS_MXSQ = `xmlns:mxsq="clr-namespace:Microsoft.Xrm.Sdk.Query;assembly=Microsoft.Xrm.Sdk, Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35"`;
const XMLNS_MXSWA = `xmlns:mxswa="clr-namespace:Microsoft.Xrm.Sdk.Workflow.Activities;assembly=Microsoft.Xrm.Sdk.Workflow, Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35"`;
const XMLNS_S = `xmlns:s="clr-namespace:System;assembly=mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089"`;
const XMLNS_TAIL = [
  `xmlns:scg="clr-namespace:System.Collections.Generic;assembly=mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089"`,
  `xmlns:sco="clr-namespace:System.Collections.ObjectModel;assembly=mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089"`,
  `xmlns:srs="clr-namespace:System.Runtime.Serialization;assembly=System.Runtime.Serialization, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089"`,
  `xmlns:this="clr-namespace:"`,
  `xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"`
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: string | undefined | null): value is string {
  return typeof value === "string" && GUID_RE.test(value.trim().replace(/^\{|\}$/g, ""));
}

function normalizeGuid(value: string, what: string): string {
  const v = String(value).trim().replace(/^\{|\}$/g, "").toLowerCase();
  if (!GUID_RE.test(v)) throw new Error(`${what} '${value}' is not a GUID.`);
  return v;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function vbString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function boolText(value: boolean | undefined, fallback = false): string {
  return (value ?? fallback) ? "True" : "False";
}

/** Extracts the workflow GUID embedded in the XAML x:Class attribute, if any. */
export function extractWorkflowIdFromXaml(xaml: string): string | null {
  const match = /x:Class="XrmWorkflow([0-9a-fA-F]{32})"/.exec(xaml);
  if (!match) return null;
  const h = match[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Rewrites every XrmWorkflow<guid> class reference in the XAML to the given workflow id. */
export function setWorkflowIdInXaml(xaml: string, workflowId: string): string {
  const compact = normalizeGuid(workflowId, "workflowId").replace(/-/g, "");
  return xaml.replace(/XrmWorkflow[0-9a-fA-F]{32}/g, `XrmWorkflow${compact}`);
}

export function resolveStageCategory(category: number | string | undefined | null): number {
  if (category === undefined || category === null || category === "") return -1;
  if (typeof category === "number") {
    if (!Number.isInteger(category) || category < -1 || category > 7) {
      throw new Error(`Stage category ${category} is out of range (-1..7).`);
    }
    return category;
  }
  const trimmed = String(category).trim();
  if (/^-?\d+$/.test(trimmed)) return resolveStageCategory(parseInt(trimmed, 10));
  const key = Object.keys(BPF_STAGE_CATEGORIES).find(k => k.toLowerCase() === trimmed.toLowerCase());
  if (key === undefined) {
    throw new Error(`Unknown stage category '${category}'. Use -1..7 or one of ${Object.keys(BPF_STAGE_CATEGORIES).join(", ")}.`);
  }
  return BPF_STAGE_CATEGORIES[key];
}

function literalForValue(valueType: BpfBranchValueType, raw: string | number | boolean): { parameters: string; targetType: string } {
  const text = typeof raw === "boolean" ? (raw ? "1" : "0") : String(raw);
  const P = "Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType";
  switch (valueType) {
    case "picklist":
      return { parameters: `${P}.OptionSetValue, ${vbString(text)}, "Picklist"`, targetType: "mxs:OptionSetValue" };
    case "status":
      return { parameters: `${P}.OptionSetValue, ${vbString(text)}, "Status"`, targetType: "mxs:OptionSetValue" };
    case "state":
      return { parameters: `${P}.OptionSetValue, ${vbString(text)}, "State"`, targetType: "mxs:OptionSetValue" };
    case "boolean": {
      const normalized = /^(1|true|yes)$/i.test(text) ? "1" : /^(0|false|no)$/i.test(text) ? "0" : null;
      if (normalized === null) throw new Error(`Boolean branch value '${text}' must be true/false.`);
      return { parameters: `${P}.Boolean, ${vbString(normalized)}`, targetType: "x:Boolean" };
    }
    case "integer":
      if (!/^-?\d+$/.test(text)) throw new Error(`Integer branch value '${text}' is not a whole number.`);
      return { parameters: `${P}.Integer, ${vbString(text)}`, targetType: "x:Int32" };
    case "decimal":
      if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`Decimal branch value '${text}' is not a number.`);
      return { parameters: `${P}.Decimal, ${vbString(text)}`, targetType: "x:Decimal" };
    case "string":
      return { parameters: `${P}.String, ${vbString(text)}, "String"`, targetType: "x:String" };
    default:
      throw new Error(`Unsupported branch value type '${valueType}'.`);
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface ResolvedStep {
  id: string;
  column: string;
  label: string;
  controlDisplayName: string;
  classId: string;
  required: boolean;
  stepNumber: number;
  controlNumber: number;
}

interface ResolvedBranch {
  column: string;
  operator: BpfBranchOperator;
  literals: Array<{ parameters: string; targetType: string }>;
  compareToColumn?: string;
  targetStageId: string;
  label: string;
  branchNumber: number;
  setNextNumber: number;
}

interface ResolvedStage {
  id: string;
  name: string;
  designerName: string;
  entity: string;
  category: number;
  nextStageId: string | null;
  isClosedLoop: boolean;
  steps: ResolvedStep[];
  branches: ResolvedBranch[];
  elseStage?: { targetStageId: string; branchNumber: number; setNextNumber: number };
  conditionNumber?: number;
  entityDisplayNumber: number;
  stageNumber: number;
  relationship?: { sourceStageId: string; relationshipName: string; attributeName: string; sequenceNumber: number };
}

class Lines {
  private readonly out: string[] = [];
  push(indent: number, text: string): void {
    this.out.push(`${"  ".repeat(indent)}${text}`);
  }
  toString(): string {
    return this.out.join("\n");
  }
}

/**
 * Builds the complete BPF XAML for a definition. Deterministic: given the same definition
 * (including ids) the output is byte-identical.
 */
export function buildBusinessProcessFlowXaml(definition: BpfDefinition): BpfBuildResult {
  const warnings: string[] = [];
  if (!definition || !Array.isArray(definition.segments) || definition.segments.length === 0) {
    throw new Error("The BPF definition needs at least one entity segment with one stage.");
  }

  const workflowId = definition.workflowId ? normalizeGuid(definition.workflowId, "workflowId") : randomUUID();

  // Flatten stages in document order and assign ids.
  const flat: Array<{ stage: BpfStageDefinition; entity: string; id: string }> = [];
  for (const segment of definition.segments) {
    if (!segment.entity || typeof segment.entity !== "string") {
      throw new Error("Every entity segment needs an 'entity' logical name.");
    }
    if (!Array.isArray(segment.stages) || segment.stages.length === 0) {
      throw new Error(`Entity segment '${segment.entity}' needs at least one stage.`);
    }
    for (const stage of segment.stages) {
      if (!stage.name || typeof stage.name !== "string") {
        throw new Error(`Every stage of '${segment.entity}' needs a name.`);
      }
      flat.push({ stage, entity: segment.entity.toLowerCase(), id: stage.id ? normalizeGuid(stage.id, `Stage '${stage.name}' id`) : randomUUID() });
    }
  }

  const ids = new Set<string>();
  for (const f of flat) {
    if (ids.has(f.id)) throw new Error(`Stage id '${f.id}' is used twice.`);
    ids.add(f.id);
  }

  const distinctEntities = new Set(flat.map(f => f.entity));
  if (distinctEntities.size > 5) throw new Error("A BPF can span at most 5 tables.");
  for (const entity of distinctEntities) {
    if (flat.filter(f => f.entity === entity).length > 30) throw new Error(`Table '${entity}' has more than 30 stages.`);
  }

  const resolveStageRef = (ref: string, context: string): string => {
    if (typeof ref !== "string" || !ref.trim()) throw new Error(`${context}: stage reference is empty.`);
    const trimmed = ref.trim();
    if (isGuid(trimmed)) {
      const guid = normalizeGuid(trimmed, context);
      if (!ids.has(guid)) throw new Error(`${context}: no stage has id '${guid}'.`);
      return guid;
    }
    const matches = flat.filter(f => f.stage.name === trimmed);
    if (matches.length === 0) throw new Error(`${context}: no stage is named '${trimmed}'.`);
    if (matches.length > 1) throw new Error(`${context}: stage name '${trimmed}' is ambiguous; give those stages ids and reference the id.`);
    return matches[0].id;
  };

  // Structural numbering (first pass), then condition numbering (second pass).
  let counter = 0;
  const next = () => ++counter;
  const relationshipCollectionNumber = next();

  const relationshipSequences: Array<{ stageIndex: number; sequenceNumber: number }> = [];
  flat.forEach((f, index) => {
    if (f.stage.relationship) relationshipSequences.push({ stageIndex: index, sequenceNumber: next() });
  });

  const resolved: ResolvedStage[] = [];
  let firstEntityNumber = 0;
  flat.forEach((f, index) => {
    const entityNumber = next();
    if (index === 0) firstEntityNumber = entityNumber;
    const stageNumber = next();
    const stage = f.stage;
    const steps: ResolvedStep[] = (stage.steps ?? []).map(step => {
      if (!step.column || typeof step.column !== "string") {
        throw new Error(`Stage '${stage.name}': every step needs a column logical name.`);
      }
      const controlDisplayName = step.controlDisplayName ?? step.label;
      const label = step.label ?? step.controlDisplayName;
      if (!label || !controlDisplayName) {
        throw new Error(`Stage '${stage.name}', step '${step.column}': a label (or controlDisplayName) is required.`);
      }
      let classId = step.classId;
      if (classId) {
        classId = normalizeGuid(classId, `Stage '${stage.name}', step '${step.column}' classId`);
      } else {
        if (!step.type) {
          throw new Error(`Stage '${stage.name}', step '${step.column}': column type (or classId) is required. Supported types: ${Object.keys(BPF_CONTROL_CLASS_IDS).join(", ")}.`);
        }
        const entry = BPF_CONTROL_CLASS_IDS[step.type];
        if (!entry) {
          throw new Error(`Stage '${stage.name}', step '${step.column}': no confirmed ClassId for column type '${step.type}'. Supply classId explicitly (copy it from an exported BPF or form that binds a column of that type).`);
        }
        if (entry.source === "formxml") {
          warnings.push(`Step '${step.column}' uses the ${step.type} ClassId ${entry.classId}, which comes from the FormXML control table and has not yet been confirmed in a BPF export.`);
        }
        classId = entry.classId;
      }
      return {
        id: step.id ? normalizeGuid(step.id, `Step '${step.column}' id`) : randomUUID(),
        column: step.column.toLowerCase(),
        label,
        controlDisplayName,
        classId,
        required: step.required ?? false,
        stepNumber: next(),
        controlNumber: next()
      };
    });
    if (steps.length > 30) throw new Error(`Stage '${stage.name}' has more than 30 steps.`);

    const defaultNext = index + 1 < flat.length ? flat[index + 1].id : null;
    let nextStageId: string | null;
    if (stage.nextStage === undefined) nextStageId = defaultNext;
    else if (stage.nextStage === null || stage.nextStage === "") nextStageId = null;
    else nextStageId = resolveStageRef(stage.nextStage, `Stage '${stage.name}' nextStage`);
    if (nextStageId === f.id) throw new Error(`Stage '${stage.name}' cannot be its own next stage.`);

    resolved.push({
      id: f.id,
      name: stage.name,
      designerName: stage.designerName ?? stage.name,
      entity: f.entity,
      category: resolveStageCategory(stage.category),
      nextStageId,
      isClosedLoop: stage.isClosedLoop ?? false,
      steps,
      branches: [],
      entityDisplayNumber: firstEntityNumber + index,
      stageNumber
    });
  });

  // Relationships (need stage ids resolved).
  for (const rel of relationshipSequences) {
    const f = flat[rel.stageIndex];
    const r = f.stage.relationship!;
    if (!r.relationshipName || !r.attributeName || !r.sourceStage) {
      throw new Error(`Stage '${f.stage.name}': relationship needs sourceStage, relationshipName and attributeName.`);
    }
    const sourceStageId = resolveStageRef(r.sourceStage, `Stage '${f.stage.name}' relationship.sourceStage`);
    const source = resolved.find(s => s.id === sourceStageId)!;
    if (source.entity === f.entity) {
      warnings.push(`Stage '${f.stage.name}' declares a relationship from '${source.name}' although both stages are on '${f.entity}'.`);
    }
    resolved[rel.stageIndex].relationship = {
      sourceStageId,
      relationshipName: r.relationshipName,
      attributeName: r.attributeName.toLowerCase(),
      sequenceNumber: rel.sequenceNumber
    };
  }

  // Conditions (second pass numbering).
  flat.forEach((f, index) => {
    const stage = f.stage;
    const branches = stage.branches ?? [];
    if (branches.length === 0 && !stage.elseStage) return;
    if (branches.length === 0 && stage.elseStage) {
      throw new Error(`Stage '${stage.name}': elseStage requires at least one branch.`);
    }
    const target = resolved[index];
    target.conditionNumber = next();
    for (const b of branches) {
      if (!b.column) throw new Error(`Stage '${stage.name}': every branch needs a column.`);
      const operator = b.operator ?? "Equal";
      if (!BPF_BRANCH_OPERATORS.includes(operator)) {
        throw new Error(`Stage '${stage.name}': unsupported branch operator '${operator}'. Supported: ${BPF_BRANCH_OPERATORS.join(", ")}.`);
      }
      const rawValues = b.values ?? (b.value !== undefined ? [b.value] : []);
      let literals: Array<{ parameters: string; targetType: string }> = [];
      if (b.compareToColumn) {
        if (rawValues.length > 0) throw new Error(`Stage '${stage.name}', branch on '${b.column}': use either values or compareToColumn, not both.`);
      } else {
        if (rawValues.length === 0) throw new Error(`Stage '${stage.name}', branch on '${b.column}': value(s) or compareToColumn required.`);
        if (!b.valueType) throw new Error(`Stage '${stage.name}', branch on '${b.column}': valueType is required (picklist, status, state, boolean, integer, decimal, string).`);
        if (rawValues.length > 1 && operator !== "Equal" && operator !== "NotEqual") {
          throw new Error(`Stage '${stage.name}', branch on '${b.column}': several values are only supported with Equal/NotEqual.`);
        }
        literals = rawValues.map(v => literalForValue(b.valueType!, v));
      }
      const targetStageId = resolveStageRef(b.nextStage, `Stage '${stage.name}' branch on '${b.column}' nextStage`);
      target.branches.push({
        column: b.column.toLowerCase(),
        operator,
        literals,
        compareToColumn: b.compareToColumn?.toLowerCase(),
        targetStageId,
        label: b.label ?? "",
        branchNumber: next(),
        setNextNumber: next()
      });
    }
    if (stage.elseStage) {
      target.elseStage = {
        targetStageId: resolveStageRef(stage.elseStage, `Stage '${stage.name}' elseStage`),
        branchNumber: next(),
        setNextNumber: next()
      };
    }
  });

  // A stage on a secondary table reached from a stage on another table needs a StageRelationship
  // (returning to the primary table needs none, as the exports show).
  const primaryEntity = resolved[0].entity;
  for (const s of resolved) {
    if (s.relationship || s.entity === primaryEntity) continue;
    const feeders = resolved.filter(o => o.entity !== s.entity && (o.nextStageId === s.id || o.branches.some(b => b.targetStageId === s.id) || o.elseStage?.targetStageId === s.id));
    if (feeders.length > 0) {
      warnings.push(`Stage '${s.name}' (${s.entity}) is reached from '${feeders[0].name}' (${feeders[0].entity}) but declares no relationship; the designer requires a StageRelationship for cross-table transitions.`);
    }
  }

  const hasConditions = resolved.some(s => s.conditionNumber !== undefined);
  const classCompact = workflowId.replace(/-/g, "");
  const xmlns = [
    ...XMLNS_BASE,
    ...(hasConditions ? [XMLNS_MCWC] : []),
    ...XMLNS_MIDDLE,
    ...(hasConditions ? [XMLNS_MXSQ] : []),
    XMLNS_MXSWA,
    ...(hasConditions ? [XMLNS_S] : []),
    ...XMLNS_TAIL
  ];

  const L = new Lines();
  L.push(0, `<Activity x:Class="XrmWorkflow${classCompact}" ${xmlns.join(" ")}>`);
  L.push(1, `<x:Members>`);
  L.push(2, `<x:Property Name="InputEntities" Type="InArgument(scg:IDictionary(x:String, mxs:Entity))" />`);
  L.push(2, `<x:Property Name="CreatedEntities" Type="InArgument(scg:IDictionary(x:String, mxs:Entity))" />`);
  L.push(1, `</x:Members>`);
  L.push(1, `<this:XrmWorkflow${classCompact}.InputEntities>`);
  L.push(2, `<InArgument x:TypeArguments="scg:IDictionary(x:String, mxs:Entity)" />`);
  L.push(1, `</this:XrmWorkflow${classCompact}.InputEntities>`);
  L.push(1, `<this:XrmWorkflow${classCompact}.CreatedEntities>`);
  L.push(2, `<InArgument x:TypeArguments="scg:IDictionary(x:String, mxs:Entity)" />`);
  L.push(1, `</this:XrmWorkflow${classCompact}.CreatedEntities>`);
  L.push(1, `<mva:VisualBasic.Settings>Assembly references and imported namespaces for internal implementation</mva:VisualBasic.Settings>`);
  L.push(1, `<mxswa:Workflow>`);

  // Stage relationship collection
  L.push(2, `<mxswa:ActivityReference AssemblyQualifiedName="${AQN.stageRelationshipCollection}" DisplayName="RelationshipCollectionStep${relationshipCollectionNumber}">`);
  L.push(3, `<mxswa:ActivityReference.Properties>`);
  L.push(4, `<sco:Collection x:TypeArguments="Variable" x:Key="Variables" />`);
  const withRelationship = resolved.filter(s => s.relationship);
  if (withRelationship.length === 0) {
    L.push(4, `<sco:Collection x:TypeArguments="Activity" x:Key="Activities" />`);
  } else {
    L.push(4, `<sco:Collection x:TypeArguments="Activity" x:Key="Activities">`);
    for (const s of withRelationship) {
      const r = s.relationship!;
      L.push(5, `<Sequence DisplayName="RelationshipStep${r.sequenceNumber}">`);
      L.push(6, `<mcwb:StageRelationship AttributeName="${escapeAttr(r.attributeName)}" RelationshipName="${escapeAttr(r.relationshipName)}" SourceStageId="${r.sourceStageId}" TargetStageId="${s.id}" />`);
      L.push(5, `</Sequence>`);
    }
    L.push(4, `</sco:Collection>`);
  }
  L.push(3, `</mxswa:ActivityReference.Properties>`);
  L.push(2, `</mxswa:ActivityReference>`);

  for (const s of resolved) {
    L.push(2, `<mxswa:ActivityReference AssemblyQualifiedName="${AQN.entity}" DisplayName="EntityStep${s.entityDisplayNumber}: ${escapeAttr(s.entity)}">`);
    L.push(3, `<mxswa:ActivityReference.Properties>`);
    L.push(4, `<sco:Collection x:TypeArguments="Variable" x:Key="Variables" />`);
    L.push(4, `<sco:Collection x:TypeArguments="Activity" x:Key="Activities">`);
    L.push(5, `<mxswa:ActivityReference AssemblyQualifiedName="${AQN.stage}" DisplayName="StageStep${s.stageNumber}: ${escapeAttr(s.designerName)}">`);
    L.push(6, `<mxswa:ActivityReference.Properties>`);
    L.push(7, `<sco:Collection x:TypeArguments="Variable" x:Key="Variables" />`);
    if (s.steps.length === 0 && s.conditionNumber === undefined) {
      L.push(7, `<sco:Collection x:TypeArguments="Activity" x:Key="Activities" />`);
    } else {
      L.push(7, `<sco:Collection x:TypeArguments="Activity" x:Key="Activities">`);
      for (const step of s.steps) renderStep(L, step);
      if (s.conditionNumber !== undefined) renderConditionSequence(L, s);
      L.push(7, `</sco:Collection>`);
    }
    L.push(7, `<sco:Collection x:TypeArguments="mcwo:StepLabel" x:Key="StepLabels">`);
    L.push(8, `<mcwo:StepLabel Description="${escapeAttr(s.name)}" LabelId="${s.id}" LanguageCode="1033" />`);
    L.push(7, `</sco:Collection>`);
    L.push(7, `<x:String x:Key="StageId">${s.id}</x:String>`);
    L.push(7, `<x:String x:Key="StageCategory">${s.category}</x:String>`);
    if (s.nextStageId) L.push(7, `<x:String x:Key="NextStageId">${s.nextStageId}</x:String>`);
    else L.push(7, `<x:Null x:Key="NextStageId" />`);
    L.push(6, `</mxswa:ActivityReference.Properties>`);
    L.push(5, `</mxswa:ActivityReference>`);
    L.push(4, `</sco:Collection>`);
    L.push(4, `<x:Null x:Key="RelationshipName" />`);
    L.push(4, `<x:Null x:Key="AttributeName" />`);
    L.push(4, `<x:Boolean x:Key="IsClosedLoop">${boolText(s.isClosedLoop)}</x:Boolean>`);
    L.push(3, `</mxswa:ActivityReference.Properties>`);
    L.push(2, `</mxswa:ActivityReference>`);
  }

  L.push(1, `</mxswa:Workflow>`);
  L.push(0, `</Activity>`);

  return {
    xaml: L.toString(),
    workflowId,
    stages: resolved.map(s => ({ id: s.id, name: s.name, entity: s.entity, category: s.category, nextStageId: s.nextStageId })),
    warnings
  };
}

function renderStep(L: Lines, step: ResolvedStep): void {
  L.push(8, `<mxswa:ActivityReference AssemblyQualifiedName="${AQN.step}" DisplayName="StepStep${step.stepNumber}: New Step">`);
  L.push(9, `<mxswa:ActivityReference.Properties>`);
  L.push(10, `<sco:Collection x:TypeArguments="Variable" x:Key="Variables" />`);
  L.push(10, `<sco:Collection x:TypeArguments="Activity" x:Key="Activities">`);
  L.push(11, `<Sequence DisplayName="ControlStep${step.controlNumber}">`);
  L.push(12, `<mcwb:Control ClassId="${step.classId}" ControlDisplayName="${escapeAttr(step.controlDisplayName)}" ControlId="${escapeAttr(step.column)}" DataFieldName="${escapeAttr(step.column)}" IsSystemControl="False" IsUnbound="False" SystemStepType="0">`);
  L.push(13, `<mcwb:Control.Parameters>`);
  L.push(14, `<InArgument x:TypeArguments="x:String">`);
  L.push(15, `<Literal x:TypeArguments="x:String" Value="" />`);
  L.push(14, `</InArgument>`);
  L.push(13, `</mcwb:Control.Parameters>`);
  L.push(12, `</mcwb:Control>`);
  L.push(11, `</Sequence>`);
  L.push(10, `</sco:Collection>`);
  L.push(10, `<sco:Collection x:TypeArguments="mcwo:StepLabel" x:Key="StepLabels">`);
  L.push(11, `<mcwo:StepLabel Description="${escapeAttr(step.label)}" LabelId="${step.id}" LanguageCode="1033" />`);
  L.push(10, `</sco:Collection>`);
  L.push(10, `<x:String x:Key="ProcessStepId">${step.id}</x:String>`);
  L.push(10, `<x:Boolean x:Key="IsProcessRequired">${boolText(step.required)}</x:Boolean>`);
  L.push(9, `</mxswa:ActivityReference.Properties>`);
  L.push(8, `</mxswa:ActivityReference>`);
}

function renderGetEntityProperty(L: Lines, indent: number, column: string, entity: string, variable: string): void {
  L.push(indent, `<mxswa:GetEntityProperty Attribute="${escapeAttr(column)}" Entity="[InputEntities(&quot;primaryEntity&quot;)]" EntityName="${escapeAttr(entity)}" Value="[${variable}]">`);
  L.push(indent + 1, `<mxswa:GetEntityProperty.TargetType>`);
  L.push(indent + 2, `<InArgument x:TypeArguments="s:Type">`);
  L.push(indent + 3, `<mxswa:ReferenceLiteral x:TypeArguments="s:Type">`);
  L.push(indent + 4, `<x:Null />`);
  L.push(indent + 3, `</mxswa:ReferenceLiteral>`);
  L.push(indent + 2, `</InArgument>`);
  L.push(indent + 1, `</mxswa:GetEntityProperty.TargetType>`);
  L.push(indent, `</mxswa:GetEntityProperty>`);
}

function renderConditionBranch(L: Lines, indent: number, branchNumber: number, condition: string, parentStageId: string, targetStageId: string, setNextNumber: number, label: string): void {
  L.push(indent, `<mxswa:ActivityReference AssemblyQualifiedName="${AQN.conditionBranch}" DisplayName="ConditionBranchStep${branchNumber}">`);
  L.push(indent + 1, `<mxswa:ActivityReference.Arguments>`);
  L.push(indent + 2, `<InArgument x:TypeArguments="x:Boolean" x:Key="Condition">${condition}</InArgument>`);
  L.push(indent + 1, `</mxswa:ActivityReference.Arguments>`);
  L.push(indent + 1, `<mxswa:ActivityReference.Properties>`);
  L.push(indent + 2, `<mxswa:ActivityReference x:Key="Then" AssemblyQualifiedName="${AQN.composite}" DisplayName="ConditionBranchStep${branchNumber}">`);
  L.push(indent + 3, `<mxswa:ActivityReference.Properties>`);
  L.push(indent + 4, `<sco:Collection x:TypeArguments="Variable" x:Key="Variables" />`);
  L.push(indent + 4, `<sco:Collection x:TypeArguments="Activity" x:Key="Activities">`);
  L.push(indent + 5, `<Sequence DisplayName="SetNextStageStep${setNextNumber}">`);
  L.push(indent + 6, `<mcwc:SetNextStage ParentStageId="${parentStageId}" StageId="${targetStageId}" />`);
  L.push(indent + 5, `</Sequence>`);
  L.push(indent + 4, `</sco:Collection>`);
  L.push(indent + 3, `</mxswa:ActivityReference.Properties>`);
  L.push(indent + 2, `</mxswa:ActivityReference>`);
  L.push(indent + 2, `<x:Null x:Key="Else" />`);
  L.push(indent + 2, `<x:String x:Key="Description">${escapeText(label)}</x:String>`);
  L.push(indent + 1, `</mxswa:ActivityReference.Properties>`);
  L.push(indent, `</mxswa:ActivityReference>`);
}

function renderConditionSequence(L: Lines, s: ResolvedStage): void {
  const I = 8;
  L.push(I, `<mxswa:ActivityReference AssemblyQualifiedName="${AQN.conditionSequence}" DisplayName="ConditionStep${s.conditionNumber}">`);
  L.push(I + 1, `<mxswa:ActivityReference.Arguments>`);
  L.push(I + 2, `<InArgument x:TypeArguments="x:Boolean" x:Key="Wait">False</InArgument>`);
  L.push(I + 1, `</mxswa:ActivityReference.Arguments>`);
  L.push(I + 1, `<mxswa:ActivityReference.Properties>`);
  L.push(I + 2, `<sco:Collection x:TypeArguments="Variable" x:Key="Variables">`);
  for (const b of s.branches) {
    const v = `ConditionBranchStep${b.branchNumber}`;
    L.push(I + 3, `<Variable x:TypeArguments="x:Boolean" Default="False" Name="${v}_condition" />`);
    const operandCount = 1 + (b.compareToColumn ? 1 : b.literals.length);
    for (let i = 1; i <= operandCount; i++) {
      L.push(I + 3, `<Variable x:TypeArguments="x:Object" Name="${v}_${i}" />`);
    }
  }
  L.push(I + 2, `</sco:Collection>`);
  L.push(I + 2, `<sco:Collection x:TypeArguments="Activity" x:Key="Activities">`);
  for (const b of s.branches) {
    const v = `ConditionBranchStep${b.branchNumber}`;
    renderGetEntityProperty(L, I + 3, b.column, s.entity, `${v}_1`);
    const parameterVars: string[] = [];
    if (b.compareToColumn) {
      renderGetEntityProperty(L, I + 3, b.compareToColumn, s.entity, `${v}_2`);
      parameterVars.push(`${v}_2`);
    } else {
      b.literals.forEach((literal, i) => {
        const out = `${v}_${i + 2}`;
        parameterVars.push(out);
        L.push(I + 3, `<mxswa:ActivityReference AssemblyQualifiedName="${AQN.evaluateExpression}" DisplayName="EvaluateExpression">`);
        L.push(I + 4, `<mxswa:ActivityReference.Arguments>`);
        L.push(I + 5, `<InArgument x:TypeArguments="x:String" x:Key="ExpressionOperator">CreateCrmType</InArgument>`);
        L.push(I + 5, `<InArgument x:TypeArguments="s:Object[]" x:Key="Parameters">${escapeText(`[New Object() { ${literal.parameters} }]`)}</InArgument>`);
        L.push(I + 5, `<InArgument x:TypeArguments="s:Type" x:Key="TargetType">`);
        L.push(I + 6, `<mxswa:ReferenceLiteral x:TypeArguments="s:Type" Value="${literal.targetType}" />`);
        L.push(I + 5, `</InArgument>`);
        L.push(I + 5, `<OutArgument x:TypeArguments="x:Object" x:Key="Result">[${out}]</OutArgument>`);
        L.push(I + 4, `</mxswa:ActivityReference.Arguments>`);
        L.push(I + 3, `</mxswa:ActivityReference>`);
      });
    }
    L.push(I + 3, `<mxswa:ActivityReference AssemblyQualifiedName="${AQN.evaluateCondition}" DisplayName="EvaluateCondition">`);
    L.push(I + 4, `<mxswa:ActivityReference.Arguments>`);
    L.push(I + 5, `<InArgument x:TypeArguments="mxsq:ConditionOperator" x:Key="ConditionOperator">${b.operator}</InArgument>`);
    L.push(I + 5, `<InArgument x:TypeArguments="s:Object[]" x:Key="Parameters">[New Object() { ${parameterVars.join(", ")} }]</InArgument>`);
    L.push(I + 5, `<InArgument x:TypeArguments="x:Object" x:Key="Operand">[${v}_1]</InArgument>`);
    L.push(I + 5, `<OutArgument x:TypeArguments="x:Boolean" x:Key="Result">[${v}_condition]</OutArgument>`);
    L.push(I + 4, `</mxswa:ActivityReference.Arguments>`);
    L.push(I + 3, `</mxswa:ActivityReference>`);
    renderConditionBranch(L, I + 3, b.branchNumber, `[${v}_condition]`, s.id, b.targetStageId, b.setNextNumber, b.label);
  }
  if (s.elseStage) {
    renderConditionBranch(L, I + 3, s.elseStage.branchNumber, "True", s.id, s.elseStage.targetStageId, s.elseStage.setNextNumber, "");
  }
  L.push(I + 2, `</sco:Collection>`);
  L.push(I + 2, `<x:Boolean x:Key="ContainsElseBranch">${boolText(!!s.elseStage)}</x:Boolean>`);
  L.push(I + 1, `</mxswa:ActivityReference.Properties>`);
  L.push(I, `</mxswa:ActivityReference>`);
}

// ---------------------------------------------------------------------------
// Minimal XML parser (enough for XAML exports: elements, attributes, text)
// ---------------------------------------------------------------------------

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function unescapeXml(value: string): string {
  return value.replace(/&(quot|amp|lt|gt|apos|#x[0-9a-fA-F]+|#\d+);/g, (_m, ent: string) => {
    switch (ent) {
      case "quot": return '"';
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "apos": return "'";
      default:
        return ent.startsWith("#x") ? String.fromCodePoint(parseInt(ent.slice(2), 16)) : String.fromCodePoint(parseInt(ent.slice(1), 10));
    }
  });
}

export function parseXml(source: string): XmlNode {
  const src = source.replace(/^﻿/, "");
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let pos = 0;
  const attrRe = /([^\s=\/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  while (pos < src.length) {
    const lt = src.indexOf("<", pos);
    if (lt === -1) {
      stack[stack.length - 1].text += unescapeXml(src.slice(pos));
      break;
    }
    if (lt > pos) stack[stack.length - 1].text += unescapeXml(src.slice(pos, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt);
      pos = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt);
      pos = end === -1 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt);
      stack[stack.length - 1].text += src.slice(lt + 9, end === -1 ? src.length : end);
      pos = end === -1 ? src.length : end + 3;
      continue;
    }
    const gt = findTagEnd(src, lt);
    if (gt === -1) throw new Error("Malformed XML: unterminated tag.");
    const raw = src.slice(lt + 1, gt);
    pos = gt + 1;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error(`Malformed XML: unexpected closing tag </${name}>.`);
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([^\s\/>]+)/.exec(body);
    if (!nameMatch) throw new Error("Malformed XML: tag without a name.");
    const node: XmlNode = { name: nameMatch[1], attrs: {}, children: [], text: "" };
    attrRe.lastIndex = 0;
    const attrSource = body.slice(nameMatch[1].length);
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrSource)) !== null) {
      node.attrs[m[1]] = unescapeXml(m[2] ?? m[3] ?? "");
    }
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`Malformed XML: unclosed element <${stack[stack.length - 1].name}>.`);
  return root;
}

function findTagEnd(src: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Parser: XAML -> definition
// ---------------------------------------------------------------------------

function kindOf(node: XmlNode): string {
  const aqn = node.attrs.AssemblyQualifiedName;
  if (!aqn) return node.name;
  const typeName = aqn.split(",")[0].trim();
  return typeName.slice(typeName.lastIndexOf(".") + 1);
}

function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find(c => c.name === name);
}

function propertyByKey(node: XmlNode | undefined, key: string): XmlNode | undefined {
  return node?.children.find(c => c.attrs["x:Key"] === key);
}

function collectionItems(props: XmlNode | undefined, key: string): XmlNode[] {
  return propertyByKey(props, key)?.children ?? [];
}

function findDescendant(node: XmlNode, name: string): XmlNode | undefined {
  for (const c of node.children) {
    if (c.name === name) return c;
    const deep = findDescendant(c, name);
    if (deep) return deep;
  }
  return undefined;
}

function findDescendants(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findDescendants(c, name, out);
  }
  return out;
}

function stripBrackets(value: string | undefined): string {
  return (value ?? "").trim().replace(/^\[|\]$/g, "");
}

function parseVbStringList(expression: string): string[] {
  const values: string[] = [];
  const re = /"((?:[^"]|"")*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expression)) !== null) values.push(m[1].replace(/""/g, '"'));
  return values;
}

interface ParsedLiteral { valueType: BpfBranchValueType; value: string | number | boolean }

function parseCreateCrmType(parameters: string): ParsedLiteral {
  const body = stripBrackets(parameters).replace(/^New Object\(\)\s*\{\s*/, "").replace(/\s*\}$/, "");
  const typeMatch = /WorkflowPropertyType\.(\w+)/.exec(body);
  if (!typeMatch) throw new Error(`Unrecognised CreateCrmType parameters: ${parameters}`);
  const strings = parseVbStringList(body);
  switch (typeMatch[1]) {
    case "OptionSetValue": {
      const sub = (strings[1] ?? "Picklist").toLowerCase();
      const valueType: BpfBranchValueType = sub === "status" ? "status" : sub === "state" ? "state" : "picklist";
      return { valueType, value: /^-?\d+$/.test(strings[0]) ? parseInt(strings[0], 10) : strings[0] };
    }
    case "Boolean":
      return { valueType: "boolean", value: /^(1|true)$/i.test(strings[0] ?? "") };
    case "Integer":
      return { valueType: "integer", value: parseInt(strings[0], 10) };
    case "Decimal":
      return { valueType: "decimal", value: strings[0] };
    case "String":
      return { valueType: "string", value: strings[0] ?? "" };
    default:
      throw new Error(`Branch literal type '${typeMatch[1]}' is not supported by the BPF builder.`);
  }
}

interface RawBranch {
  column: string;
  operator: BpfBranchOperator;
  literals: ParsedLiteral[];
  compareToColumn?: string;
  targetStageId: string;
  label: string;
}

export interface ParsedBpfStage extends BpfStageDefinition {
  id: string;
  entity: string;
  nextStageId: string | null;
}

export interface ParsedBpf extends BpfDefinition {
  workflowId: string;
  /** Stages in document order with their resolved ids and entity. */
  flatStages: ParsedBpfStage[];
}

/**
 * Parses exported/live BPF XAML back into the compact definition model. Stage references
 * (nextStage, branches, relationships) use the stage name when it is unique, else the id.
 */
export function parseBusinessProcessFlowXaml(xaml: string): ParsedBpf {
  const doc = parseXml(xaml);
  const activity = child(doc, "Activity");
  if (!activity) throw new Error("Not a workflow XAML document: missing <Activity> root.");
  const workflow = child(activity, "mxswa:Workflow");
  if (!workflow) throw new Error("Not a BPF XAML document: missing <mxswa:Workflow>.");
  const workflowId = extractWorkflowIdFromXaml(xaml) ?? "00000000-0000-0000-0000-000000000000";

  const relationships: Array<{ attributeName: string; relationshipName: string; sourceStageId: string; targetStageId: string }> = [];
  const stages: Array<{ id: string; name: string; designerName?: string; entity: string; category: number; nextStageId: string | null; isClosedLoop: boolean; steps: BpfStepDefinition[]; rawBranches: RawBranch[]; elseStageId?: string }> = [];

  for (const ref of workflow.children) {
    const kind = kindOf(ref);
    if (kind === "StageRelationshipCollectionComposite") {
      for (const rel of findDescendants(ref, "mcwb:StageRelationship")) {
        relationships.push({
          attributeName: rel.attrs.AttributeName,
          relationshipName: rel.attrs.RelationshipName,
          sourceStageId: rel.attrs.SourceStageId.toLowerCase(),
          targetStageId: rel.attrs.TargetStageId.toLowerCase()
        });
      }
      continue;
    }
    if (kind !== "EntityComposite") continue;
    const entity = (ref.attrs.DisplayName ?? "").replace(/^EntityStep\d+:\s*/, "").trim();
    const entityProps = child(ref, "mxswa:ActivityReference.Properties");
    const isClosedLoop = (propertyByKey(entityProps, "IsClosedLoop")?.text ?? "False").trim() === "True";
    for (const stageRef of collectionItems(entityProps, "Activities")) {
      if (kindOf(stageRef) !== "StageComposite") continue;
      const props = child(stageRef, "mxswa:ActivityReference.Properties");
      const labels = collectionItems(props, "StepLabels");
      const designerNameRaw = (stageRef.attrs.DisplayName ?? "").replace(/^StageStep\d+:\s*/, "");
      const name = labels[0]?.attrs.Description ?? (stageRef.attrs.DisplayName ?? "").replace(/^StageStep\d+:\s*/, "");
      const designerName = designerNameRaw && designerNameRaw !== name ? designerNameRaw : undefined;
      const id = (propertyByKey(props, "StageId")?.text ?? "").trim().toLowerCase();
      if (!isGuid(id)) throw new Error(`Stage '${name}' has no StageId.`);
      const category = parseInt((propertyByKey(props, "StageCategory")?.text ?? "-1").trim(), 10);
      const nextNode = propertyByKey(props, "NextStageId");
      const nextStageId = nextNode && nextNode.name !== "x:Null" && nextNode.text.trim() ? nextNode.text.trim().toLowerCase() : null;

      const steps: BpfStepDefinition[] = [];
      const rawBranches: RawBranch[] = [];
      let elseStageId: string | undefined;
      for (const act of collectionItems(props, "Activities")) {
        const actKind = kindOf(act);
        if (actKind === "StepComposite") {
          const stepProps = child(act, "mxswa:ActivityReference.Properties");
          const control = findDescendant(act, "mcwb:Control");
          if (!control) continue;
          const stepLabel = collectionItems(stepProps, "StepLabels")[0]?.attrs.Description ?? control.attrs.ControlDisplayName;
          const step: BpfStepDefinition = {
            id: (propertyByKey(stepProps, "ProcessStepId")?.text ?? "").trim().toLowerCase(),
            column: control.attrs.DataFieldName ?? control.attrs.ControlId,
            label: stepLabel,
            classId: control.attrs.ClassId?.toLowerCase(),
            required: (propertyByKey(stepProps, "IsProcessRequired")?.text ?? "False").trim() === "True"
          };
          if (control.attrs.ControlDisplayName !== stepLabel) step.controlDisplayName = control.attrs.ControlDisplayName;
          const typeEntry = Object.entries(BPF_CONTROL_CLASS_IDS).find(([, v]) => v.classId === step.classId);
          if (typeEntry) {
            step.type = typeEntry[0] as BpfColumnType;
            delete step.classId;
          }
          steps.push(step);
        } else if (actKind === "ConditionSequence") {
          const parsed = parseConditionSequence(act);
          rawBranches.push(...parsed.branches);
          elseStageId = parsed.elseStageId;
        }
      }
      stages.push({ id, name, designerName, entity, category, nextStageId, isClosedLoop, steps, rawBranches, elseStageId });
    }
  }

  const nameCounts = new Map<string, number>();
  for (const s of stages) nameCounts.set(s.name, (nameCounts.get(s.name) ?? 0) + 1);
  const refFor = (stageId: string): string => {
    const s = stages.find(x => x.id === stageId);
    if (!s) return stageId;
    return nameCounts.get(s.name) === 1 ? s.name : s.id;
  };

  const flatStages: ParsedBpfStage[] = stages.map((s, index) => {
    const defaultNext = index + 1 < stages.length ? stages[index + 1].id : null;
    const stage: ParsedBpfStage = {
      id: s.id,
      name: s.name,
      ...(s.designerName ? { designerName: s.designerName } : {}),
      entity: s.entity,
      category: s.category,
      nextStageId: s.nextStageId,
      steps: s.steps
    };
    if (s.nextStageId !== defaultNext) stage.nextStage = s.nextStageId ? refFor(s.nextStageId) : null;
    const rel = relationships.find(r => r.targetStageId === s.id);
    if (rel) stage.relationship = { sourceStage: refFor(rel.sourceStageId), relationshipName: rel.relationshipName, attributeName: rel.attributeName };
    if (s.rawBranches.length > 0) {
      stage.branches = s.rawBranches.map(b => {
        const branch: BpfBranchDefinition = { column: b.column, operator: b.operator, nextStage: refFor(b.targetStageId) };
        if (b.compareToColumn) branch.compareToColumn = b.compareToColumn;
        else {
          branch.valueType = b.literals[0].valueType;
          if (b.literals.length === 1) branch.value = b.literals[0].value;
          else branch.values = b.literals.map(l => l.value);
        }
        if (b.label) branch.label = b.label;
        return branch;
      });
    }
    if (s.elseStageId) stage.elseStage = refFor(s.elseStageId);
    if (s.isClosedLoop) stage.isClosedLoop = true;
    return stage;
  });

  // Group consecutive stages of the same table into segments.
  const segments: BpfEntitySegmentDefinition[] = [];
  for (const stage of flatStages) {
    const last = segments[segments.length - 1];
    const { entity, nextStageId, ...rest } = stage;
    void nextStageId;
    const def: BpfStageDefinition = rest;
    if (last && last.entity === entity) last.stages.push(def);
    else segments.push({ entity, stages: [def] });
  }

  return { workflowId, segments, flatStages };
}

function parseConditionSequence(node: XmlNode): { branches: RawBranch[]; elseStageId?: string } {
  const props = child(node, "mxswa:ActivityReference.Properties");
  const vars = new Map<string, { column?: string; literal?: ParsedLiteral }>();
  const pending = new Map<string, { operator: string; operandVar: string; paramVars: string[] }>();
  const branches: RawBranch[] = [];
  let elseStageId: string | undefined;

  for (const act of collectionItems(props, "Activities")) {
    if (act.name === "mxswa:GetEntityProperty") {
      vars.set(stripBrackets(act.attrs.Value), { column: act.attrs.Attribute });
      continue;
    }
    const kind = kindOf(act);
    const args = child(act, "mxswa:ActivityReference.Arguments");
    if (kind === "EvaluateExpression") {
      const parameters = propertyByKey(args, "Parameters")?.text ?? "";
      const result = stripBrackets(propertyByKey(args, "Result")?.text);
      vars.set(result, { literal: parseCreateCrmType(parameters) });
    } else if (kind === "EvaluateCondition") {
      const operator = (propertyByKey(args, "ConditionOperator")?.text ?? "Equal").trim();
      const paramText = stripBrackets(propertyByKey(args, "Parameters")?.text).replace(/^New Object\(\)\s*\{\s*/, "").replace(/\s*\}$/, "");
      const paramVars = paramText.split(",").map(p => p.trim()).filter(Boolean);
      const operandVar = stripBrackets(propertyByKey(args, "Operand")?.text);
      const resultVar = stripBrackets(propertyByKey(args, "Result")?.text);
      pending.set(resultVar, { operator, operandVar, paramVars });
    } else if (kind === "ConditionBranch") {
      const condition = (propertyByKey(args, "Condition")?.text ?? "").trim();
      const branchProps = child(act, "mxswa:ActivityReference.Properties");
      const setNext = findDescendant(act, "mcwc:SetNextStage");
      const targetStageId = (setNext?.attrs.StageId ?? "").toLowerCase();
      const label = propertyByKey(branchProps, "Description")?.text ?? "";
      if (condition === "True") {
        elseStageId = targetStageId;
        continue;
      }
      const cond = pending.get(stripBrackets(condition));
      if (!cond) throw new Error(`Condition branch '${act.attrs.DisplayName}' references an unknown condition variable.`);
      const operand = vars.get(cond.operandVar);
      if (!operand?.column) throw new Error(`Condition branch '${act.attrs.DisplayName}' does not read a column.`);
      const params = cond.paramVars.map(v => vars.get(v));
      const compare = params.find(p => p?.column);
      if (!BPF_BRANCH_OPERATORS.includes(cond.operator as BpfBranchOperator)) {
        throw new Error(`Branch operator '${cond.operator}' is not supported by the BPF builder.`);
      }
      branches.push({
        column: operand.column,
        operator: cond.operator as BpfBranchOperator,
        literals: compare ? [] : params.map(p => {
          if (!p?.literal) throw new Error(`Condition branch '${act.attrs.DisplayName}' compares against an unknown value.`);
          return p.literal;
        }),
        compareToColumn: compare?.column,
        targetStageId,
        label
      });
    }
  }
  return { branches, elseStageId };
}

/** Human-readable summary of a parsed BPF (used by the get tool). */
export function summarizeBusinessProcessFlow(parsed: ParsedBpf): string {
  const lines: string[] = [];
  parsed.flatStages.forEach((s, i) => {
    const next = s.nextStageId ? (parsed.flatStages.find(x => x.id === s.nextStageId)?.name ?? s.nextStageId) : "(end)";
    lines.push(`${i + 1}. [${s.entity}] ${s.name} (${stageCategoryLabel(Number(s.category))}, id ${s.id}) -> ${next}`);
    for (const step of s.steps ?? []) {
      lines.push(`     - ${step.label} [${step.column}]${step.required ? " (required)" : ""}`);
    }
    for (const b of s.branches ?? []) {
      const cmp = b.compareToColumn ? `[${b.compareToColumn}]` : JSON.stringify(b.values ?? b.value);
      lines.push(`     ? ${b.column} ${b.operator ?? "Equal"} ${cmp} -> ${b.nextStage}${b.label ? ` (${b.label})` : ""}`);
    }
    if (s.elseStage) lines.push(`     ? else -> ${s.elseStage}`);
    if (s.relationship) lines.push(`     ~ reached from '${s.relationship.sourceStage}' via ${s.relationship.relationshipName} (${s.relationship.attributeName})`);
  });
  return lines.join("\n");
}
