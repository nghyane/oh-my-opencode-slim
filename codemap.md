# CodeMap: oh-my-opencode-slim

> Lightweight agent orchestration plugin for OpenCode - a slimmed-down fork of oh-my-opencode

---

## 1. Responsibility

**oh-my-opencode-slim** is a multi-agent orchestration plugin for OpenCode that coordinates a team of 6 specialized AI agents ("The Pantheon") to tackle complex software development tasks. The plugin enables:

- **Delegation**: Orchestrator agent delegates tasks to appropriate subagents
- **Background Execution**: Long-running tasks execute asynchronously without blocking the main session
- **Codebase Navigation**: Specialized agents for exploration, research, and implementation
- **Tool Integration**: LSP, grep, and AST-based code analysis tools
- **MCP Integration**: Web search, documentation lookup, and GitHub code search capabilities

### The Pantheon (6 Agents)

| Agent | Role | Responsibility |
|-------|------|----------------|
| **Orchestrator** | Master delegator | Strategic coordination, task decomposition, delegating to subagents |
| **Explorer** | Codebase reconnaissance | File search, code navigation, pattern discovery |
| **Oracle** | Strategic advisor | Debugging, architectural decisions, "debugger of last resort" |
| **Librarian** | External knowledge | Web search, documentation retrieval, Context7 lookup |
| **Designer** | UI/UX specialist | Visual implementation, user interface design |
| **Fixer** | Implementation specialist | Fast, focused code implementation |

---

## 2. Design

### Architecture Overview

```
oh-my-opencode-slim/
├── src/
│   ├── index.ts                    # Main plugin entry point
│   ├── cli/                        # CLI installer and management
│   │   ├── index.ts               # CLI entry point
│   │   ├── install.ts             # Installation logic
│   │   ├── config-manager.ts      # Configuration management
│   │   ├── skills.ts              # Skill permissions
│   │   └── custom-skills.ts       # Custom skill definitions
│   ├── agents/                     # Agent definitions and factories
│   │   ├── index.ts               # Agent factory functions
│   │   ├── orchestrator.ts        # Orchestrator agent (primary)
│   │   ├── explorer.ts            # Explorer agent
│   │   ├── oracle.ts              # Oracle agent
│   │   ├── librarian.ts           # Librarian agent
│   │   ├── designer.ts            # Designer agent
│   │   └── fixer.ts               # Fixer agent
│   ├── tools/                      # Tool implementations
│   │   ├── index.ts               # Tool exports
│   │   ├── grep/                  # Ripgrep-based search tool
│   │   ├── ast-grep/              # AST-based pattern search
│   │   ├── lsp/                   # Language server protocol tools
│   │   └── background.ts          # Background task execution tools
│   ├── mcp/                        # Model Context Protocol servers
│   │   ├── index.ts               # MCP factory
│   │   ├── websearch.ts           # Web search MCP
│   │   ├── context7.ts            # Documentation lookup MCP
│   │   └── grep-app.ts            # GitHub code search MCP
│   ├── background/                 # Background task management
│   │   ├── background-manager.ts  # Task lifecycle, queuing, state machine
│   │   ├── tmux-session-manager.ts # Tmux pane management
│   │   └── persistence.ts         # Task state persistence
│   ├── hooks/                      # Plugin lifecycle hooks
│   │   ├── auto-update-checker/   # Version checking
│   │   ├── phase-reminder/        # Workflow compliance reminders
│   │   └── post-read-nudge/       # Delegation encouragement
│   ├── config/                     # Configuration management
│   │   ├── schema.ts              # Zod schemas for config
│   │   ├── loader.ts              # Config file loading
│   │   └── agent-mcps.ts          # Agent-MCP mappings
│   ├── utils/                      # Utilities
│   │   ├── logger.ts              # Structured logging
│   │   ├── tmux.ts                # Tmux utilities
│   │   └── circuit-breaker.ts     # Circuit breaker pattern
│   └── skills/                     # Bundled skills
│       └── cartography/           # Repository mapping skill
└── dist/                           # Compiled output
```

