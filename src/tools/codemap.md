# src/tools/ Codemap

## Responsibility

The `src/tools/` directory provides the core tool implementations for the oh-my-opencode-slim plugin. It exposes four main categories of tools that enable AI agents to perform code navigation, search, analysis, and asynchronous task execution within the plugin environment.

The **grep** tools provide fast regex-based content search using ripgrep with fallback to system grep. These tools support full regex syntax, file glob patterns, and enforce safety limits including timeouts, output size caps, and match count restrictions.

The **LSP** tools integrate with Language Server Protocol servers to provide IDE-like code intelligence features. Four essential operations are supported: goto definition for navigating to symbol declarations, find references for locating all usages of a symbol, diagnostics for retrieving errors and warnings, and rename for performing safe cross-file symbol refactoring.

The **AST-grep** tools offer structure-aware code search and modification using abstract syntax tree matching. Unlike regex-based grep, AST-grep understands code structure and can match syntactic patterns with meta-variables. Two operations are provided: search for finding code matching AST patterns, and replace for performing structural code transformations with rewrite rules.

The **background task** tools manage asynchronous agent execution, allowing agents to launch long-running tasks that complete independently of the main conversation flow. This enables fire-and-forget task launching with automatic notification when tasks complete, supporting workflow patterns where agents can continue other work while background operations proceed.

These tools are consumed by the OpenCode plugin system and exposed to AI agents through the plugin's tool registry. Each tool category is isolated in its own subdirectory with a consistent internal structure, enabling maintainability and clear separation of concerns.

---

## Design

### Architecture Overview

```
src/tools/
├── index.ts              # Central export point for all tools
├── background.ts         # Background task tool definitions (3 tools)
├── grep/                 # Regex search implementation
│   ├── cli.ts           # Subprocess execution and output parsing
│   ├── tools.ts         # Tool definition exposing grep to agents
│   ├── types.ts         # TypeScript interfaces for options and results
│   ├── utils.ts         # Output formatting utilities
│   ├── constants.ts     # CLI resolution and safety limits
│   └── downloader.ts    # Binary auto-download for ripgrep
├── lsp/                  # Language Server Protocol integration
│   ├── client.ts        # LSP client with connection pooling
│   ├── tools.ts         # Four tool definitions
│   ├── types.ts         # Type re-exports from LSP protocol
│   ├── utils.ts         # Formatters and helper functions
│   ├── config.ts        # Server discovery and language mapping
│   └── constants.ts     # Built-in server configurations
└── ast-grep/            # AST-aware structural search
    ├── cli.ts           # Subprocess execution with retry logic
    ├── tools.ts         # Two tool definitions
    ├── types.ts         # TypeScript interfaces
    ├── utils.ts         # Output formatting and hints
    ├── constants.ts     # CLI resolution and environment checks
    └── downloader.ts    # Binary auto-download for ast-grep
```

### Tool Definition Pattern

All tools follow a consistent definition pattern using the `@opencode-ai/plugin` SDK. Each tool is defined using the `tool()` function which accepts a schema definition and an async execute function. The schema uses `tool.schema` to define argument types with Zod-like validation, ensuring type safety and automatic argument validation at runtime.

```typescript
export const toolName: ToolDefinition = tool({
  description: 'Tool description for the agent',
  args: {
    argName: tool.schema.type().describe('Argument description'),
  },
  async execute(args, context) {
    // Implementation
    return result;
  },
});
```

The execute function receives validated arguments and an optional context object that provides access to plugin-level services. Some tools, particularly the AST-grep tools, use the context to emit metadata events through `context.metadata()` for surfacing additional output information to the user interface.

### CLI Abstraction Layer Pattern

Both grep and ast-grep modules follow a similar CLI abstraction pattern that separates concerns across multiple files. The `cli.ts` file handles low-level subprocess spawning with timeout handling and output parsing. The `tools.ts` file contains the high-level tool definitions that invoke CLI functions and handle tool-specific concerns. The `constants.ts` file manages CLI path resolution with fallback chains and safety limits. The `downloader.ts` file handles automatic binary download for platforms without pre-installed binaries.

