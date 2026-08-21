# Column Naming Refactoring Strategy (Agent-Side)

## Executive Summary

**Move naming logic entirely to the agent layer.** The MCP becomes a pure data-plane tool that:

1. **Accepts explicit `schemaName` and `logicalName`** from the agent (both required)
2. **Validates only invariants** (schema == logical, collision rule)
3. **Creates the column** without generating or suggesting names
4. **Enforces non-negotiable truths**: schema name = logical name, every column has solution membership

**Why this approach?**
- Agent has access to flexible skill instructions with naming conventions
- Naming conventions are documented once (in `dataverse-schema-builder` skill)
- MCP stays lightweight, pure data-access tool
- Different agents can use different naming strategies without MCP changes
- Separation of concerns: Business logic (agent) ↔ Data plane (MCP)

---

## Architecture

### Current State (Problem)
```
Agent → MCP.createColumnTool(displayName: "Customer", type: "Lookup")
           ↓
         MCP.generateColumnLogicalName() [simplistic logic]
           ↓
         MCP creates schema_name = "customer" ❌ WRONG
```

### Target State (Solution)
```
Agent (via dataverse-schema-builder skill):
  1. Reads naming conventions from skill instructions
  2. Applies type-specific logic ("Lookup" → append "id")
  3. Generates schemaName = "customerid"
  4. Validates against collision rule
  5. Passes to MCP
           ↓
         MCP.createColumnTool(
           displayName: "Customer",
           type: "Lookup",
           schemaName: "customerid",
           logicalName: "customerid"
         )
           ↓
         MCP validates invariants only:
           • schemaName == logicalName? ✓
           • Collision rule satisfied? ✓
           ↓
         MCP creates column ✓
```

---

## Type-Specific Naming Conventions (Agent Responsibility)

The agent applies these rules from its skill instructions:

| Column Type | Convention | Example Display | Example Schema |
|---|---|---|---|
| **Lookup** | MUST end with `id` | `Customer` | `customerid` |
| **Picklist/Choice** | Must end with `code` | `Status Type` | `statustypecode` |
| **Boolean** | Must start with `is` | `Is Active` | `isactive` |
| **Date (Either Type)** | May end with `date` or `on` — user choice | `Effective Date` | `effectivedate` or `effectiveon` |
| **AutoNumber** | Should end with `no` | `Invoice #` | `invoiceno` |
| **Formula** | Should start with `fx` | `Total Amount` | `fxtotalamount` |

---

## Critical Collision Rule (Validated by MCP)

**The Problem:**
When you create a Lookup column, Dataverse **automatically generates a navigation property** ending in `Id`:

```
If you create lookup "customerid"
  → Dataverse auto-generates navigation property: "CustomerID"
  
If you pre-created a non-lookup column named "CustomerID" (e.g., integer)
  → COLLISION! Lookup creation fails.
```

**The Rule:**
- ❌ **NEVER** name a NON-LOOKUP column ending with `Id` (capital I, lowercase d)
  - `contoso_DepartmentId` (integer) → collision with lookup navigation property
- ✅ **ALWAYS** name LOOKUP columns ending with `id` (lowercase)
  - `contoso_departmentid` ← lowercase in schema name

**Implementation (MCP-side):**
- Before creating column, check if `schemaName` ends with `Id` AND column type is NOT Lookup
- If true, reject with clear error message

---

## Changes to MCP

### 1. Remove Auto-Generation Functions

Delete these functions from `src/tools/column-tools.ts`:
```typescript
// ❌ DELETE: generateColumnLogicalName()
// ❌ DELETE: generateColumnSchemaName()
```

These functions will not exist. All naming happens in the agent skill.

---

### 2. Update `createColumnTool` Input Schema

```typescript
inputSchema: {
  entityLogicalName: z.string()
    .describe("Logical name of the table (e.g., 'account')"),
  displayName: z.string()
    .describe("User-visible column name (e.g., 'Customer')"),
  columnType: z.enum([...all types...])
    .describe("Column type (Lookup, Choice, Boolean, etc.)"),
  
  // ✅ NEW: Agent must provide these
  schemaName: z.string()
    .describe("Schema/logical name for the column (e.g., 'customerid'). Must follow naming conventions."),
  logicalName: z.string()
    .describe("Logical name (must be identical to schemaName)."),
  
  // ... other optional parameters (description, requiredLevel, etc.)
}
```

