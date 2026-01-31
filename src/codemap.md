# Code Map: oh-my-opencode-slim

## Responsibility

**oh-my-opencode-slim** is a lightweight OpenCode plugin that provides AI-powered coding assistance through agent orchestration, code analysis tools, and external service integrations.

### Core Responsibilities

1. **Agent Orchestration**
   - Central orchestrator agent (`orchestrator`) that delegates tasks to specialist subagents
   - 5 specialized subagents: `explorer` (code search), `librarian` (documentation), `oracle` (reasoning), `designer` (UI/code generation), `fixer` (debugging)
   - Agent configuration with model overrides, temperature settings, and skill permissions
   - Agent prompts loaded dynamically from markdown files

2. **Code Analysis Tools**
   - **grep**: Ripgrep-based content search with regex support
   - **ast-grep**: AST-aware pattern matching and replacement for 25+ languages
   - **LSP Tools**: `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, `lsp_rename` using Language Server Protocol
   - Tools managed via connection pooling for LSP servers

3. **MCP (Model Context Protocol) Integrations**
   - **websearch**: Exa AI web search for real-time information
   - **context7**: Official documentation lookup for libraries
   - **grep-app**: GitHub code search via grep.app
   - Remote MCP servers with optional API key authentication

4. **Background Task Management**
   - Fire-and-forget task execution in isolated sessions
   - Task queuing with configurable concurrency limits
   - Session lifecycle management (creation, completion, cleanup)
   - Task state persistence for crash recovery
   - Orphaned task detection and cleanup

5. **Tmux Integration**
   - Spawns tmux panes for subagent sessions
   - Pane management with automatic cleanup on completion
   - Layout configuration (main-vertical, main-horizontal, tiled, etc.)

6. **CLI Installation Tool**
   - Interactive or non-interactive plugin installation
   - OpenCode config modification
   - Recommended skill installation
   - Custom skill setup

7. **Workflow Hooks**
   - Auto-update checker with toast notifications
   - Phase reminder for workflow compliance
   - Post-read nudge to encourage delegation

## Design

### Module Structure

```
src/
├── index.ts                 # Main plugin entry point
├── cli/                     # CLI installation tool
│   ├── index.ts             # CLI entry (install command)
│   ├── install.ts           # Installation flow orchestration
│   ├── config-manager.ts    # OpenCode config file management
│   ├── config-io.ts         # Config read/write operations
│   ├── skills.ts            # Recommended skills installation
│   ├── custom-skills.ts     # Custom skill setup
│   ├── system.ts            # System detection
│   ├── providers.ts         # Provider configuration
│   ├── paths.ts             # Path utilities
│   └── types.ts             # TypeScript types
├── agents/                  # Agent definitions and factories
│   ├── index.ts             # Agent creation and configuration
│   ├── orchestrator.ts      # Orchestrator agent factory
│   ├── explorer.ts          # Explorer agent factory
│   ├── librarian.ts         # Librarian agent factory
│   ├── oracle.ts            # Oracle agent factory
│   ├── designer.ts          # Designer agent factory
│   ├── fixer.ts             # Fixer agent factory
│   └── index.test.ts        # Agent tests
├── tools/                   # Tool implementations
│   ├── index.ts             # Tool exports
│   ├── background.ts        # Background task tools
│   ├── grep/                # Ripgrep-based search
│   │   ├── index.ts
│   │   ├── tools.ts         # grep tool definition
│   │   ├── cli.ts           # CLI wrapper for ripgrep
│   │   ├── downloader.ts    # Binary download
│   │   ├── constants.ts
│   │   ├── types.ts
│   │   └── utils.ts
│   ├── ast-grep/            # AST-aware search
│   │   ├── index.ts
│   │   ├── tools.ts         # ast_grep_search/replace tools
│   │   ├── cli.ts           # CLI wrapper
│   │   ├── downloader.ts
│   │   ├── constants.ts
│   │   ├── types.ts
│   │   └── utils.ts
│   └── lsp/                 # Language Server Protocol
│       ├── index.ts
│       ├── tools.ts         # LSP tool definitions
│       ├── client.ts        # LSP client with connection pooling
│       ├── config.ts        # Server configuration
│       ├── constants.ts
│       ├── types.ts
│       └── utils.ts
├── mcp/                     # MCP server configurations
│   ├── index.ts             # MCP factory
│   ├── types.ts             # MCP types
│   ├── websearch.ts         # Exa web search
│   ├── context7.ts          # Context7 documentation
│   └── grep-app.ts          # grep.app GitHub search
├── background/              # Background task management
│   ├── index.ts             # Exports
│   ├── background-manager.ts # Task lifecycle, queuing, persistence
│   ├── tmux-session-manager.ts # Tmux pane management
│   ├── persistence.ts       # Disk persistence for recovery
│   └── background.ts        # Background task tools
├── hooks/                   # Plugin hooks
│   ├── index.ts             # Hook exports
│   ├── auto-update-checker/ # Auto-update notifications
│   ├── phase-reminder/      # Workflow phase reminders
│   └── post-read-nudge/     # Delegation nudging
├── config/                  # Configuration management
│   ├── index.ts             # Config exports
│   ├── schema.ts            # Zod schemas for validation
│   ├── constants.ts         # Constants (agent names, etc.)
│   ├── loader.ts            # Config/prompt loading
│   ├── agent-mcps.ts        # Agent-MCP mapping
│   └── utils.ts             # Config utilities
├── prompts/                 # Agent prompts
│   └── index.ts             # Prompt loading with caching
└── utils/                   # Utilities
    ├── index.ts             # Utility exports
    ├── logger.ts            # Structured logging
    ├── tmux.ts              # Tmux commands
    ├── circuit-breaker.ts   # Circuit breaker pattern
    ├── zip-extractor.ts     # ZIP extraction
    ├── agent-variant.ts     # Agent variant handling
    └── agent-variant.test.ts
