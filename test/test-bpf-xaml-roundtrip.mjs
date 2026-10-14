// Round-trip test for the BPF XAML builder/parser.
//
// 1. Parses real exported BPF XAML into the compact definition model, rebuilds the XAML
//    from that model (reusing the parsed ids) and checks that the rebuilt text is identical
//    to the export (after CRLF/BOM normalisation) and that re-parsing gives the same model.
// 2. Builds a synthetic definition (cross-table relationship, branches, else branch,
//    generated ids), parses it back and checks the structure GUIDs aside.
//
// Run: npm run build && npm run test:bpf-xaml

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  buildBusinessProcessFlowXaml,
  parseBusinessProcessFlowXaml,
  extractWorkflowIdFromXaml,
  setWorkflowIdInXaml,
  BPF_CONTROL_CLASS_IDS
} from "../build/tools/bpf-xaml.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const siblingRoot = path.resolve(here, "..", "..");

// The DDSol-IS export is the mandatory fixture; the others are optional sibling-repo samples.
const fixtures = [
  { name: "DDSol-IS CaseResolutionProcess (fixture)", file: path.join(here, "fixtures", "CaseResolutionProcess-DDSolIS.xaml"), required: true },
  { name: "DDSol-IS IssueResolutionProcess", file: path.join(siblingRoot, "DDSol-IS/Solutions/DDSolIS/src/Workflows/IssueResolutionProcess-6B015868-046B-F111-A826-000D3A69E384.xaml") },
  { name: "DDSolCustomerService IdeatoFeatureProcess", file: path.join(siblingRoot, "DDSolCustomerService/Solutions/DDSolCustomerServiceCore/src/Workflows/IdeatoFeatureProcess-13D37482-6606-F111-8407-7CED8D71FAC9.xaml") },
  { name: "DDSolCustomerService TicketResolutionProcess", file: path.join(siblingRoot, "DDSolCustomerService/Solutions/DDSolCustomerServiceCore/src/Workflows/TicketResolutionProcess-23D4893C-4B51-F111-BEC7-7CED8D71FAC9.xaml") },
  { name: "ElectronicsQCM ClaimBPF", file: path.join(siblingRoot, "ElectronicsQCM/Solutions/QualityClaimsManagement/src/Workflows/ClaimBPF-887B21F0-FCF5-4320-8826-1BDB06F78428.xaml") },
  { name: "ElectronicsQCM FailureAnalysisBPF", file: path.join(siblingRoot, "ElectronicsQCM/Solutions/QualityClaimsManagement/src/Workflows/FailureAnalysisBPF-1E97340D-C181-F111-AB0F-E4FB1EF77557.xaml") },
  { name: "ElectronicsQCM QCMReadAcrossBPF", file: path.join(siblingRoot, "ElectronicsQCM/Solutions/QcmReadacross/src/Workflows/QCMReadAcrossBPF-ED357FF2-C1B4-F011-BBD2-000D3ADD2E1A.xaml") },
  { name: "AkebonoECM ProjectLifecycle", file: path.join(siblingRoot, "AkebonoECM/Solutions/EngineeringChangeManagement/src/Workflows/ProjectLifecycle-7C2F950B-5E80-F111-AB0E-0022489E06EA.xaml") },
  { name: "TristoneBPI BPIRRBPF", file: path.join(siblingRoot, "TristoneBPI/Solutions/BulletproofIndustrializationSWCore/src/Workflows/BPIRRBPF-99AC149D-355B-EF11-BFE3-0022487EE4D6.xaml") }
];

const normalize = text => text.replace(/^﻿/, "").replace(/\r\n/g, "\n").trimEnd();

let failures = 0;
let passed = 0;

