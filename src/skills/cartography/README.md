# Cartography Skill

Repository mapping and change detection for hierarchical codemaps.

## Purpose

- Map codebase structure with `codemap.md` files
- Detect which folders changed (for selective updates)
- Support parallel explorer agents via background tasks

## Commands

```bash
# Initialize (first time only)
python3 cartographer.py init \
  --root /repo \
  --include "src/**/*.ts" \
  --exclude "**/*.test.ts" \
  --exclude "dist/**" \
  --exception "src/important/config.ts"

# Check changes
python3 cartographer.py changes --root /repo

# Save new state
python3 cartographer.py update --root /repo
```

## Files

- `.slim/cartography.json` - File/folder hashes for change detection
- `codemap.md` - Human-readable architecture docs in each folder

## Workflow with Background Tasks

1. Run `changes` to see affected folders
2. Spawn `background_task` for each affected folder
3. System notifies: `✓ Task bg_abc123de completed...`
4. Retrieve results with `background_output`
5. Run `update` to save new state
