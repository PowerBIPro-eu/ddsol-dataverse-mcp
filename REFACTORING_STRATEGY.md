# Column Naming Refactoring Strategy

## Executive Summary

Move naming logic **entirely to the agent layer**. The MCP becomes a pure data-plane tool that:
1. Accepts explicit `schemaName` and `logicalName` from the agent
2. Validates only the invariants (schema == logical, collision rule)
3. Creates the column without generating or suggesting names

The agent layer (via `dataverse-schema-builder` skill) handles all naming convention logic and passes fully-formed names to the MCP.

---

## Current Implementation Issues

### Issue 1: Simplistic Name Generation
**Current code:**
```typescript
function generateColumnLogicalName(displayName: string, prefix: string): string {
  const cleanName = displayName.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove special characters
    .replace(/\s+/g, ''); // Remove all spaces
  
  return `${prefix}_${cleanName}`;
}
```

**Problem:** 
- Ignores column type completely
- No enforcement of type-specific suffixes (lookup→id, picklist→code, boolean→is, etc.)
- "Customer Email" for a Lookup becomes `prefix_customeremail` (WRONG - needs `id` suffix)
- "Active Status" for Boolean becomes `prefix_activestatus` (WRONG - needs `is` prefix)

---

## Type-Specific Naming Conventions (from agent instructions)

These MUST be enforced:

| Column Type | Convention | Example Display | Example Schema |
|---|---|---|---|
| **Lookup** | MUST end with `id` | `Customer` | `customerid` |
| **Picklist/Choice** | Must end with `code` | `Status Type` | `statustypecode` |
| **Boolean** | Must start with `is` | `Is Active` | `isactive` |
| **Date (Either Type)** | May end with `date` or `on` — user choice | `Effective Date` | `effectivedate` or `effectiveon` |
| **AutoNumber** | Should end with `no` | `Invoice #` | `invoiceno` |
| **Formula** | Should start with `fx` | `Total Amount` | `fxtotalamount` |

---

## Critical Collision Rule

**The Problem:**
When you create a Lookup column, Dataverse **automatically generates a navigation property** ending in `Id`:
```typescript
// If you create lookup "customerid"
// Dataverse auto-generates navigation property: "CustomerID"
// If you pre-created a non-lookup column named "CustomerID" (e.g., integer), 
// COLLISION! Lookup creation fails.
```

**The Rule:**
- ❌ **NEVER** name a NON-LOOKUP column with `Id` suffix
  - `prefix_DepartmentId` (integer) - COLLISION with lookup navigation property
- ✅ **ALWAYS** name LOOKUP columns with `id` suffix
  - `prefix_Departmentid` → `prefix_departmentid` (lowercase in schema)

---

## Refactoring Phases

### Phase 1: Create Naming Utility Module
**File**: `src/utils/column-naming.ts` (NEW)

**Exports these functions:**

#### 1. `generateColumnName()`
```typescript
export interface ColumnNameResult {
  logicalName: string;
  schemaName: string;
  appliedConventions: string[];
  warnings: string[];
}

export function generateColumnName(
  displayName: string,
  columnType: string,
  prefix: string
): ColumnNameResult {
  // Converts "Customer" + "Lookup" → "prefix_customerid"
  // Returns what conventions were applied
  // Returns warnings if conventions were applied (e.g., added 'id' to non-lookup)
}
```

**Logic:**
1. Normalize display name: lowercase, remove spaces/special chars
2. Apply type-specific suffix/prefix based on `columnType`
3. Check collision rule
4. Return generated name + applied conventions + warnings

---

#### 2. `validateColumnName()`
```typescript
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateColumnName(
  logicalName: string,
  columnType: string
): ValidationResult {
  // Validates that logicalName follows conventions for columnType
  // Returns specific error messages
  // Examples:
  // - Lookup without 'id' suffix → error
  // - Non-lookup with 'Id' suffix → error (collision)
  // - DateTime without 'on' suffix → warning (not error)
}
```

**Validation Rules:**