This separation enables each module to evolve independently while maintaining consistent interfaces. The CLI execution layer can be modified for performance or reliability without affecting tool definitions, and new tools can reuse the same CLI patterns.

### LSP Connection Pooling

The LSP module implements a singleton `LSPServerManager` that maintains connection pools for LSP servers. This design enables efficient resource usage by reusing server processes across multiple tool invocations.

Each managed client tracks its last usage time, reference count, and initialization state. The manager uses a cleanup timer to evict idle clients after 5 minutes of inactivity, preventing resource leaks from long-running plugin sessions. When acquiring a client, the manager checks if a cached client exists for the workspace root and server ID combination, incrementing the reference count if found or creating a new client if needed.

The LSP client wraps a subprocess running the language server and a JSON-RPC connection for communication. The client handles process spawning, JSON-RPC connection setup, file opening notifications, request/response handling, and graceful shutdown. Process cleanup is registered for exit signals to ensure all language servers are terminated when the plugin shuts down.

### Background Task Architecture

Background tasks use a manager-based architecture that separates task orchestration from tool definitions. The `BackgroundTaskManager` class in `src/background/background-manager.ts` handles the complete task lifecycle, while `src/tools/background.ts` creates the tool definitions that interface with the manager.

The manager maintains several internal data structures for efficient task tracking: a primary task map keyed by task ID, a session index mapping OpenCode session IDs to task IDs, and a parent session index for finding all tasks launched from a parent session. Tasks transition through a defined state machine: pending, starting, running, and finally completed, failed, or cancelled.

The start queue implements concurrency control with a configurable maximum concurrent starts limit (default 10). Tasks are processed from the queue asynchronously, with each task's startup performed fire-and-forget to avoid blocking. The queue uses proper locking to prevent concurrent processing and maintains a set for O(1) membership testing.

### Safety Limits and Resource Constraints

All tool implementations enforce strict safety limits to prevent resource exhaustion. The grep tools limit output to 10MB, search depth to 20 directories, match count to 500 results, and column width to 1000 characters, with a 60-second timeout. The ast-grep tools similarly limit output size and match count, with a 300-second timeout for binary download and search operations. LSP operations include 30-second request timeouts to prevent blocking on unresponsive servers.

These limits ensure that tool invocations cannot monopolize system resources or block the agent conversation indefinitely. When limits are exceeded, tools return truncated results with appropriate indicators, allowing agents to reason about incomplete results.

### Error Handling Strategy

Tools follow a consistent error handling pattern where exceptions are caught and converted to formatted error messages. The execute functions return string results rather than throwing exceptions, allowing agents to receive and reason about error states gracefully. Error messages include actionable information such as installation hints for missing binaries or timeout notifications.

For background tasks specifically, errors during startup finalize the task with failed status, while errors during completion extraction still capture the last assistant message. The notification system handles delivery failures with retry logic and exponential backoff, marking notifications as permanently failed after 3 attempts.

---

## Flow

### Tool Registration Flow

Tool registration occurs during plugin initialization when `src/index.ts` imports all tools from `src/tools/index.ts`. This barrel file re-exports tool definitions from each subdirectory, creating a unified namespace for the plugin system. The registration process passes the plugin input context to tools that require it, providing access to the OpenCode client, working directory, and configuration.

The `createBackgroundTools()` function is special because it requires a `BackgroundTaskManager` instance to be constructed and passed in. This function is called during plugin initialization with the manager already created, allowing the background tools to interface with the task system. Other tools like grep, LSP, and ast-grep are stateless and can be imported directly without configuration.

### Grep Tool Execution Flow

When an agent invokes the grep tool, the execution flow proceeds through several stages. The tool definition in `tools.ts` receives validated arguments and calls `runRg()` from `cli.ts`. The CLI function resolves the ripgrep path through `resolveGrepCli()`, checking bundled binaries first, then system PATH, then cached downloads, and finally falling back to system grep if ripgrep is unavailable.

