---
name: cartography
description: Repository understanding and hierarchical codemap generation
---

# Cartography Skill

Map repositories by creating hierarchical codemaps using parallel explorer agents.

## When to Use

- User asks to understand/map a repository
- Starting work on an unfamiliar codebase
- Before complex refactors

## Quick Start

```bash
# 1. Check if state exists
ls .slim/cartography.json

# 2. If not exists, initialize
python3 ~/.config/opencode/skills/cartography/scripts/cartographer.py init \
  --root ./ --include "src/**/*.ts" --exclude "**/*.test.ts"

# 3. Check changes
python3 ~/.config/opencode/skills/cartography/scripts/cartographer.py changes --root ./

# 4. After updating codemaps, save state
python3 ~/.config/opencode/skills/cartography/scripts/cartographer.py update --root ./
```

## Workflow

### Step 1: Check State

```bash
ls .slim/cartography.json 2>/dev/null && echo "exists" || echo "missing"
```

- **Exists** → Go to Step 3 (Detect Changes)
- **Missing** → Go to Step 2 (Initialize)

### Step 2: Initialize (First Time Only)

```bash
python3 ~/.config/opencode/skills/cartography/scripts/cartographer.py init \
  --root ./ \
  --include "src/**/*.ts" \
  --exclude "**/*.test.ts" --exclude "dist/**"
```

This creates `.slim/cartography.json` and empty `codemap.md` files.

### Step 3: Detect Changes

```bash
python3 ~/.config/opencode/skills/cartography/scripts/cartographer.py changes --root ./
```

Output shows:
- Added/removed/modified files
- **Affected folders** (use these for parallel tasks)

### Step 4: Spawn Parallel Explorers

For each affected folder, launch a background task:

```javascript
// Get affected folders from 'changes' output
const affectedFolders = ["src/agents", "src/tools", "src/config"];

// Launch all in parallel
const tasks = affectedFolders.map(folder => 
  background_task({
    agent: "explorer",
    description: `Map ${folder}/`,
    prompt: `Update codemap for ${folder}/. Read all source files and write a comprehensive codemap.md covering: Responsibility, Design patterns, Data flow, Integration points.`
  })
);
```

### Step 5: Retrieve Results

System sends notification when done:
```
✓ Task bg_abc123de completed. Retrieve with: background_output task_id="bg_abc123de"
```

⚠️ **ONLY call after receiving notification** (throws error if before)

```javascript
const results = [
  background_output({ task_id: "bg_abc123de" }),
  background_output({ task_id: "bg_def456gh" }),
];
```

### Step 6: Update State

```bash
python3 ~/.config/opencode/skills/cartography/scripts/cartographer.py update --root ./
```

## Codemap Format

Each `codemap.md` should have 4 sections:

```markdown
# src/feature/

## Responsibility
What this folder does (e.g., "Service Layer for user authentication")

## Design
Key patterns: Factory, Observer, etc. Key abstractions and interfaces.

## Flow
How data enters, transforms, and exits. Function call sequences.

## Integration
Dependencies (imports) and consumers (who uses this).
```

## Root Codemap (Atlas)

After sub-folders are mapped, create/update root `codemap.md`:

```markdown
# Repository Atlas: project-name

## Overview
One-line description of the project.

## Entry Points
- `src/index.ts`: Main entry
- `package.json`: Dependencies

## Directory Map
| Directory | Responsibility | Map |
|-----------|---------------|-----|
| `src/agents/` | Agent orchestration | [View](src/agents/codemap.md) |
| `src/tools/` | Tool implementations | [View](src/tools/codemap.md) |
```