**Key change:** `schemaName` and `logicalName` are **REQUIRED** (not optional).

---

### 3. Update `createColumnTool` Handler

```typescript
async (params) => {
  try {
    // Step 1: Validate invariants
    // ============================================
    
    // Rule: Schema name = Logical name
    if (params.schemaName !== params.logicalName) {
      throw new Error(
        `Schema name and logical name must be identical.\n` +
        `Provided: schemaName='${params.schemaName}', logicalName='${params.logicalName}'`
      );
    }
    
    // Rule: Collision check
    // Non-lookup columns CANNOT end with 'Id' (capital I, lowercase d)
    if (params.columnType !== 'Lookup' && 
        params.schemaName.endsWith('Id')) {
      throw new Error(
        `Collision rule violation:\n` +
        `Non-lookup column '${params.schemaName}' cannot end with 'Id'.\n` +
        `This would collide with auto-generated navigation property from future Lookup columns.\n\n` +
        `Suggestion: Rename to something like:\n` +
        `  • ${params.schemaName.slice(0, -2)}Value\n` +
        `  • Source${params.schemaName.slice(0, -2)}\n` +
        `  • ${params.schemaName.slice(0, -2)}Source`
      );
    }
    
    // Step 2: Build attribute definition
    // ============================================
    const attributeDefinition: any = {
      LogicalName: params.logicalName,
      SchemaName: params.schemaName,
      DisplayName: { LocalizedLabels: [createLocalizedLabel(params.displayName)] },
      Description: params.description ? 
        { LocalizedLabels: [createLocalizedLabel(params.description)] } : 
        undefined,
      // ... rest of attribute definition based on columnType
    };
    
    // Step 3: Ensure solution context is set
    // ============================================
    const solutionContext = client.getSolutionContext();
    if (!solutionContext) {
      throw new Error(
        'Solution context not set. Call set_solution_context first.\n' +
        'This ensures all metadata is added to the intended solution.'
      );
    }
    
    // Step 4: Create via API
    // ============================================
    const result = await client.postMetadata(
      `EntityDefinitions(LogicalName='${params.entityLogicalName}')/Attributes`,
      attributeDefinition
    );
    
    // Step 5: Return success response
    // ============================================
    return {
      content: [{
        type: "text",
        text: `✓ Column created successfully

Display Name: ${params.displayName}
Schema Name: ${params.schemaName}
Column Type: ${params.columnType}
Table: ${params.entityLogicalName}

Schema/Logical Name Details:
  • Schema: ${params.schemaName}
  • Logical: ${params.logicalName}
  • Solution: ${solutionContext.solutionUniqueName}
  
${params.description ? `Description: ${params.description}` : ''}
        
API Response: ${JSON.stringify(result, null, 2)}`
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `✗ Failed to create column\n\n${error.message}`
      }],
      isError: true
    };
  }
}
```

---

### 4. Update `getColumnTool` Response

Include naming convention information:

```typescript
async (params) => {
  const column = await client.getMetadata(...);
  
  const conventions = inferNamingConventions(column.LogicalName, column.AttributeType);
  
  return {
    content: [{
      type: "text",
      text: `Column: ${column.DisplayName}
Schema Name: ${column.SchemaName}
Logical Name: ${column.LogicalName}
Type: ${column.AttributeType}

Naming Convention Check:
${conventions.isCompliant ? '✓ Follows conventions' : '⚠ Violates conventions'}
${conventions.issues.map(i => `  • ${i}`).join('\n')}