With the CLI path resolved, `buildArgs()` constructs the command arguments, adding safety flags for output formatting and combining them with user-specified options. The function applies safety limits such as max depth, filesize, count, and columns. The subprocess is spawned with a timeout promise that kills the process if it exceeds the limit.

The output is parsed in `parseOutput()` to extract file paths, line numbers, and matching text. The parsed matches are then formatted in `formatGrepResult()` to group results by file and produce human-readable output. Any errors during execution are caught and returned as formatted error messages with installation hints if the CLI is missing.

### LSP Tool Execution Flow

LSP tool execution follows a multi-stage flow that manages client lifecycle transparently. When an agent invokes an LSP tool such as `lsp_goto_definition`, the tool calls `withLspClient()` from `utils.ts` to acquire an appropriate LSP client.

The `withLspClient()` function first resolves the language server configuration by calling `findServerForExtension()` from `config.ts`, which matches the file extension to language IDs and retrieves the server command. The function then finds the workspace root by searching for project markers like `.git` or `package.json`.

The `lspManager.getClient()` method checks if a cached client exists for the workspace root and server ID combination. If found, it increments the reference count and returns the client. If not found, it creates a new `LSPClient`, spawns the server process, establishes the JSON-RPC connection, performs the LSP handshake, and stores the client in the pool.

With the client acquired, the tool sends the appropriate LSP request with a per-request timeout. The response is formatted using utility functions like `formatLocation()` for definitions and references or `formatDiagnostic()` for diagnostics. The client is then released by decrementing its reference count, enabling idle cleanup.

### AST-grep Tool Execution Flow

AST-grep execution mirrors the grep pattern with additional complexity for binary resolution and JSON parsing. When an agent invokes `ast_grep_search` or `ast_grep_replace`, the tool calls `runSg()` from `cli.ts`.

The `runSg()` function first ensures the ast-grep binary is available by calling `getAstGrepPath()`. This function checks the cached path, performs a synchronous filesystem check for common installation locations, and falls back to `ensureAstGrepBinary()` which downloads the binary if missing. The function uses a single init promise to avoid race conditions during concurrent calls.

With the binary path resolved, `runSg()` builds the command arguments including the pattern, target language, optional rewrite rule, globs, paths, and update flags. The subprocess is spawned with timeout handling similar to grep. The JSON output is parsed to extract matches, with special handling for partial JSON from output truncation.

Results are formatted in `formatSearchResult()` or `formatReplaceResult()` from `utils.ts`, which group matches by file and add summaries. For searches with no results, `getEmptyResultHint()` provides contextual suggestions for pattern adjustments.

### Background Task Lifecycle Flow

Background tasks follow a detailed lifecycle managed by `BackgroundTaskManager`. When `background_task` is invoked with `wait=false` (the default), the flow is fire-and-forget: `manager.launch()` creates a task record with `pending` status and unique ID, enqueues it for startup respecting concurrency limits, and returns the task ID immediately in approximately 1 millisecond.

The task is then processed asynchronously by `processQueue()`. For each task, `startTask()` performs a two-phase commit: it first creates an OpenCode session via `client.session.create()`, then transitions the task to `running` status and sends the prompt with the agent assignment. The session runs independently with the agent executing the prompt.

Completion detection uses the `session.status` event. When the session reports `idle` status, `handleSessionSession()` is called. A 500ms debounce ensures the final assistant message is persisted before resolution. The `resolveTaskSession()` method extracts all assistant messages from the session as the task result, then calls `finalizeTask()` to transition to `completed` status.

After finalization, `sendCompletionNotification()` delivers a completion notice to the parent session. The notification uses atomic state tracking with retry logic for delivery failures. The notice includes the task ID and retrieval command, enabling the agent to call `background_output` to get the full result.

When `background_output` is called, `manager.getResult()` retrieves the task and validates it has reached a terminal state. The result is formatted with duration, status, and truncation information by `formatTaskOutput()`. The task is then marked as retrieved and cleared from pending retrieval tracking.

The `background_cancel` tool calls `manager.cancel()` which transitions cancellable tasks (pending, starting, or running) to `cancelled` status. The associated session is deleted, and any final assistant message is captured as the result.

