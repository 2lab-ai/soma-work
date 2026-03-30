# /save - Save Work Context

## Task

Save the current work context to the user's working directory at `.claude/omc/tasks/save/{id}` where `{id}` is a timestamp-based ID.


## Steps

1. Generate ID from current timestamp: `!date '+%Y%m%d_%H%M%S'`
2. Create the save directory in the current working directory: `.claude/omc/tasks/save/{generated_id}/`

3. **Check for previously loaded save in this session**:
   - If a save was loaded earlier (via `/load`), note its ID
   - Ensure it's archived: check `.claude/omc/tasks/archives/{loaded_id}/context.md`
   - If the loaded save is still in `.claude/omc/tasks/save/`, move it to archives first
   - Read the loaded save's `context.md` to extract its "Previous Context History" if any

4. Create `context.md` file with the following sections:

### context.md Structure

```markdown
# Work Context Save
- **ID**: {generated_id}
- **Date**: {current datetime}
- **Branch**: {current git branch}

## Previous Context History
{List of previously linked saves in chronological order. If this is the first save, write "(First save - no previous context)"}
{If there was a loaded save, add a new line:}
- `{loaded_id}` - {loaded_save_summary} → `.claude/omc/tasks/archives/{loaded_id}/context.md`
{Copy any existing history lines from the loaded save's "Previous Context History" section ABOVE the new entry}

## Summary
{Brief 1-2 sentence description of current work}

## Current Plan
{Copy the current plan from conversation if available}

## In Progress Tasks
{List tasks currently being worked on}

## Completed Tasks
{List tasks that have been completed in this session}

## Pending Tasks
{List tasks that still need to be done}

## Key Context
{Important files, decisions, or context needed to continue}

## Files Modified
{List of files created or modified in this session}

## Notes
{Any additional notes or considerations}
```

### Previous Context History Format

The history section accumulates with each save/load cycle:

**First save (no prior load):**
```markdown
## Previous Context History
(First save - no previous context)
```

**After loading save `20250126_100000` and saving again:**
```markdown
## Previous Context History
- `20250126_100000` - Initial feature implementation → `.claude/omc/tasks/archives/20250126_100000/context.md`
```

**After loading save `20250126_120000` (which had its own history) and saving again:**
```markdown
## Previous Context History
- `20250126_100000` - Initial feature implementation → `.claude/omc/tasks/archives/20250126_100000/context.md`
- `20250126_120000` - Added unit tests → `.claude/omc/tasks/archives/20250126_120000/context.md`
```

5. If there are specific plan files (e.g., in `./docs/agent_tasks/`), reference or copy relevant content.

6. **Save additional files if needed**:
   - Code snippets that are critical to continue
   - Config files or patches
   - Any file content that's essential for resumption
   - Save them in the same directory: `.claude/omc/tasks/save/{generated_id}/`

7. **MUST output structured JSON result** at the very end.

### JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["save_result"],
  "properties": {
    "save_result": {
      "type": "object",
      "required": ["success"],
      "properties": {
        "success": { "type": "boolean" },
        "id": { "type": "string", "description": "Save ID (timestamp-based)" },
        "dir": { "type": "string", "description": "Save directory path" },
        "summary": { "type": "string", "description": "Brief 1-line summary" },
        "files": {
          "type": "array",
          "description": "List of saved files",
          "items": {
            "type": "object",
            "required": ["name", "content"],
            "properties": {
              "name": { "type": "string", "description": "Filename" },
              "content": { "type": "string", "description": "File content" }
            }
          }
        },
        "error": { "type": "string", "description": "Error message if failed" }
      }
    }
  }
}
```

### Success Output Format

```json
{"save_result":{"success":true,"id":"20250128_170000","dir":".claude/omc/tasks/save/20250128_170000","summary":"PR review feedback implementation","files":[{"name":"context.md","content":"# Work Context Save\n...full content..."},{"name":"patch.diff","content":"diff content if any"}]}}
```

### Failure Output Format

```json
{"save_result":{"success":false,"error":"Failed to create directory"}}
```

**CRITICAL**:
- Always validate your JSON output against the schema before outputting
- The `files` array MUST include at least `context.md` with its full content
- Output the JSON on a SINGLE LINE (no line breaks within JSON)

## Important

- Capture ALL relevant context needed to resume work
- Include specific file paths with line numbers when relevant
- Include any error messages or blockers encountered
- Be thorough - the goal is to enable seamless work resumption
- **Always preserve the Previous Context History chain** - this enables tracing back through the entire work history
- **CRITICAL**: Always output the JSON result block at the end - this is required for automation
- **CRITICAL**: Validate JSON against schema before output
