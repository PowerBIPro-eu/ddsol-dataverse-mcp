import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataverseClient } from "../dataverse-client.js";

const FORM_FACTORS = { web: 0, mobile: 1, tablet: 2 } as const;
type FormFactorName = keyof typeof FORM_FACTORS;

// Reflow/all are the only enum values confirmed against a live Dataverse-generated view; the remaining
// enum options are taken from Microsoft's documented UI labels and have not been confirmed against a live payload.
const REFLOW_BEHAVIORS = ["Reflow", "GridOnly", "ListOnly"] as const;
const NAVIGATION_TYPES = ["all", "primary", "none"] as const;

interface PowerAppsGridOptions {
  accessibleLabel: string;
  enableEditing: boolean;
  disableChildItemsEditing: boolean;
  enableFiltering: boolean;
  enableSorting: boolean;
  enableGrouping: boolean;
  enableAggregation: boolean;
  enableColumnMoving: boolean;
  enableMultipleSelection: boolean;
  enableRangeSelection: boolean;
  enableJumpBar: boolean;
  enablePagination: boolean;
  enableDropdownColor: boolean;
  enableStatusIcons: boolean;
  enableTypeIcons: boolean;
  navigationTypesAllowed: typeof NAVIGATION_TYPES[number];
  reflowBehavior: typeof REFLOW_BEHAVIORS[number];
  showAvatar: boolean;
  showColumnNamesForListView: boolean;
  enableBandedRowsForListView: boolean;
  numberOfListColumns: number;
  contextualLookupColumnFilters: boolean;
  lookupFilterBeginsWith: boolean;
  useFirstColumnForLookupEdits: boolean;
  gridCustomizerControlFullName: string;
  enableStatusColumn: boolean;
  formFactors: FormFactorName[];
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

// Verified against a live Dataverse-generated view layoutxml (Microsoft.PowerApps.PowerAppsOneGrid, formFactor 0/1/2).
function powerAppsGridParameters(options: PowerAppsGridOptions): string {
  return `<data-set name="Items"><ViewId>00000000-0000-0000-0000-000000000000</ViewId></data-set>` +
    `<AccessibleLabel static="true" type="SingleLine.Text">${options.accessibleLabel}</AccessibleLabel>` +
    `<EnableEditing static="true" type="Enum">${yesNo(options.enableEditing)}</EnableEditing>` +
    `<DisableChildItemsEditing static="true" type="Enum">${yesNo(options.disableChildItemsEditing)}</DisableChildItemsEditing>` +
    `<EnableFiltering static="true" type="Enum">${yesNo(options.enableFiltering)}</EnableFiltering>` +
    `<EnableSorting static="true" type="Enum">${yesNo(options.enableSorting)}</EnableSorting>` +
    `<EnableGrouping static="true" type="Enum">${yesNo(options.enableGrouping)}</EnableGrouping>` +
    `<EnableAggregation static="true" type="Enum">${yesNo(options.enableAggregation)}</EnableAggregation>` +
    `<EnableColumnMoving static="true" type="Enum">${yesNo(options.enableColumnMoving)}</EnableColumnMoving>` +
    `<EnableMultipleSelection static="true" type="Enum">${yesNo(options.enableMultipleSelection)}</EnableMultipleSelection>` +
    `<EnableRangeSelection static="true" type="Enum">${yesNo(options.enableRangeSelection)}</EnableRangeSelection>` +
    `<EnableJumpBar static="true" type="Enum">${yesNo(options.enableJumpBar)}</EnableJumpBar>` +
    `<EnablePagination static="true" type="Enum">${yesNo(options.enablePagination)}</EnablePagination>` +
    `<EnableDropdownColor static="true" type="Enum">${yesNo(options.enableDropdownColor)}</EnableDropdownColor>` +
    `<EnableStatusIcons static="true" type="Enum">${yesNo(options.enableStatusIcons)}</EnableStatusIcons>` +
    `<EnableTypeIcons static="true" type="Enum">${yesNo(options.enableTypeIcons)}</EnableTypeIcons>` +
    `<NavigationTypesAllowed static="true" type="Enum">${options.navigationTypesAllowed}</NavigationTypesAllowed>` +
    `<ReflowBehavior static="true" type="Enum">${options.reflowBehavior}</ReflowBehavior>` +
    `<ShowAvatar static="true" type="Enum">${yesNo(options.showAvatar)}</ShowAvatar>` +
    `<ShowColumnNamesForListView static="true" type="Enum">${yesNo(options.showColumnNamesForListView)}</ShowColumnNamesForListView>` +
    `<EnableBandedRowsForListView static="true" type="Enum">${yesNo(options.enableBandedRowsForListView)}</EnableBandedRowsForListView>` +
    `<NumberOfListColumns static="true" type="Whole.None">${options.numberOfListColumns}</NumberOfListColumns>` +
    `<ContextualLookupColumnFilters static="true" type="Enum">${yesNo(options.contextualLookupColumnFilters)}</ContextualLookupColumnFilters>` +
    `<LookupFilterBeginsWith static="true" type="Enum">${yesNo(options.lookupFilterBeginsWith)}</LookupFilterBeginsWith>` +
    `<UseFirstColumnForLookupEdits static="true" type="Enum">${yesNo(options.useFirstColumnForLookupEdits)}</UseFirstColumnForLookupEdits>` +
    `<GridCustomizerControlFullName static="true" type="SingleLine.Text">${options.gridCustomizerControlFullName}</GridCustomizerControlFullName>` +
    `<EnableStatusColumn static="true" type="Enum">${yesNo(options.enableStatusColumn)}</EnableStatusColumn>`;
}

function powerAppsGridControlDescriptions(options: PowerAppsGridOptions): string {
  if (options.formFactors.length === 0) {
    throw new Error("At least one form factor (web, mobile, tablet) must be selected for the grid control to show anywhere.");
  }

  const formFactorControls = options.formFactors
    .map(name => FORM_FACTORS[name])
    .map(formFactor => `<customControl formFactor="${formFactor}" name="Microsoft.PowerApps.PowerAppsOneGrid"><parameters>${powerAppsGridParameters(options)}</parameters></customControl>`)
    .join("");

  return `<controlDescriptions><controlDescription><customControl id="{E7A81278-8635-4D9E-8D4D-59480B391C5B}"><parameters/></customControl>${formFactorControls}</controlDescription></controlDescriptions>`;
}

function stripExistingControlDescriptions(layoutXml: string): string {
  return layoutXml.replace(/<controlDescriptions>[\s\S]*?<\/controlDescriptions>/, "");
}

function insertControlDescriptions(layoutXml: string, controlDescriptions: string): string {
  const closingGridIndex = layoutXml.lastIndexOf("</grid>");
  if (closingGridIndex === -1) {
    throw new Error("View LayoutXML does not contain a closing </grid> tag; cannot add the grid control.");
  }
  return layoutXml.slice(0, closingGridIndex) + controlDescriptions + layoutXml.slice(closingGridIndex);
}

export function setViewPowerAppsGridControlTool(server: McpServer, client: DataverseClient) {
  server.registerTool(
    "set_dataverse_view_powerapps_grid_control",
    {
      title: "Set Dataverse View Power Apps Grid Control",
      description: "Adds, replaces, or reconfigures the Power Apps grid control (Microsoft.PowerApps.PowerAppsOneGrid) on a specific system view by editing its LayoutXML. This only affects the given view, not the whole table. Defaults match the maker portal's default-add state for every option except navigationTypesAllowed='primary'/'none' and reflowBehavior='GridOnly'/'ListOnly', which are documented UI labels not yet confirmed against a live payload.",
      inputSchema: {
        savedQueryId: z.string().describe("GUID of the view (savedqueryid) to add or reconfigure the grid control on"),
        accessibleLabel: z.string().default("").describe("Accessible label for the grid"),
        enableEditing: z.boolean().default(false).describe("Whether the grid allows inline editing"),
        disableChildItemsEditing: z.boolean().default(false).describe("Whether editing is disabled in a nested/child grid when the parent grid is editable"),
        enableFiltering: z.boolean().default(true).describe("Whether column header filter dropdowns are available"),
        enableSorting: z.boolean().default(true).describe("Whether column header sort options are available"),
        enableGrouping: z.boolean().default(false).describe("Whether users can group rows by a column"),
        enableAggregation: z.boolean().default(false).describe("Whether sum/min/max/average aggregation is available on numeric columns"),
        enableColumnMoving: z.boolean().default(false).describe("Whether users can reorder columns by dragging or the column header menu"),
        enableMultipleSelection: z.boolean().default(true).describe("Whether users can select multiple rows at once"),
        enableRangeSelection: z.boolean().default(true).describe("Whether users can select and copy a range of cells"),
        enableJumpBar: z.boolean().default(false).describe("Whether an alphabetic jump bar is shown"),
        enablePagination: z.boolean().default(false).describe("Whether paging buttons are shown instead of infinite scroll"),
        enableDropdownColor: z.boolean().default(false).describe("Whether choice column values show their configured background color"),
        enableStatusIcons: z.boolean().default(true).describe("Whether row status icons are shown during editing"),
        enableTypeIcons: z.boolean().default(false).describe("Whether column headers show a data-type icon"),
        navigationTypesAllowed: z.enum(NAVIGATION_TYPES).default("all").describe("Which lookup columns render as hyperlinks: 'all', 'primary' (primary column only), or 'none'. Only 'all' is confirmed against a live payload."),
        reflowBehavior: z.enum(REFLOW_BEHAVIORS).default("Reflow").describe("Grid rendering mode: 'Reflow' (adaptive), 'GridOnly', or 'ListOnly'. Only 'Reflow' is confirmed against a live payload."),
        showAvatar: z.boolean().default(true).describe("Whether the avatar icon is shown in list view"),
        showColumnNamesForListView: z.boolean().default(false).describe("Whether column labels are shown before values in list view"),
        enableBandedRowsForListView: z.boolean().default(false).describe("Whether alternating row banding is applied in list view"),
        numberOfListColumns: z.number().int().min(1).max(10).default(3).describe("Number of columns to render in list view"),
        contextualLookupColumnFilters: z.boolean().default(true).describe("Whether lookup column filters are limited to values present in the current result set"),
        lookupFilterBeginsWith: z.boolean().default(false).describe("Whether lookup suggestions are filtered from their starting letter"),
        useFirstColumnForLookupEdits: z.boolean().default(false).describe("Whether lookup cell edits show/filter by the target table's first lookup-view column instead of the primary column"),
        gridCustomizerControlFullName: z.string().default("").describe("Full name of a PCF customizer control to use for grid visuals/interactions"),
        enableStatusColumn: z.boolean().default(true).describe("(Deprecated) Whether the status column is shown"),
        formFactors: z.array(z.enum(["web", "mobile", "tablet"])).default(["web", "mobile", "tablet"]).describe("Which client form factors show this grid control"),
        confirmUpdate: z.boolean().default(false).describe("Must be true to update the view's LayoutXML")
      }
    },
    async (params) => {
      try {
        if (!params.confirmUpdate) {
          throw new Error("Set confirmUpdate to true after reviewing the target view.");
        }

        const view = await client.get<{ layoutxml: string; name: string; returnedtypecode: string }>(
          `savedqueries(${params.savedQueryId})?$select=layoutxml,name,returnedtypecode`
        );

        if (!view.layoutxml) {
          throw new Error(`View '${params.savedQueryId}' has no LayoutXML to modify.`);
        }

        const strippedLayoutXml = stripExistingControlDescriptions(view.layoutxml);
        const newLayoutXml = insertControlDescriptions(strippedLayoutXml, powerAppsGridControlDescriptions(params));

        await client.patch(`savedqueries(${params.savedQueryId})`, { layoutxml: newLayoutXml });

        const verification = await client.get<{ layoutxml: string }>(`savedqueries(${params.savedQueryId})?$select=layoutxml`);

        return {
          content: [{
            type: "text",
            text: `Successfully configured the Power Apps grid control on view '${view.name}' (table '${view.returnedtypecode}', savedqueryid: ${params.savedQueryId}).\n\nPublishing is required before the grid control change is visible in model-driven apps. Use publish_dataverse_customizations with entityLogicalName '${view.returnedtypecode}' when ready. Immediate reads may show the previous published LayoutXML until publishing completes.\n\nVerification LayoutXML:\n${verification.layoutxml}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error setting view Power Apps grid control: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );
}

