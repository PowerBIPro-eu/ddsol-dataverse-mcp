#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DataverseClient } from "./dataverse-client.js";
import { 
  createTableTool,
  getTableTool,
  updateTableTool,
  deleteTableTool,
  listTablesTool
} from "./tools/table-tools.js";
import {
  createColumnTool,
  getColumnTool,
  updateColumnTool,
  deleteColumnTool,
  listColumnsTool
} from "./tools/column-tools.js";
import {
  createRelationshipTool,
  getRelationshipTool,
  deleteRelationshipTool,
  listRelationshipsTool
} from "./tools/relationship-tools.js";
import {
  createOptionSetTool,
  getOptionSetTool,
  updateOptionSetTool,
  deleteOptionSetTool,
  listOptionSetsTool,
  getOptionSetOptionsTool
} from "./tools/optionset-tools.js";
import {
  createPublisherTool,
  createSolutionTool,
  getSolutionTool,
  getPublisherTool,
  listSolutionsTool,
  listPublishersTool,
  setSolutionContextTool,
  getSolutionContextTool,
  clearSolutionContextTool,
  addSolutionComponentTool
} from "./tools/solution-tools.js";
import {
  createRoleTool,
  getRoleTool,
  updateRoleTool,
  deleteRoleTool,
  listRolesTool,
  addPrivilegesToRoleTool,
  removePrivilegeFromRoleTool,
  replaceRolePrivilegesTool,
  getRolePrivilegesTool,
  assignRoleToUserTool,
  removeRoleFromUserTool,
  assignRoleToTeamTool,
  removeRoleFromTeamTool,
  grantTablePrivilegesTool
} from "./tools/role-tools.js";
import {
  createTeamTool,
  getTeamTool,
  updateTeamTool,
  deleteTeamTool,
  listTeamsTool,
  addMembersToTeamTool,
  removeMembersFromTeamTool,
  getTeamMembersTool,
  convertOwnerTeamToAccessTeamTool
} from "./tools/team-tools.js";
import {
  createBusinessUnitTool,
  getBusinessUnitTool,
  updateBusinessUnitTool,
  deleteBusinessUnitTool,
  listBusinessUnitsTool,
  getBusinessUnitHierarchyTool,
  setBusinessUnitParentTool,
  getBusinessUnitUsersTool,
  getBusinessUnitTeamsTool
} from "./tools/businessunit-tools.js";
import {
  exportSolutionSchemaTool,
  generateMermaidDiagramTool
} from "./tools/schema-tools.js";
import {
  generateWebAPICallTool
} from "./tools/webapi-tools.js";
import {
  generatePowerPagesWebAPICallTool
} from "./tools/powerpages-webapi-tools.js";
import {
  managePowerPagesWebAPIConfigTool
} from "./tools/powerpages-config-tools.js";
import {
  createAutoNumberColumnTool,
  updateAutoNumberFormatTool,
  setAutoNumberSeedTool,
  getAutoNumberColumnTool,
  listAutoNumberColumnsTool,
  convertToAutoNumberTool
} from "./tools/autonumber-tools.js";
import {
  createViewTool,
  getViewTool,
  updateViewTool,
  deleteViewTool,
  listViewsTool
} from "./tools/view-tools.js";
import {
  createFormTool,
  getFormTool,
  updateFormTool,
  deleteFormTool,
  listFormsTool
} from "./tools/form-tools.js";
import {
  publishDataverseCustomizationsTool
} from "./tools/publish-tools.js";
import {
  registerWebAPIResources
} from "./resources/webapi-resources.js";
import {
  registerPowerPagesResources
} from "./resources/powerpages-resources.js";
import {
  listDataverseEnvironmentsTool,
  setDataverseEnvironmentTool,
  getActiveDataverseEnvironmentTool
} from "./tools/environment-tools.js";

// Environment variables for Dataverse authentication
// DATAVERSE_URL is optional in device mode: it's just the starting environment;
// use list_dataverse_environments / set_dataverse_environment to pick/switch at runtime.
const DATAVERSE_URL = process.env.DATAVERSE_URL || '';
const CLIENT_ID = process.env.DATAVERSE_CLIENT_ID;
const CLIENT_SECRET = process.env.DATAVERSE_CLIENT_SECRET;
// 'organizations' lets Entra resolve the signing-in user's own tenant automatically,
// so device-mode setups don't need to know their Tenant ID upfront.
const TENANT_ID = process.env.DATAVERSE_TENANT_ID || 'organizations';
const AUTH_MODE = (process.env.DATAVERSE_AUTH_MODE as 'client_secret' | 'device' | undefined) || (CLIENT_SECRET ? 'client_secret' : 'device');

if (!CLIENT_ID) {
  throw new Error('Missing required environment variable: DATAVERSE_CLIENT_ID');
}
if (AUTH_MODE === 'client_secret' && !DATAVERSE_URL) {
  throw new Error('DATAVERSE_URL is required when DATAVERSE_AUTH_MODE=client_secret');
}
if (AUTH_MODE === 'client_secret' && !CLIENT_SECRET) {
  throw new Error('DATAVERSE_CLIENT_SECRET is required when DATAVERSE_AUTH_MODE=client_secret');
}
if (AUTH_MODE === 'client_secret' && !process.env.DATAVERSE_TENANT_ID) {
  throw new Error('DATAVERSE_TENANT_ID is required when DATAVERSE_AUTH_MODE=client_secret');
}

// Create MCP server
const server = new McpServer({
  name: "dataverse-mcp",
  version: "0.2.2"
});