function report(ok, label, detail) {
  if (ok) {
    passed++;
    console.log(`PASS ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
  }
}

function firstDifference(a, b) {
  const al = a.split("\n");
  const bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      return `line ${i + 1}\n     expected: ${(al[i] ?? "<eof>").trim().slice(0, 200)}\n     actual:   ${(bl[i] ?? "<eof>").trim().slice(0, 200)}`;
    }
  }
  return "no line difference (length differs?)";
}

// Strips every GUID so two models can be compared "GUIDs aside".
function withoutGuids(value) {
  return JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<guid>"));
}

// ---------------------------------------------------------------------------
// 1. Round-trip real exports
// ---------------------------------------------------------------------------

for (const fixture of fixtures) {
  if (!existsSync(fixture.file)) {
    if (fixture.required) report(false, `${fixture.name}: fixture missing`, fixture.file);
    else console.log(`SKIP ${fixture.name} (not on this machine)`);
    continue;
  }
  const original = normalize(readFileSync(fixture.file, "utf8"));
  let parsed;
  try {
    parsed = parseBusinessProcessFlowXaml(original);
  } catch (error) {
    report(false, `${fixture.name}: parse`, error.message);
    continue;
  }
  report(parsed.flatStages.length > 0, `${fixture.name}: parsed ${parsed.flatStages.length} stage(s), ${parsed.flatStages.reduce((n, s) => n + (s.steps?.length ?? 0), 0)} step(s), ${parsed.flatStages.reduce((n, s) => n + (s.branches?.length ?? 0), 0)} branch(es)`);
  report(parsed.workflowId === extractWorkflowIdFromXaml(original), `${fixture.name}: workflow id ${parsed.workflowId}`);

  const rebuilt = buildBusinessProcessFlowXaml({ workflowId: parsed.workflowId, segments: parsed.segments });
  const exact = normalize(rebuilt.xaml) === original;
  report(exact, `${fixture.name}: rebuilt XAML is byte-identical to the export`, exact ? undefined : firstDifference(original, normalize(rebuilt.xaml)));

  const reparsed = parseBusinessProcessFlowXaml(rebuilt.xaml);
  let structural = true;
  let detail;
  try {
    assert.deepEqual(reparsed.segments, parsed.segments);
    assert.deepEqual(reparsed.flatStages, parsed.flatStages);
  } catch (error) {
    structural = false;
    detail = error.message.split("\n").slice(0, 12).join("\n     ");
  }
  report(structural, `${fixture.name}: re-parsed model equals the parsed model`, detail);
  report(rebuilt.warnings.length === 0, `${fixture.name}: no builder warnings`, rebuilt.warnings.join("; "));
}

// ---------------------------------------------------------------------------
// 2. Synthetic definition: generated ids, branches, else, cross-table relationship
// ---------------------------------------------------------------------------

const definition = {
  segments: [
    {
      entity: "ddsol_svc_case",
      stages: [
        {
          name: "New",
          category: "Identify",
          steps: [
            { column: "ddsol_bpfcheck_issubmissioncomplete", label: "Submission Complete?", type: "boolean", required: true },
            { column: "ddsol_prioritycode", label: "Priority", controlDisplayName: "Priority", type: "picklist" }
          ]
        },
        {
          name: "Review",
          category: 0,
          nextStage: "Closure",
          steps: [{ column: "ddsol_responsiblepartycode", label: "Responsible Party", type: "picklist" }],
          branches: [
            { column: "ddsol_responsiblepartycode", valueType: "picklist", value: 275040000, nextStage: "Resolution", label: "IF Handled by Customer" },
            { column: "ddsol_prioritycode", operator: "NotEqual", valueType: "picklist", values: [1, 2], nextStage: "Closure" },
            { column: "ddsol_keyuserid", operator: "NotEqual", compareToColumn: "ddsol_submittedbyid", nextStage: "Resolution" }
          ],
          elseStage: "Issue Resolution"
        },
        {
          name: "Resolution",
          category: "Resolve",
          nextStage: "Closure",
          steps: [{ column: "ddsol_resolution", label: "Resolution", type: "memo" }, { column: "ddsol_supportunits", label: "Support Units", type: "integer" }]
        }
      ]
    },
    {
      entity: "msdyn_projectissue",
      stages: [
        {
          name: "Issue Resolution",
          category: 6,
          nextStage: "Closure",
          relationship: { sourceStage: "Review", relationshipName: "ddsol_msdyn_projectissue_sourcecaseid_ddsol_svc_case", attributeName: "ddsol_sourcecaseid" },
          steps: [{ column: "ddsol_bpfstagecode", label: "Issue BPF Stage", type: "picklist", required: true }]
        }
      ]
    },
    {
      entity: "ddsol_svc_case",
      stages: [
        {
          name: "Closure",
          category: "Close",
          steps: [{ column: "statuscode", label: "Status Reason", type: "status" }, { column: "ddsol_closedon", label: "Closed On", type: "datetime" }]
        }
      ]
    }
  ]
};

try {
  const build = buildBusinessProcessFlowXaml(definition);
  report(/^[0-9a-f-]{36}$/.test(build.workflowId), `synthetic: generated workflow id ${build.workflowId}`);
  report(build.xaml.includes(`x:Class="XrmWorkflow${build.workflowId.replace(/-/g, "")}"`), "synthetic: x:Class embeds the workflow id");
  report(build.xaml.includes('xmlns:mcwc=') && build.xaml.includes('xmlns:mxsq=') && build.xaml.includes('xmlns:s='), "synthetic: condition namespaces present when branches exist");
  report(build.xaml.includes("<mcwb:StageRelationship AttributeName=\"ddsol_sourcecaseid\""), "synthetic: StageRelationship emitted");
  report(build.xaml.includes('<x:Boolean x:Key="ContainsElseBranch">True</x:Boolean>'), "synthetic: else branch emitted");
  report(build.xaml.includes('Key="ConditionOperator">NotEqual<'), "synthetic: NotEqual operator emitted");
  report(build.xaml.includes('[New Object() { ConditionBranchStep'), "synthetic: EvaluateCondition parameter variables emitted");
  report(build.warnings.length === 0, "synthetic: no warnings", build.warnings.join("; "));

  const parsed = parseBusinessProcessFlowXaml(build.xaml);
  report(parsed.flatStages.length === 5, `synthetic: parsed ${parsed.flatStages.length} stages`);
  report(parsed.flatStages.map(s => s.entity).join(",") === "ddsol_svc_case,ddsol_svc_case,ddsol_svc_case,msdyn_projectissue,ddsol_svc_case", "synthetic: stage entities preserved");
  const review = parsed.flatStages[1];
  report(review.branches?.length === 3 && review.elseStage === "Issue Resolution", "synthetic: branches and else parsed back");
  report(review.branches?.[0].value === 275040000 && review.branches?.[0].valueType === "picklist" && review.branches?.[0].label === "IF Handled by Customer", "synthetic: picklist literal branch parsed back");
  report(JSON.stringify(review.branches?.[1].values) === "[1,2]" && review.branches?.[1].operator === "NotEqual", "synthetic: multi-value branch parsed back");
  report(review.branches?.[2].compareToColumn === "ddsol_submittedbyid", "synthetic: column comparison branch parsed back");
  report(parsed.flatStages[3].relationship?.sourceStage === "Review" && parsed.flatStages[3].relationship?.attributeName === "ddsol_sourcecaseid", "synthetic: relationship parsed back");
  const closureId = parsed.flatStages[4].id;
  report(parsed.flatStages[1].nextStageId === closureId && parsed.flatStages[1].nextStage === "Closure" && parsed.flatStages[2].nextStageId === closureId && parsed.flatStages[3].nextStageId === closureId && parsed.flatStages[3].nextStage === undefined && parsed.flatStages[4].nextStageId === null, "synthetic: next stages preserved (explicit when not the default, omitted when default)");
  report(parsed.flatStages[0].steps[0].type === "boolean" && parsed.flatStages[0].steps[0].required === true && parsed.flatStages[4].steps[0].type === "status", "synthetic: step types resolved from ClassIds");

  // Rebuilding from the parsed model (ids now fixed) must be deterministic.
  const again = buildBusinessProcessFlowXaml({ workflowId: parsed.workflowId, segments: parsed.segments });
  report(again.xaml === build.xaml, "synthetic: rebuild from parsed model is byte-identical");

  // GUIDs aside, the parsed structure must match a second build with fresh ids.
  const fresh = parseBusinessProcessFlowXaml(buildBusinessProcessFlowXaml(definition).xaml);
  let same = true;
  let detail;
  try {
    assert.deepEqual(withoutGuids(fresh.segments), withoutGuids(parsed.segments));
  } catch (error) {
    same = false;
    detail = error.message.split("\n").slice(0, 10).join("\n     ");
  }
  report(same, "synthetic: structure equal across builds, GUIDs aside", detail);

  // Workflow id rewrite helper.
  const target = "11111111-2222-3333-4444-555555555555";
  const rewritten = setWorkflowIdInXaml(build.xaml, target);
  report(extractWorkflowIdFromXaml(rewritten) === target && !rewritten.includes(build.workflowId.replace(/-/g, "")), "synthetic: setWorkflowIdInXaml rewrites every class reference");
} catch (error) {
  report(false, "synthetic: build", error.stack);
}

// ---------------------------------------------------------------------------
// 3. Validation errors
// ---------------------------------------------------------------------------

function expectError(label, definition, pattern) {
  try {
    buildBusinessProcessFlowXaml(definition);
    report(false, label, "no error thrown");
  } catch (error) {
    report(pattern.test(error.message), label, error.message);
  }
}

expectError("validation: unknown stage reference", { segments: [{ entity: "a", stages: [{ name: "S1", nextStage: "Nope" }] }] }, /no stage is named 'Nope'/);
expectError("validation: ambiguous stage name", { segments: [{ entity: "a", stages: [{ name: "S" }, { name: "S" }, { name: "T", nextStage: "S" }] }] }, /ambiguous/);
expectError("validation: step without type", { segments: [{ entity: "a", stages: [{ name: "S1", steps: [{ column: "x", label: "X" }] }] }] }, /column type \(or classId\) is required/);
expectError("validation: branch without value", { segments: [{ entity: "a", stages: [{ name: "S1", branches: [{ column: "x", nextStage: "S2" }] }, { name: "S2" }] }] }, /value\(s\) or compareToColumn required/);
expectError("validation: else without branches", { segments: [{ entity: "a", stages: [{ name: "S1", elseStage: "S2" }, { name: "S2" }] }] }, /elseStage requires at least one branch/);
expectError("validation: bad category", { segments: [{ entity: "a", stages: [{ name: "S1", category: "Whatever" }] }] }, /Unknown stage category/);

const money = buildBusinessProcessFlowXaml({ segments: [{ entity: "a", stages: [{ name: "S1", steps: [{ column: "amt", label: "Amount", type: "money" }] }] }] });
report(money.warnings.length === 1 && money.xaml.includes(BPF_CONTROL_CLASS_IDS.money.classId), "validation: FormXML-sourced ClassId produces a warning");

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