```

### Key Design Patterns

1. **Plugin Pattern**
   - Main export is a `Plugin` async function that receives `PluginInput`
   - Returns agent definitions, tool definitions, MCP configurations, and hooks
   - Receives `client` for API calls and `directory` for file operations

2. **Factory Pattern**
   - Agent creation via factory functions (`createOrchestratorAgent`, `createExplorerAgent`, etc.)
   - Configurable prompts, models, and permissions per agent
   - Tool creation via `tool()` function from SDK

3. **Connection Pooling**
   - `LSPServerManager` manages LSP client lifecycle
   - Reference counting for client reuse
   - Idle timeout and cleanup timer
   - Single instance via singleton pattern

4. **Event-Driven Architecture**
   - Session events (`session.created`, `session.status`) trigger actions
   - Hooks transform messages and system prompts
   - Background task completion via notifications

5. **Resource Management**
   - `TaskResourceRegistry` for centralized cleanup
   - Timer and resolver disposables
   - Graceful shutdown with drain timeout

6. **Lazy Loading**
   - LSP servers resolved on first tool use
   - Prompt caching with hot reload support
   - Dynamic import for persistence module

7. **Configuration Validation**
   - Zod schemas for all config types
   - Runtime validation with descriptive errors
   - Default values via schema defaults

## Flow

### Plugin Initialization Flow

```
OhMyOpenCodeLite(ctx)
    ↓
loadPluginConfig(ctx.directory)
    ↓
getAgentConfigs(config) → createAgents() → agent factories
    ↓
BackgroundTaskManager instantiation
    ↓
createBuiltinMcps() → MCP server configs
    ↓
TmuxSessionManager initialization (if tmux enabled)
    ↓
Hook creation (auto-update, phase reminder, post-read nudge)
    ↓
Graceful shutdown handlers (SIGINT, SIGTERM)
    ↓
Return Plugin object with:
    - name
    - agent configurations
    - tool definitions
    - mcp configurations
    - config transformer
    - event handler
    - chat message transforms
    - tool execute hooks
```

### Agent Delegation Flow

```
User Request
    ↓