// Initialize Dataverse client
const dataverseClient = new DataverseClient({
  dataverseUrl: DATAVERSE_URL,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  tenantId: TENANT_ID,
  authMode: AUTH_MODE
});

// Register table tools
createTableTool(server, dataverseClient);
getTableTool(server, dataverseClient);
updateTableTool(server, dataverseClient);
deleteTableTool(server, dataverseClient);
listTablesTool(server, dataverseClient);

// Register column tools
createColumnTool(server, dataverseClient);
getColumnTool(server, dataverseClient);
updateColumnTool(server, dataverseClient);
deleteColumnTool(server, dataverseClient);
listColumnsTool(server, dataverseClient);

// Register relationship tools
createRelationshipTool(server, dataverseClient);
getRelationshipTool(server, dataverseClient);
deleteRelationshipTool(server, dataverseClient);
listRelationshipsTool(server, dataverseClient);

// Register option set tools
createOptionSetTool(server, dataverseClient);
getOptionSetTool(server, dataverseClient);
updateOptionSetTool(server, dataverseClient);
deleteOptionSetTool(server, dataverseClient);
listOptionSetsTool(server, dataverseClient);
getOptionSetOptionsTool(server, dataverseClient);

// Register solution and publisher tools
createPublisherTool(server, dataverseClient);
createSolutionTool(server, dataverseClient);
getSolutionTool(server, dataverseClient);
getPublisherTool(server, dataverseClient);
listSolutionsTool(server, dataverseClient);
listPublishersTool(server, dataverseClient);

// Register solution context tools
setSolutionContextTool(server, dataverseClient);
getSolutionContextTool(server, dataverseClient);
clearSolutionContextTool(server, dataverseClient);
addSolutionComponentTool(server, dataverseClient);

// Register role tools
createRoleTool(server, dataverseClient);
getRoleTool(server, dataverseClient);
updateRoleTool(server, dataverseClient);
deleteRoleTool(server, dataverseClient);
listRolesTool(server, dataverseClient);

// Register role privilege tools
addPrivilegesToRoleTool(server, dataverseClient);
removePrivilegeFromRoleTool(server, dataverseClient);
replaceRolePrivilegesTool(server, dataverseClient);
getRolePrivilegesTool(server, dataverseClient);
grantTablePrivilegesTool(server, dataverseClient);

// Register role assignment tools
assignRoleToUserTool(server, dataverseClient);
removeRoleFromUserTool(server, dataverseClient);
assignRoleToTeamTool(server, dataverseClient);
removeRoleFromTeamTool(server, dataverseClient);

// Register team tools
createTeamTool(server, dataverseClient);
getTeamTool(server, dataverseClient);
updateTeamTool(server, dataverseClient);
deleteTeamTool(server, dataverseClient);
listTeamsTool(server, dataverseClient);

// Register team membership tools
addMembersToTeamTool(server, dataverseClient);
removeMembersFromTeamTool(server, dataverseClient);
getTeamMembersTool(server, dataverseClient);
convertOwnerTeamToAccessTeamTool(server, dataverseClient);

// Register business unit tools
createBusinessUnitTool(server, dataverseClient);
getBusinessUnitTool(server, dataverseClient);
updateBusinessUnitTool(server, dataverseClient);
deleteBusinessUnitTool(server, dataverseClient);
listBusinessUnitsTool(server, dataverseClient);

// Register business unit hierarchy and relationship tools
getBusinessUnitHierarchyTool(server, dataverseClient);
setBusinessUnitParentTool(server, dataverseClient);
getBusinessUnitUsersTool(server, dataverseClient);
getBusinessUnitTeamsTool(server, dataverseClient);

// Register schema export tool
exportSolutionSchemaTool(server, dataverseClient);

// Register Mermaid diagram generation tool
generateMermaidDiagramTool(server, dataverseClient);

// Register WebAPI call generator tool
generateWebAPICallTool(server, dataverseClient);

// Register PowerPages WebAPI call generator tool
generatePowerPagesWebAPICallTool(server, dataverseClient);

// Register PowerPages configuration management tool
managePowerPagesWebAPIConfigTool(server, dataverseClient);

// Register AutoNumber column tools
createAutoNumberColumnTool(server, dataverseClient);
updateAutoNumberFormatTool(server, dataverseClient);
setAutoNumberSeedTool(server, dataverseClient);
getAutoNumberColumnTool(server, dataverseClient);
listAutoNumberColumnsTool(server, dataverseClient);
convertToAutoNumberTool(server, dataverseClient);

// Register WebAPI code generation resources
registerWebAPIResources(server, dataverseClient);

// Register PowerPages code generation resources
registerPowerPagesResources(server, dataverseClient);

// Register Dataverse environment discovery/switching tools
listDataverseEnvironmentsTool(server, dataverseClient);
setDataverseEnvironmentTool(server, dataverseClient);
getActiveDataverseEnvironmentTool(server, dataverseClient);

// Register view tools
createViewTool(server, dataverseClient);
getViewTool(server, dataverseClient);
updateViewTool(server, dataverseClient);
deleteViewTool(server, dataverseClient);
listViewsTool(server, dataverseClient);

// Register form tools
createFormTool(server, dataverseClient);
getFormTool(server, dataverseClient);
updateFormTool(server, dataverseClient);
deleteFormTool(server, dataverseClient);
listFormsTool(server, dataverseClient);

// Register publish tool
publishDataverseCustomizationsTool(server, dataverseClient);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Dataverse MCP server running on stdio');