${column.Description ? `\nDescription: ${column.Description}` : ''}
${column.IsPrimaryKey ? `\n⭐ Primary Key Column` : ''}
${column.IsLookup ? `\n🔗 Lookup to: ${column.Targets}` : ''}`
    }]
  };
}

function inferNamingConventions(schemaName: string, attributeType: string) {
  const issues: string[] = [];
  
  if (attributeType === 'Lookup' && !schemaName.endsWith('id')) {
    issues.push(`Lookup column should end with 'id' suffix`);
  }
  if (attributeType === 'Picklist' && !schemaName.endsWith('code')) {
    issues.push(`Picklist should end with 'code' suffix`);
  }
  if (attributeType === 'Boolean' && !schemaName.startsWith('is')) {
    issues.push(`Boolean column should start with 'is' prefix`);
  }
  if (attributeType !== 'Lookup' && schemaName.endsWith('Id')) {
    issues.push(`⚠️ COLLISION RISK: Non-lookup ending with 'Id' may conflict with lookup navigation properties`);
  }
  
  return {
    isCompliant: issues.length === 0,
    issues
  };
}
```

---

### 5. No Changes to Other Tools

- `updateColumnTool`: Works as-is (updates display name, description, required level, etc.)
- `deleteColumnTool`: Works as-is
- `listColumnsTool`: Works as-is (optionally add convention compliance display)

---

## Changes to Agent Skill

The `dataverse-schema-builder` skill gains responsibility for naming logic.

### New Skill Workflow

1. **Read user requirement**: "Create a Lookup column called 'Customer'"
2. **Parse column type**: "Lookup" → Must end with `id`
3. **Apply convention**: "Customer" + "id" → "customerid"
4. **Validate collision rule**: "customerid" is Lookup ✓, no collision risk
5. **Call MCP with explicit names**:
   ```
   create_dataverse_column(
     entityLogicalName: "account",
     displayName: "Customer",
     columnType: "Lookup",
     schemaName: "customerid",
     logicalName: "customerid",
     ...
   )
   ```

### Skill Content to Add

In `dataverse-schema-builder/SKILL.md`, add new section:

```markdown
## Naming Convention Application (Agent Responsibility)

### Lookup Columns
```
User input: "Create Lookup column 'Customer'"
  1. Type is Lookup → append 'id'
  2. Apply prefix: 'prefix_'
  3. Lowercase: "customerid"
  4. Full: "prefix_customerid"
  5. Pass to MCP:
     schemaName: "prefix_customerid"
     logicalName: "prefix_customerid"
```

### Picklist/Choice Columns
```
User input: "Create Choice column 'Status Type'"
  1. Type is Choice → append 'code'
  2. Apply prefix: 'prefix_'
  3. Lowercase: "statustypecode"
  4. Full: "prefix_statustypecode"
```

### Boolean Columns
```
User input: "Create Boolean column 'Is Active'"
  1. Type is Boolean → prepend 'is' if not present
  2. Check if already starts with 'is': "Is Active" → "is active"
  3. Apply prefix: 'prefix_'
  4. Lowercase: "isactive"
  5. Full: "prefix_isactive"
```

### Date Columns (User Choice)
```
User input: "Create Date column 'Effective Date'"
  1. Type is Date → offer choice to user or accept preference
  2. Option A: "effective" + "date" → "effectivedate"
  3. Option B: "effective" + "on" → "effectiveon"
  4. Apply prefix: 'prefix_'
  5. Full: "prefix_effectivedate" OR "prefix_effectiveon"
```
```

---

## Example Workflows

### Scenario 1: Lookup Column

**Agent implementation:**
```python
# From skill instruction/agent logic
def create_lookup_column(entity, display_name):
    schema_name = f"{prefix}_{display_name.lower().replace(' ', '')}id"
    logical_name = schema_name  # Must be identical
    
    # Validate collision rule (non-lookup can't end with 'Id')
    assert not schema_name.endswith('Id'), "Collision risk!"
    
    return mcp_client.create_dataverse_column(
        entityLogicalName=entity,
        displayName=display_name,
        columnType='Lookup',
        schemaName=schema_name,
        logicalName=logical_name
    )

# Usage:
create_lookup_column('account', 'Customer')
# → schemaName = "contoso_customerid"
# → MCP creates column ✓
```

---

### Scenario 2: Collision Prevention

