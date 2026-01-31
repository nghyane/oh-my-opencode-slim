# Prompts Module Codemap

## 1. Responsibility

The `src/prompts/` module provides a **prompt loading and caching system** for the oh-my-opencode-slim agent orchestration framework.

**Core Responsibilities:**
- **Dynamic Prompt Loading**: Load system prompts from markdown files at runtime without requiring application rebuilds
- **Performance Optimization**: Implement in-memory caching to eliminate redundant file I/O operations
- **Prompt Organization**: Centralize management of agent-specific system prompts (orchestrator, explorer, librarian, oracle, fixer, designer)
- **Hot Reload Support**: Enable development workflow by allowing cache invalidation without server restarts

**Why This Module Exists:**
Separates prompt content from application logic, enabling non-developers to modify agent behaviors by editing markdown files. Prompts are treated as configuration, not code.

---

## 2. Design

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Public API                                │
│  loadPrompt(path) → Promise<string>                             │
│  getPrompt(path) → string                                       │
│  preloadAgentPrompts() → Promise<void>                          │
│  clearPromptCache() → void                                      │
│  Prompts { orchestrator, explorer, librarian, oracle, fixer, designer } │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Prompt Cache Layer                          │
│              Map<string, string> (path → content)               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Bun File I/O Layer                            │
│              Bun.file() with async text() reading               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    File System                                   │
│        src/prompts/agents/*.md (markdown prompt files)          │
└─────────────────────────────────────────────────────────────────┘
```

### Key Abstractions

| Component | Type | Purpose |
|-----------|------|---------|
| `promptCache` | `Map<string, string>` | LRU-style in-memory cache storing path-to-content mappings |
| `loadPrompt()` | Async Function | Primary loading entry point with cache-aside pattern |
| `getPrompt()` | Sync Function | Retrieves pre-loaded prompts; throws if not cached |
| `Prompts` | Object (Getters) | Type-safe convenience accessor for agent prompts |

### Patterns Employed

1. **Cache-Aside Pattern**: `loadPrompt()` checks cache before file access, populating cache on miss
2. **Fail-Fast Validation**: Synchronous getter throws descriptive errors if prompt not preloaded
3. **Parallel Preloading**: `preloadAgentPrompts()` uses `Promise.all()` for concurrent loading
4. **Module-Aware Path Resolution**: Uses `import.meta.url` + `node:path` for cross-platform paths

---

## 3. Flow

### Loading Flow (loadPrompt)

```
loadPrompt(path) called
       │
       ▼
┌──────────────────┐
│ Check promptCache│
│ Map for 'path'   │
└────────┬─────────┘
         │ Found
         ▼
    Return cached
    content
         │
    ┌────┴────┐
    │ Not Found│
    └────┬─────┘
         ▼
┌──────────────────┐
│ Resolve fullPath │
│ join(__dirname,  │
│ path)            │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ Check file.exists│
│ via Bun.file()   │
└────────┬─────────┘
         │ Not found
         ▼
    Throw Error:
    "Prompt file not found"
         │
    ┌────┴────┐
    │ Exists  │
    └────┬─────┘
         ▼
┌──────────────────┐
│ Read file.text() │
│ (async, Bun opt) │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ Store in cache   │
│ promptCache.set()│
└────────┬─────────┘
         ▼
    Return content
```

### Preloading Flow (preloadAgentPrompts)

```
preloadAgentPrompts() called
            │
            ▼
   ┌────────────────┐
   │ Define agents  │
   │ array: 6 paths │
   └───────┬────────┘
            ▼
   ┌────────────────┐
   │ Promise.all()  │
   │ loadPrompt()   │
   │ for all agents │
   └───────┬────────┘
            ▼
   ┌────────────────┐
   │ Parallel file  │
   │ reads + cache  │
   │ population     │
   └───────┬────────┘
            ▼
        Returns
        (void)
```

### Sync Retrieval Flow (Prompts getter)

```
Prompts.orchestrator accessed
            │
            ▼
   ┌────────────────┐
   │ getPrompt()    │
   │ 'agents/       │
   │  orchestrator.md│
   └───────┬────────┘
            ▼
   ┌────────────────┐
   │ Check cache    │
   │ promptCache    │
   └───────┬────────┘
            │ Found
            ▼
       Return string
            │
       ┌────┴────┐
       │Not Found│
       └────┬─────┘
            ▼
      Throw Error:
      "Prompt not loaded"
```

---

## 4. Integration

### Dependencies

| Dependency | Source | Usage |
|------------|--------|-------|
| `node:path` | Node.js stdlib | Path manipulation (`join`, `dirname`) |
| `node:url` | Node.js stdlib | `fileURLToPath` for module-relative paths |
| `Bun.file()` | Bun runtime | Zero-copy async file access with `text()` |

### Consumers

The `Prompts` object is imported by agent implementations to retrieve system prompts:

```typescript
// Hypothetical consumer in agent implementation
import { Prompts } from './prompts/index.js';

export class OrchestratorAgent {
  async execute(task: Task): Promise<Result> {
    const systemPrompt = Prompts.orchestrator;
    // Use prompt in LLM call...
  }
}
```

### File Structure (Expected)

```
src/prompts/
├── index.ts           # Core module (loader, cache, exports)
├── codemap.md         # This file
└── agents/
    ├── orchestrator.md  # Orchestrator agent system prompt
    ├── explorer.md      # Explorer agent system prompt
    ├── librarian.md     # Librarian agent system prompt
    ├── oracle.md        # Oracle agent system prompt
    ├── fixer.md         # Fixer agent system prompt
    └── designer.md      # Designer agent system prompt
```

### Hot Reload Integration

During development, calling `clearPromptCache()` followed by `preloadAgentPrompts()` refreshes all prompts without rebuilding:

```typescript
// Development HMR integration
if (process.env.DEV) {
  watchPrompts(() => {
    clearPromptCache();
    preloadAgentPrompts();
  });
}
```

---

## 5. Key Invariants

1. **Cache Coherence**: Once `loadPrompt()` succeeds for a path, subsequent calls return identical content until cache is cleared
2. **Sync Access Safety**: `getPrompt()` only succeeds if async `loadPrompt()` was previously called for that path
3. **Path Isolation**: All paths are resolved relative to `__dirname` (module directory), preventing path traversal vulnerabilities
4. **Bun Optimization**: File reads use Bun's native `file.text()` for optimal performance on Bun runtime