```
For LOOKUP columns:
  ✓ Must end with 'id' (lowercase)
  ✗ Error if doesn't: "Lookup column must end with 'id' suffix"
  ✗ Error if ends with 'Id' (capital): "Schema name has capital 'Id' - use lowercase 'id'"

For PICKLIST columns:
  ✓ Should end with 'code'
  ✗ Error if doesn't: "Picklist column should end with 'code' suffix"

For BOOLEAN columns:
  ✓ Should start with 'is'
  ✗ Error if doesn't: "Boolean column should start with 'is' prefix"

For DATE columns (either Date Only or Date & Time):
  ✓ May end with 'date' (e.g., 'effectivedate')
  ✓ May end with 'on' (e.g., 'effectiveon')
  ⚠ Neither is required - user choice
  • Example: "Effective Date" → could be 'effectivedate' or 'effectiveon'

For AUTONUMBER columns:
  ✓ Should end with 'no'
  ⚠ Warning if doesn't: "AutoNumber column conventionally ends with 'no'"

For FORMULA columns:
  ✓ Should start with 'fx'
  ⚠ Warning if doesn't: "Calculated column conventionally starts with 'fx'"

For ALL NON-LOOKUP columns:
  ✗ COLLISION ERROR if ends with 'Id' (capital I, d lowercase):
    "Schema name ends with 'Id' but column is not Lookup. This will 
     collide with auto-generated navigation property from lookup creation."
```

---

#### 3. Helper Functions
```typescript
function applyColumnTypeSuffix(
  baseName: string,
  columnType: string
): { name: string, convention: string }
// Note: For Date columns, returns guidance only (both 'date' and 'on' are valid)

function checkCollisionRule(
  schemaName: string,
  columnType: string
): { safe: boolean, warning?: string }

function isLookupType(columnType: string): boolean
function isPicklistType(columnType: string): boolean
function isBooleanType(columnType: string): boolean
function isDateType(columnType: string): boolean  // Combined for both Date types
function isAutoNumberType(columnType: string): boolean
function isFormulaType(columnType: string): boolean
```

---

### Phase 2: Update `createColumnTool`

**Changes to input schema:**

```typescript
// BEFORE
inputSchema: {
  entityLogicalName: z.string(),
  displayName: z.string(),
  columnType: z.enum([...]),
  // ... other params
}

// AFTER
inputSchema: {
  entityLogicalName: z.string(),
  displayName: z.string(),
  columnType: z.enum([...]),
  schemaName: z.string().optional()
    .describe("Override auto-generated schema name (must follow conventions)"),
  logicalName: z.string().optional()
    .describe("Override auto-generated logical name (must match schemaName)"),
  // ... other params
}
```

**Changes to tool handler:**

```typescript
async (params) => {
  try {
    const prefix = client.getCustomizationPrefix();
    
    // STEP 1: Generate or validate names
    let logicalName: string;
    let schemaName: string;
    let appliedConventions: string[] = [];
    let warnings: string[] = [];
    
    if (params.schemaName && params.logicalName) {
      // Agent provided explicit names - validate them
      const validation = validateColumnName(params.logicalName, params.columnType);
      if (!validation.valid) {
        throw new Error(
          `Column naming violation:\n${validation.errors.join('\n')}`
        );
      }
      schemaName = params.schemaName;
      logicalName = params.logicalName;
      warnings = validation.warnings;
    } else if (params.schemaName || params.logicalName) {
      // Only one provided - error (they must match)
      throw new Error(
        'Both schemaName and logicalName must be provided together, or neither'
      );
    } else {
      // Auto-generate names from display name
      const nameResult = generateColumnName(
        params.displayName,
        params.columnType,
        prefix
      );
      logicalName = nameResult.logicalName;
      schemaName = nameResult.schemaName;
      appliedConventions = nameResult.appliedConventions;
      warnings = nameResult.warnings;
    }
    
    // STEP 2: Build attribute definition with validated names
    let attributeDefinition: any = {
      LogicalName: logicalName,
      SchemaName: schemaName,
      // ... rest of definition
    };
    
    // STEP 3: Create via API
    const result = await client.postMetadata(
      `EntityDefinitions(LogicalName='${params.entityLogicalName}')/Attributes`,
      attributeDefinition
    );
    
    // STEP 4: Return detailed response
    return {
      content: [{
        type: "text",
        text: `✓ Column created: '${displayName}'
        
Schema/Logical Name: ${schemaName}
Column Type: ${columnType}
Table: ${entityLogicalName}

Applied Conventions:
${appliedConventions.map(c => `• ${c}`).join('\n')}

${warnings.length > 0 ? `\nWarnings:\n${warnings.map(w => `⚠ ${w}`).join('\n')}` : ''}
        
Response: ${JSON.stringify(result, null, 2)}`
      }]
    };
  } catch (error) {
    // ... error handling
  }
}
```

---

### Phase 3: Update Related Tools

#### `updateColumnTool`
- If `displayName` is being updated, validate new naming conventions
- Warn if display name contradicts column type