### Key Patterns

#### Plugin Pattern
The plugin exports a default async function conforming to `@opencode-ai/plugin` type:

```typescript
const OhMyOpenCodeLite: Plugin = async (ctx) => {
  return {
    name: 'oh-my-opencode-slim',
    agent: agents,
    tool: { ...backgroundTools, grep, ast_grep_search, ...lspTools },
    mcp: mcps,
    config: (opencodeConfig) => { /* ... */ },
    event: (input) => { /* ... */ },
    'experimental.chat.messages.transform': phaseReminderHook[...],
    'tool.execute.after': postReadNudgeHook[...],
    'experimental.chat.system.transform': async (input, output) => { /* ... */ },
  };
};
```

#### Agent Factory Pattern
Agents are created via factory functions (`createOrchestratorAgent`, `createExplorerAgent`, etc.) that return `AgentDefinition` objects containing:
- `name`: Agent identifier
- `description`: Human-readable description
- `config`: SDK agent configuration (model, temperature, permissions)
- `system`: System prompt (optional override)

#### State Machine Pattern (Background Tasks)
`BackgroundTaskManager` implements a state machine with valid transitions:
```
pending -> starting -> running -> completed | failed | cancelled
```

Atomic transitions use version checking to prevent race conditions.

#### Resource Registry Pattern
`TaskResourceRegistry` provides centralized cleanup for:
- Timers (retry, idle debounce)
- Promise resolvers (completion waiting)
- Session mappings

---

## 3. Flow

### Plugin Initialization Flow

```
1. loadPluginConfig(ctx.directory)
   ├── Read ~/.config/opencode/oh-my-opencode-slim.json
   ├── Apply defaults for missing values
   └── Return PluginConfig

2. getAgentConfigs(config)
   ├── Create agents via createAgents(config)
   ├── Apply model/temperature overrides
   ├── Set default permissions (question: allow, skill presets)
   └── Return SDK-compatible agent config

3. Initialize managers
   ├── BackgroundTaskManager(ctx, tmuxConfig, config)
   ├── TmuxSessionManager(ctx, tmuxConfig)
   └── Hook initialization
       ├── createAutoUpdateCheckerHook(ctx, options)
       ├── createPhaseReminderHook()
       └── createPostReadNudgeHook()

4. Setup graceful shutdown
   ├── SIGINT/SIGTERM handlers
   ├── backgroundManager.pause()
   ├── backgroundManager.drain(timeout)
   ├── backgroundManager.saveState()
   └── Cleanup tmux, LSP, sessions

5. Return Plugin interface
   ├── name: 'oh-my-opencode-slim'
   ├── agent: Agent definitions
   ├── tool: grep, ast_grep, LSP, background tools
   ├── mcp: websearch, context7, grep_app
   ├── config: Merge configs, set default_agent='orchestrator'
   ├── event: Handle session.status, session.created
   └── experimental hooks
```

### Background Task Flow

```
1. User calls background_task(agent, prompt, description)
   └── Validate agent is a subagent (not orchestrator)

2. launch(opts): BackgroundTask
   ├── Generate task ID (bg_xxxxxxx)
   ├── Create task record (status: pending)
   ├── Add to parent session index
   └── Enqueue for background start

3. processQueue()
   ├── Check concurrency limit (default: 10)
   ├── If slot available: startTask(task)
   └── If queue full: wait for active task completion

4. startTask(task): Phase B (async)
   ├── Reserve start slot atomically
   ├── Create session with parentID
   ├── Transition to 'running' on success
   ├── Build system prompt with task constraints
   └── Send prompt to session

5. Session execution
   ├── Agent processes task independently
   ├── session.status events emitted
   └── User can continue main conversation

6. Completion detection
   ├── session.status: idle -> 500ms debounce
   ├── Extract last assistant message
   ├── Truncate if > max size (100KB)
   └── Transition to 'completed' or 'failed'

7. Notification
   ├── Format completion notice with task_id
   ├── Send to parent session (with retry)
   ├── Mark as pending retrieval
   └── background_output can retrieve result

8. Eviction
   ├── Track completed tasks (max: 100)
   ├── Oldest evicted on limit exceeded
   ├── Delete associated sessions
   └── Clear from memory indices
```