**Agent implementation (collision check BEFORE calling MCP):**
```python
def create_column(entity, display_name, column_type):
    schema_name = generate_schema_name(display_name, column_type)
    logical_name = schema_name
    
    # Agent checks collision rule BEFORE calling MCP
    if column_type != 'Lookup' and schema_name.endswith('Id'):
        raise ValueError(
            f"Cannot create {column_type} column with schema '{schema_name}'.\n"
            f"Ends with 'Id' but not a Lookup → collision risk.\n"
            f"Suggestions:\n"
            f"  • {schema_name[:-2]}Source\n"
            f"  • Source{schema_name[:-2]}\n"
            f"  • {schema_name[:-2]}Value"
        )
    
    return mcp_client.create_dataverse_column(
        entityLogicalName=entity,
        displayName=display_name,
        columnType=column_type,
        schemaName=schema_name,
        logicalName=logical_name
    )

# Usage:
create_column('account', 'Department', 'Integer')
# → Agent generates: schema_name = "contoso_department"
# → Agent checks: "department" doesn't end with 'Id' ✓
# → MCP creates ✓

# Later, if another agent tries:
create_column('account', 'Department', 'Lookup')
# → Agent generates: schema_name = "contoso_departmentid"
# → MCP creates with navigation property "DepartmentID"
# → No collision! ✓ (because first column is "department", not "departmentId")
```

---

## Testing Strategy

### Agent-Side Testing (Skill Implementation)
- ✅ Lookup: "Customer" → "customerid"
- ✅ Choice: "Status Type" → "statustypecode"
- ✅ Boolean: "Active" → "isactive"
- ✅ Date: "Effective Date" → "effectivedate" or "effectiveon"
- ✅ Collision prevention: Integer "Department" → caught before MCP call

### MCP-Side Testing (Validation Only)
- ✅ Rejects if schemaName ≠ logicalName
- ✅ Rejects non-lookup with 'Id' suffix
- ✅ Accepts valid names from agent
- ✅ Creates column with explicit names provided

---

## Implementation Phases

### Phase 1: Update MCP (Reduce Complexity)
- **Time**: 1-2 hours
- **Changes**:
  - Remove `generateColumnLogicalName()` function
  - Remove `generateColumnSchemaName()` function
  - Update `createColumnTool` to require `schemaName` and `logicalName`
  - Add collision rule validation
  - Update error messages
- **Risk**: Low (API surface changes, but agents adapt)

### Phase 2: Implement Naming Logic in Skill
- **Time**: 2-3 hours
- **Changes**:
  - Update `dataverse-schema-builder/SKILL.md` with naming workflow
  - Add agent-side naming function examples
  - Document collision rule application
  - Add decision logic for Date columns (date vs. on)
- **Risk**: Low (documentation/guidance update)

### Phase 3: Deploy and Validate
- **Time**: 1 hour
- **Changes**:
  - Update released MCP version
  - Test agent skill with new MCP
  - Verify naming conventions applied correctly
- **Risk**: Medium (coordination with agents using MCP)

---

## Success Criteria

✅ MCP accepts only explicit `schemaName` and `logicalName` (both required)  
✅ MCP validates: schemaName == logicalName  
✅ MCP prevents non-lookup columns from ending with 'Id'  
✅ Agent skill documents naming convention logic clearly  
✅ Naming logic is NOT in MCP code (fully delegated to agent)  
✅ Agents can easily adapt naming strategy by modifying skill  
✅ All column types follow their conventions  
✅ Collision rule is enforced before MCP call  

---

## Deployment Notes

1. **Breaking change**: Agents must pass explicit `schemaName`/`logicalName`
2. **Migration**: Update agent skills to apply naming logic
3. **Documentation**: Update MCP README to explain agent responsibility
4. **Versioning**: Bump minor version (naming logic relocation is significant)

---

## References

- **Agent instructions**: `PowerBIPro-eu/.github-private/agents/dataverseCustomMCPAgent/instructions/`
- **Schema builder skill**: `PowerBIPro-eu/.github-private/agents/dataverseCustomMCPAgent/skills/dataverse-schema-builder/SKILL.md`
- **Current implementation**: `ddsol-dataverse-mcp/src/tools/column-tools.ts`
- **MCP repository**: `mwhesse/dataverse-mcp` branch `DDSol-Customization`