#### `getColumnTool`
- Include naming convention information in output
- Show expected naming pattern for the column type
- Flag if column violates conventions

#### `listColumnsTool`
- Add `showNamingCompliance` optional parameter
- Show which columns follow vs. violate conventions
- Helpful for finding naming issues in existing schemas

---

## Example Workflow

### Scenario 1: Auto-Generated Names (Current + Desired)

**User input:**
```
Column type: Lookup
Display name: "Customer"
Prefix: "contoso_"
```

**Current output:**
```
Schema: contoso_customer
Logical: contoso_customer
❌ PROBLEM: Lookup is missing 'id' suffix!
```

**After refactoring:**
```
Schema: contoso_customerid
Logical: contoso_customerid
Applied conventions:
• Lookup column - added 'id' suffix
✓ Schema name follows Lookup convention
```

---

### Scenario 2: Boolean Column

**User input:**
```
Column type: Boolean
Display name: "Is Active"
Prefix: "contoso_"
```

**Current output:**
```
Schema: contoso_isactive
Logical: contoso_isactive
```

**After refactoring:**
```
Schema: contoso_isactive
Logical: contoso_isactive
Applied conventions:
• Boolean column - validated 'is' prefix present
✓ Schema name follows Boolean convention
```

---

### Scenario 3: Collision Prevention

**User input (DANGEROUS):**
```
Column type: Integer (NOT Lookup!)
Display name: "Department"
Prefix: "contoso_"
```

**Current output:**
```
Schema: contoso_department
✓ Created successfully
```

**Later, user creates:**
```
Column type: Lookup
Display name: "Department"  
Prefix: "contoso_"
```

**Result:**
```
❌ COLLISION ERROR: Cannot create lookup - schema name
   'contoso_departmentid' would create navigation property
   that conflicts with existing non-lookup column 'contoso_departmentid'
```

---

**After refactoring (BEFORE user mistakes):**

First column attempt:
```
Column type: Integer
Display name: "Department"
Prefix: "contoso_"

❌ ERROR: Schema name 'contoso_department' for an Integer column 
will collide with auto-generated navigation property from future 
Lookup columns. Use 'contoso_srcdepartment' or 'contoso_departmentsource' instead.
```

**Problem prevented!**

---

## File Structure

```
ddsol-dataverse-mcp/
├── src/
│   ├── utils/
│   │   └── column-naming.ts (NEW)
│   └── tools/
│       ├── column-tools.ts (MODIFIED)
│       └── ... (other tools)
├── REFACTORING_STRATEGY.md (this file)
└── ...
```

---

## Testing Strategy

Create test file: `test/test-column-naming.cjs`

```typescript
// Test cases:
// 1. Lookup auto-generation: "Customer" → "customerid" ✓
// 2. Picklist auto-generation: "Status Type" → "statustypecode" ✓
// 3. Boolean auto-generation: "Is Active" → "isactive" ✓
// 4. Collision detection: integer "Department" → error ✓
// 5. Override capability: explicit logicalName accepted ✓
// 6. Validation: Lookup without 'id' → error ✓
// 7. Warnings: DateTime without 'on' → warning (not error) ✓
```

---

## Migration Path

1. **Phase 1** (Low risk):
   - Create `column-naming.ts` utility module
   - Add comprehensive tests
   - Verify logic independently

2. **Phase 2** (Medium risk):
   - Update `createColumnTool` to use new naming module
   - Keep backward compatibility (auto-generation still works)
   - Enhanced response messages

3. **Phase 3** (Ongoing):
   - Update other tools (`update`, `get`, `list`)
   - Add naming compliance checks
   - Document conventions in tool descriptions

---

## Success Criteria

✅ All type-specific naming conventions are enforced  
✅ Collision rule prevents accidental schema conflicts  
✅ Agents receive clear guidance on why names are generated  
✅ Optional override capability for special cases  
✅ Warnings are distinct from errors (suggestions vs. blockers)  
✅ Schema name = Logical name (always identical)  
✅ All existing tests pass  
✅ New naming tests provide 100% coverage of conventions  

---

## References

- **Agent instructions**: `PowerBIPro-eu/.github-private/agents/dataverseCustomMCPAgent/instructions/dataverse-custom-mcp-reference.instructions.md`
- **Schema builder skill**: `PowerBIPro-eu/.github-private/agents/dataverseCustomMCPAgent/skills/dataverse-schema-builder/SKILL.md`
- **Current implementation**: `ddsol-dataverse-mcp/src/tools/column-tools.ts` lines 26-40