Orchestrator Agent (primary)
    ↓
Analyzes request → Determines subagent
    ↓
Subagent Selection:
    - explorer: "where is X?", "find Y"
    - librarian: "docs for Z", "library internals"
    - oracle: "explain why", "reasoning"
    - designer: "UI design", "generate code"
    - fixer: "debug", "fix bug"
    ↓
Subagent Execution (isolated session)
    ↓
Response → Orchestrator synthesizes
    ↓
User Output
```

### Tool Execution Flow

#### grep Tool

```
grep(pattern, include?, path?)
    ↓
runRg(pattern, paths, globs, context)
    ↓
Bun.spawn(['ripgrep', ...])
    ↓
Parse output → formatGrepResult()
    ↓
Return formatted results
```

#### LSP Tool (e.g., lsp_goto_definition)

```
lsp_goto_definition(filePath, line, character)
    ↓
withLspClient(filePath) → get or create LSP client
    ↓
lspManager.getClient(root, server)
    ↓
LSPClient.openFile(filePath) → textDocument/didOpen
    ↓
LSPClient.definition() → textDocument/definition
    ↓
Parse Location/LocationLink → formatLocation()
    ↓
Return formatted result
```

#### ast_grep Tool

```
ast_grep_search(pattern, lang, paths)
    ↓
ast_grep CLI (downloaded if needed)
    ↓
Bun.spawn(['ast-grep', 'search', ...])
    ↓
Parse JSON output → format results
    ↓
Return matches with file paths and snippets
```

### Background Task Flow

```
background_task(agent, prompt, description)
    ↓
BackgroundTaskManager.launch(opts)
    ↓
Create BackgroundTask (pending)
    ↓
Enqueue for start (concurrency limit)
    ↓
startTask() → create session
    ↓
session.prompt() → send prompt with system prompt
    ↓
Task status: pending → starting → running
    ↓
Event: session.status (idle) detection
    ↓
resolveTaskSession() → extract messages
    ↓
finalizeTask() → status: completed/failed
    ↓
sendCompletionNotification() → parent session
    ↓
background_output(task_id) → retrieve result
```

### Tmux Pane Flow

```
session.created event (with parentID)
    ↓
TmuxSessionManager.onSessionCreated()
    ↓
spawnTmuxPane(sessionId, title, config, serverUrl)
    ↓
Bun.spawn(['tmux', 'split-window', ...])
    ↓
Track pane in sessions map
    ↓
Polling for status updates (fallback)
    ↓
session.status (idle) event
    ↓
closeTmuxPane(paneId)
    ↓
Remove from tracking
```

### CLI Installation Flow

```
bunx oh-my-opencode-slim install [--no-tui --kimi=yes --openai=yes --tmux=no]
    ↓
install(args)
    ↓
checkOpenCodeInstalled()
    ↓
addPluginToOpenCodeConfig()
    ↓
disableDefaultAgents()
    ↓
writeLiteConfig(config)
    ↓
For each recommended skill: installSkill()
    ↓
For each custom skill: installCustomSkill()
    ↓
Print configuration summary
    ↓
Print next steps
```

## Integration

### OpenCode SDK Integration

```typescript
// @opencode-ai/plugin provides:
import type { Plugin, PluginInput, PluginTool } from '@opencode-ai/plugin';

// Plugin receives PluginInput:
interface PluginInput {
  client: {
    session: { create, delete, prompt, messages, status };
    // ... other APIs
  };
  directory: string;
  serverUrl?: URL;
}

// Plugin returns:
interface Plugin {
  name: string;
  agent: Record<string, AgentConfig>;
  tool: Record<string, ToolDefinition>;
  mcp: Record<string, McpConfig>;
  config?: (config: Record<string, unknown>) => void;
  event?: (input: { type: string; properties?: ... }) => void;
  'experimental.chat.messages.transform'?: ...;
  'experimental.chat.system.transform'?: ...;
  'tool.execute.after'?: ...;
}
```

### LSP Server Integration

```typescript
// Servers configured in src/tools/lsp/config.ts
// Resolved by root path and file extension
// Supports: typescript, typescriptreact, javascript, python, go, rust, etc.