### Agent Delegation Flow

```
1. User sends message to Orchestrator
   └── Orchestrator analyzes request

2. Orchestrator decomposes task
   ├── Identifies subtasks requiring subagents
   ├── Determines best agent for each subtask
   └── Sends delegation prompt

3. Subagent execution (Explorer, Librarian, etc.)
   ├── Receives specific task context
   ├── Uses allowed tools and MCPs
   └── Returns result to Orchestrator

4. Orchestrator synthesizes results
   ├── Combines subagent outputs
   ├── Resolves any conflicts
   └── Presents unified response to user

5. Optional: Background delegation
   ├── background_task(agent, prompt)
   └── Runs subagent in isolated session
```

---

## 4. Integration

### Dependencies

| Dependency | Purpose | Version |
|------------|---------|---------|
| `@opencode-ai/sdk` | OpenCode plugin SDK types | ^1.1.19 |
| `@opencode-ai/plugin` | Plugin interface types | ^1.1.19 |
| `@modelcontextprotocol/sdk` | MCP protocol implementation | ^1.25.1 |
| `zod` | Runtime validation | ^4.1.8 |
| `vscode-jsonrpc` | JSON-RPC protocol | ^8.2.0 |
| `vscode-languageserver-protocol` | LSP protocol types | ^3.17.5 |
| `@ast-grep/cli` | AST-based search (CLI downloader) | ^0.40.0 |

### OpenCode Plugin Integration

The plugin integrates with OpenCode through the `Plugin` interface:

**1. Agent Configuration**
```typescript
// Set orchestrator as default agent
(opencodeConfig as { default_agent?: string }).default_agent = 'orchestrator';

// Merge agent configs with permissions
opencodeConfig.agent = { ...agents };
```

**2. Tool Registration**
```typescript
tool: {
  // Background task tools
  background_task: background_taskTool,
  background_cancel: background_cancelTool,
  background_output: background_outputTool,
  background_list: background_listTool,

  // Code search tools
  grep: grepTool,
  ast_grep_search: ast_grep_searchTool,
  ast_grep_replace: ast_grep_replaceTool,

  // LSP tools
  lsp_goto_definition: lsp_goto_definitionTool,
  lsp_find_references: lsp_find_referencesTool,
  lsp_diagnostics: lsp_diagnosticsTool,
  lsp_rename: lsp_renameTool,
}
```

**3. MCP Integration**
```typescript
mcp: {
  websearch: { command: 'stdio', args: ['npx', '-y', ...] },
  context7: { /* Context7 MCP config */ },
  grep_app: { /* Grep.app MCP config */ },
}
```

**4. Event Handling**
```typescript
event: async (input) => {
  // session.created: Spawn tmux pane for Task sessions
  // session.status: Track background task completion
  // Handle auto-update checking events
}
```

**5. Experimental Hooks**
```typescript
// Transform chat messages to inject phase reminders
'experimental.chat.messages.transform': phaseReminderHook[...],

// Nudge after file reads to encourage delegation
'tool.execute.after': postReadNudgeHook[...],

// Inject background task status into system prompt
'experimental.chat.system.transform': async (input, output) => {
  // Append <BackgroundTasks> section with running/pending tasks
}
```

### Configuration File

**Location**: `~/.config/opencode/oh-my-opencode-slim.json`