---

## Integration

### OpenCode Plugin System Integration

Tools integrate with the OpenCode plugin system through the `@opencode-ai/plugin` SDK. The `PluginInput` interface provides access to the OpenCode client for session management, the working directory for path resolution, and optional configuration for customization.

Background tasks heavily use the plugin client through the `client.session` API. This enables creating child sessions of the parent conversation with `create()`, sending prompts with agent assignment and variant support via `prompt()`, retrieving messages for result extraction with `messages()`, and deleting sessions with `delete()`. The parent session ID is passed to child sessions, creating a hierarchy that enables notification delivery.

### External Tool Dependencies

The grep tools depend on ripgrep (`rg`) as the primary search backend, with fallback to system `grep` on platforms without ripgrep. The installation path resolution checks bundled binaries first (from OpenCode's data directory), then system PATH, then cached downloads in platform-specific locations. If no ripgrep is found and auto-install is enabled, the tool downloads a prebuilt binary from GitHub releases.

The ast-grep tools depend on the `ast-grep` CLI binary, installed via npm package `@ast-grep/cli`, cargo installation, or homebrew. Resolution follows a similar chain to grep, checking bundled paths, PATH, and cache directories before attempting download. The tool supports 25 programming languages including JavaScript, TypeScript, Python, Go, Rust, Java, C/C++, and many others.

LSP tools require external LSP servers to be pre-configured. The plugin uses language configuration from `lsp/config.ts` to map file extensions to server commands. Common servers like TypeScript/JavaScript (typescript-language-server), Python (pyright/pylsp), Go (gopls), and Rust (rust-analyzer) are supported through configuration in `BUILTIN_SERVERS`.

### Configuration Integration

The grep tools read CLI paths and download locations from `src/tools/grep/constants.ts`. Safety limits are defined as exported constants including `DEFAULT_MAX_DEPTH`, `DEFAULT_MAX_FILESIZE`, `DEFAULT_MAX_COUNT`, `DEFAULT_MAX_COLUMNS`, `DEFAULT_TIMEOUT_MS`, and `DEFAULT_MAX_OUTPUT_BYTES`. The `RG_SAFETY_FLAGS` array defines safe defaults for ripgrep invocation.

The ast-grep tools read binary paths from `src/tools/ast-grep/constants.ts`. Language support is defined in `CLI_LANGUAGES` with 25 supported languages. Environment checks verify binary availability through `checkEnvironment()`.

Background tasks integrate with plugin configuration through the `BackgroundTaskConfig` interface, specifying `maxConcurrentStarts` (default 10) and `maxCompletedTasks` (default 100). The tmux configuration from `TmuxConfig` enables optional tmux pane creation for visual task isolation when the tmux integration is configured.

### Health Monitoring Integration

The `BackgroundTaskManager` integrates with system lifecycle through process signal handlers for `exit`, `SIGINT`, and `SIGTERM`. These handlers trigger comprehensive cleanup including canceling pending notifications, clearing idle timers, stopping the orphaned task sweep, releasing resources through the registry, clearing all queues, resolving waiting callers with null, and clearing all internal data structures.

The manager also runs an orphaned task sweep every 60 seconds to detect and finalize tasks whose parent sessions have been deleted or tasks that have been running too long (exceeding 30 minutes). This prevents memory leaks from abandoned tasks.

LSP clients integrate with process cleanup through `registerProcessCleanup()` in `LSPServerManager`, which stops all active language server processes on exit signals. The manager also runs an idle client cleanup timer to evict clients that have been unused for 5 minutes.

### Binary Management

Ripgrep management is handled by `src/tools/grep/downloader.ts`. The downloader downloads version 14.1.1 for darwin-arm64, darwin-x64, linux-arm64, linux-x64, and win32-x64 platforms. Install locations follow platform conventions: `~/.cache/oh-my-opencode-slim/bin/rg` on Linux/macOS and `%LOCALAPPDATA%\oh-my-opencode-slim\bin\rg.exe` on Windows.

Ast-grep management is handled by `src/tools/ast-grep/downloader.ts`. The downloader syncs with `@ast-grep/cli` package version 0.40.0 and supports additional platforms including win32-arm64 and win32-ia32. Install locations follow similar conventions with `sg` or `sg.exe` as the binary name.

Both downloaders use platform detection to select appropriate assets, extract zip archives for Windows or process compressed tarballs for Unix systems, and cache downloaded binaries to avoid repeated downloads.

### Tool Registry Integration

All tools are exported from `src/tools/index.ts` as the central export point. The main plugin entry point `src/index.ts` imports these tools and registers them with the plugin system. The exports follow a consistent pattern:

```typescript
// Grep tool
export { grep } from './grep';

// AST-grep tools
export { ast_grep_replace, ast_grep_search } from './ast-grep';

// Background task tools (via factory function)
export { createBackgroundTools } from './background';

// LSP tools
export {
  lsp_diagnostics,
  lsp_find_references,
  lsp_goto_definition,
  lsp_rename,
  lspManager,
} from './lsp';
```

The `lspManager` singleton is exported separately because it is used by the plugin system for event handling (passing `session.status` events to `handleSessionStatus()`), not directly as a tool available to agents.

### Performance Considerations

Connection pooling in the LSP module enables efficient resource usage by reusing server processes across multiple tool invocations. Reference counting ensures clients remain alive while in active use, and idle cleanup removes unused clients after 5 minutes.

Output truncation prevents memory issues with large result sets. The grep tools truncate at 10MB of output, and ast-grep limits matches to prevent excessive memory consumption. These limits are enforced before returning results to agents.

Caching of CLI paths avoids repeated filesystem checks. Each tool module caches resolved binary paths to minimize filesystem overhead on subsequent calls.

Background task pre-initialization through `startBackgroundInit()` in the ast-grep module triggers binary availability checking before the first tool call, reducing latency on the first invocation.

### File-by-File Reference

**Root Level**

- `index.ts`: Central export point re-exporting all tools
- `background.ts`: Background task tool definitions with `createBackgroundTools()` factory function

**grep/ Subdirectory**

- `cli.ts`: `runRg()` and `runRgCount()` functions for subprocess execution with timeout
- `tools.ts`: `grep` tool definition exposing regex search to agents
- `types.ts`: `GrepMatch`, `GrepResult`, `CountResult`, `GrepOptions` interfaces
- `utils.ts`: `formatGrepResult()` for output formatting
- `constants.ts`: Safety limits and `resolveGrepCli()` with auto-install support
- `downloader.ts`: `downloadAndInstallRipgrep()` and `getInstalledRipgrepPath()`
- `index.ts`: Barrel file re-exporting grep module

**lsp/ Subdirectory**

- `client.ts`: `LSPServerManager` singleton and `LSPClient` class with process cleanup
- `tools.ts`: Four tool definitions: `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, `lsp_rename`
- `types.ts`: LSP type re-exports from vscode-languageserver-protocol
- `utils.ts`: `withLspClient()` wrapper, formatters, `applyWorkspaceEdit()`, circuit breaker
- `config.ts`: `findServerForExtension()`, `getLanguageId()`, `isServerInstalled()`
- `constants.ts`: `BUILTIN_SERVERS`, `EXT_TO_LANG`, `LSP_INSTALL_HINTS`, safety limits
- `index.ts`: Barrel file re-exporting LSP module and types

**ast-grep/ Subdirectory**

- `cli.ts`: `runSg()` with retry logic, `getAstGrepPath()`, `startBackgroundInit()`
- `tools.ts`: Two tool definitions: `ast_grep_search`, `ast_grep_replace`
- `types.ts`: `CliLanguage`, `CliMatch`, `SgResult`, `CLI_LANGUAGES`
- `utils.ts`: `formatSearchResult()`, `formatReplaceResult()`, `getEmptyResultHint()`
- `constants.ts`: `findSgCliPathSync()`, `checkEnvironment()`, safety limits
- `downloader.ts`: `downloadAstGrep()`, `ensureAstGrepBinary()`, cache management
- `index.ts`: Barrel file re-exporting ast-grep module