// Connection pooling via LSPServerManager
// Single instance: const lspManager = LSPServerManager.getInstance();
```

### MCP Server Integration

```typescript
// Remote MCP configs in src/mcp/*.ts
interface RemoteMcpConfig {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  oauth: boolean;
}

// Built-in MCPs:
const allBuiltinMcps = {
  websearch: { type: 'remote', url: 'https://mcp.exa.ai/mcp?tools=web_search_exa', ... },
  context7: { type: 'remote', url: 'https://mcp.context7.com/mcp', ... },
  grep_app: { type: 'remote', url: 'https://mcp.grep.app', ... },
};

// Per-agent MCP permissions:
DEFAULT_AGENT_MCPS = {
  orchestrator: ['websearch'],
  librarian: ['websearch', 'context7', 'grep_app'],
  // ...
};
```

### Config Integration

```typescript
// Zod schemas in src/config/schema.ts
PluginConfigSchema = z.object({
  preset: z.string().optional(),
  presets: z.record(z.string(), PresetSchema).optional(),
  agents: z.record(z.string(), AgentOverrideConfigSchema).optional(),
  disabled_mcps: z.array(z.string()).optional(),
  tmux: TmuxConfigSchema.optional(),
  background: BackgroundTaskConfigSchema.optional(),
});

// Loaded from: ~/.config/opencode/oh-my-opencode-slim.json
// Or project: .opencode/oh-my-opencode-slim.json
```

### Tool-to-Module Dependencies

| Tool | Dependencies |
|------|-------------|
| `grep` | `tools/grep/cli.ts`, `tools/grep/utils.ts`, `utils/logger.ts` |
| `ast_grep_search` | `tools/ast-grep/cli.ts`, `tools/ast-grep/utils.ts`, `utils/logger.ts` |
| `ast_grep_replace` | `tools/ast-grep/cli.ts`, `tools/ast-grep/utils.ts` |
| `lsp_goto_definition` | `tools/lsp/client.ts`, `tools/lsp/utils.ts`, `tools/lsp/config.ts` |
| `lsp_find_references` | `tools/lsp/client.ts`, `tools/lsp/utils.ts` |
| `lsp_diagnostics` | `tools/lsp/client.ts`, `tools/lsp/utils.ts` |
| `lsp_rename` | `tools/lsp/client.ts`, `tools/lsp/utils.ts` |
| `background_task` | `background/background-manager.ts`, `background/tmux-session-manager.ts` |
| `background_output` | `background/background-manager.ts` |
| `background_cancel` | `background/background-manager.ts` |

### Agent-to-Prompt Mapping

| Agent | Prompt File |
|-------|------------|
| orchestrator | `prompts/agents/orchestrator.md` |
| explorer | `prompts/agents/explorer.md` |
| librarian | `prompts/agents/librarian.md` |
| oracle | `prompts/agents/oracle.md` |
| designer | `prompts/agents/designer.md` |
| fixer | `prompts/agents/fixer.md` |

Prompts loaded via `Prompts` getter with caching in `src/prompts/index.ts`.

### Hook Integration Points

| Hook | Purpose | Location |
|------|---------|----------|
| `event` | Handle session events | `src/index.ts` |
| `experimental.chat.messages.transform` | Phase reminders | `hooks/phase-reminder/index.ts` |
| `tool.execute.after` | Post-read nudges | `hooks/post-read-nudge/index.ts` |
| `experimental.chat.system.transform` | Background task status | `src/index.ts` |

### Tmux Integration

```typescript
// Tmux commands via bun.spawn in src/utils/tmux.ts
spawnTmuxPane(sessionId, title, config, serverUrl)
closeTmuxPane(paneId)
isInsideTmux()

// Pane tracking via TmuxSessionManager
// Config layouts: main-vertical, main-horizontal, tiled, even-horizontal, even-vertical
```