```typescript
{
  // Preset selection
  preset?: string,
  presets?: {
    [presetName]: {
      agents?: {
        [agentName]: {
          model?: string,      // e.g., "openai/gpt-4o"
          temperature?: number, // 0.0 - 2.0
          skills?: string[],   // ["cartography", "read"]
          mcps?: string[],     // ["websearch", "context7"]
        }
      }
    }
  },

  // Agent overrides (if not using presets)
  agents?: Record<AgentName, AgentOverrideConfig>,

  // Disabled MCPs
  disabled_mcps?: string[],

  // Tmux configuration
  tmux?: {
    enabled?: boolean,
    layout?: 'main-vertical' | 'main-horizontal' | 'tiled',
    main_pane_size?: number, // percentage
  },

  // Background task configuration
  background?: {
    maxConcurrentStarts?: number, // default: 10
    maxCompletedTasks?: number,   // default: 100
  }
}
```

### MCP Tool Permissions

Each agent has configured MCP permissions via the `config()` function:

| Agent | Allowed MCPs |
|-------|-------------|
| Orchestrator | All (delegation hub) |
| Explorer | grep_app (code search) |
| Oracle | All (debugging resource) |
| Librarian | websearch, context7 |
| Designer | grep_app (UI patterns) |
| Fixer | grep_app (code search) |

### Tmux Integration

When `tmux.enabled` is true:
1. `TmuxSessionManager` listens for `session.created` events
2. Spawns a tmux pane for each session
3. Displays session output in real-time
4. Layout configurable (main-vertical, tiled, etc.)
5. Panes automatically cleaned up on session end

### CLI Commands

```bash
# Install plugin
bunx oh-my-opencode-slim install

# Options
--kimi=yes|no         # Enable Kimi API
--openai=yes|no       # Enable OpenAI API
--tmux=yes|no         # Enable tmux integration
--no-tui              # Non-interactive mode
```

---

## 5. File Reference

### Critical Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main plugin export and initialization |
| `src/agents/index.ts` | Agent factory and configuration |
| `src/background/background-manager.ts` | Background task lifecycle management |
| `src/config/schema.ts` | Zod validation schemas |

### Tool Implementations

| Module | Tools Provided |
|--------|---------------|
| `src/tools/grep/` | `grep` - Text content search (ripgrep-based) |
| `src/tools/ast-grep/` | `ast_grep_search`, `ast_grep_replace` - AST pattern matching |
| `src/tools/lsp/` | `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, `lsp_rename` |
| `src/tools/background.ts` | `background_task`, `background_output`, `background_cancel`, `background_list` |

### MCP Servers

| MCP | Purpose |
|-----|---------|
| `websearch` | Web search via Exa API |
| `context7` | Technical documentation lookup |
| `grep_app` | GitHub code search |

---

## 6. Development

### Build Commands

```bash
bun run build       # Compile TypeScript to dist/ (both index.ts and cli/index.ts)
bun run typecheck   # TypeScript type checking
bun run test        # Run all tests
bun run lint        # Biome linter
bun run format      # Biome formatter
bun run check       # Biome check with auto-fix
bun run dev         # Build and run with OpenCode
```

### Code Style

- **Formatter**: Biome (configured in `biome.json`)
- **Line width**: 80 characters
- **Indentation**: 2 spaces
- **Quotes**: Single quotes
- **Trailing commas**: Always enabled

### Testing

Tests are located alongside implementation files with `.test.ts` extension:
- `src/agents/index.test.ts`
- `src/background/background-manager.test.ts`
- `src/tools/grep/grep.test.ts`

Run tests: `bun test`

---

## 7. Skills (Bundled)

### Cartography Skill

**Location**: `src/skills/cartography/`

A custom skill for repository mapping and codemap generation. Includes:
- `SKILL.md`: Skill definition and usage
- `scripts/cartographer.py`: Python implementation for codebase analysis

The skill enables agents to generate comprehensive documentation of project structure, dependencies, and architecture.
