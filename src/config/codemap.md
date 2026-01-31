# Config Module Codemap

## Responsibility

The `src/config/` module is responsible for:

1. **Configuration Management**: Defining type-safe configuration schemas using Zod
2. **Constants Management**: Centralizing agent names, default models, polling intervals, timeouts, and operational limits
3. **Agent Configuration**: Providing typed schemas for agent-specific overrides, models, skills, and MCP assignments
4. **Tmux Integration**: Defining layout and integration configuration schemas
5. **Background Task Configuration**: Managing concurrency and result limits for background task execution

## Design

### Key Patterns

**Schema-Driven Configuration**
- All configuration structures defined as Zod schemas with runtime validation
- TypeScript types inferred via `z.infer<typeof Schema>` for compile-time safety
- Schemas support defaults (e.g., `TmuxConfigSchema.default({...})`) and catch behavior

**Wildcard/Exclusion Syntax**
- Skills and MCPs support `"*"` (all) and `"!item"` (exclude) syntax
- Enables flexible permission filtering at runtime

**Agent Name Alias System**
- Legacy agent names mapped to current names (e.g., `explore` → `explorer`)
- Maintains backward compatibility while allowing naming evolution

### Core Abstractions

**Configuration Schema Hierarchy**

```
PluginConfigSchema
├── preset?: string
├── presets?: Record<string, Preset>
├── agents?: Record<string, AgentOverrideConfig>
├── disabled_mcps?: string[]
├── tmux?: TmuxConfig
└── background?: BackgroundTaskConfig

AgentOverrideConfigSchema
├── model?: string
├── temperature?: number (0-2)
├── variant?: string
├── skills?: string[] ("*" = all, "!item" = exclude)
└── mcps?: string[] ("*" = all, "!item" = exclude)

TmuxConfigSchema
├── enabled: boolean (default: false)
├── layout: TmuxLayout (default: "main-vertical")
└── main_pane_size: number (20-80, default: 60)

TmuxLayoutSchema
└── Enum: "main-horizontal" | "main-vertical" | "tiled" | "even-horizontal" | "even-vertical"

BackgroundTaskConfigSchema
├── maxConcurrentStarts: number (1-50, default: 10)
└── maxCompletedTasks: number (10-1000, default: 100)

McpNameSchema
└── Enum: "websearch" | "context7" | "grep_app"
```

**Agent Names**
- `ORCHESTRATOR_NAME`: `'orchestrator'` (const assertion)
- `SUBAGENT_NAMES`: `['explorer', 'librarian', 'oracle', 'designer', 'fixer']` (readonly tuple)
- `ALL_AGENT_NAMES`: `['orchestrator', 'explorer', 'librarian', 'oracle', 'designer', 'fixer']` (const assertion)
- `AGENT_ALIASES`: Maps legacy names to canonical names
- `AgentName`: TypeScript union type derived from `ALL_AGENT_NAMES`

### Interfaces

**TypeScript Types (inferred from Zod schemas)**
- `AgentOverrideConfig`: Per-agent configuration overrides (model, temperature, variant, skills, mcps)
- `TmuxConfig`: Tmux integration settings (enabled, layout, main_pane_size)
- `TmuxLayout`: Union type of layout enum values
- `Preset`: Record of named agent configurations
- `AgentName`: Union type of all valid agent names
- `McpName`: Union type of available MCP identifiers
- `BackgroundTaskConfig`: Background task concurrency and result limits
- `PluginConfig`: Main configuration object combining all schemas

**Constants**

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_MODELS` | Record<AgentName, string> | Default LLM model for each agent |
| `POLL_INTERVAL_MS` | 500 | Standard task polling interval |
| `POLL_INTERVAL_SLOW_MS` | 1000 | Slower polling for background tasks |
| `POLL_INTERVAL_BACKGROUND_MS` | 2000 | Background task polling interval |
| `DEFAULT_TIMEOUT_MS` | 120000 (2 min) | Default operation timeout |
| `MAX_POLL_TIME_MS` | 300000 (5 min) | Maximum polling duration |
| `STABLE_POLLS_THRESHOLD` | 3 | Stable polls required for state settlement |
| `BACKGROUND_MAX_RESULT_SIZE` | 102400 (100KB) | Max background task result size |
| `BACKGROUND_RESULT_TRUNCATION_MESSAGE` | string | Truncation warning suffix |

**Exported Functions**
- `loadPluginConfig(directory: string): PluginConfig` - Load and merge all configs
- `loadAgentPrompt(agentName: string): { prompt?, appendPrompt? }` - Load custom prompts
- `getAgentOverride(config, name): AgentOverrideConfig | undefined` - Get agent config with alias support
- `parseList(items, allAvailable): string[]` - Parse wildcard/exclusion lists
- `getAvailableMcpNames(config?): string[]` - Get enabled MCPs
- `getAgentMcpList(agentName, config?): string[]` - Get MCPs for specific agent

## Flow

### Configuration Definition Flow

```
schema.ts (Zod Schema Definitions)
│
 ├── AgentOverrideConfigSchema
 │    └── Validates: { model?, temperature?, variant?, skills?, mcps? }
 │
 ├── TmuxLayoutSchema
 │    └── Validates: "main-horizontal" | "main-vertical" | "tiled" | "even-horizontal" | "even-vertical"
 │
 ├── TmuxConfigSchema
 │    └── Validates: { enabled, layout, main_pane_size }
 │
 ├── McpNameSchema
 │    └── Validates: "websearch" | "context7" | "grep_app"
 │
 ├── BackgroundTaskConfigSchema
 │    └── Validates: { maxConcurrentStarts, maxCompletedTasks }
 │
 └── PluginConfigSchema
      └── Aggregates all sub-schemas into root configuration
           │
           └── z.infer<> generates TypeScript types
```

### Constants Reference Flow

```
constants.ts (Runtime Constants)
│
 ├── AGENT_ALIASES
 │    └── Maps legacy names for backward compatibility
 │
 ├── SUBAGENT_NAMES / ORCHESTRATOR_NAME / ALL_AGENT_NAMES
 │    └── Defines canonical agent hierarchy
 │
 ├── AgentName type
 │    └── Union type for type-safe agent references
 │
 ├── DEFAULT_MODELS
 │    └── Maps each agent to its default LLM model
 │
 └── Operational Constants
      ├── Polling: POLL_INTERVAL_MS, POLL_INTERVAL_SLOW_MS, POLL_INTERVAL_BACKGROUND_MS
      ├── Timeouts: DEFAULT_TIMEOUT_MS, MAX_POLL_TIME_MS
      ├── Stability: STABLE_POLLS_THRESHOLD
      └── Limits: BACKGROUND_MAX_RESULT_SIZE, BACKGROUND_RESULT_TRUNCATION_MESSAGE
```

### Configuration Loading Flow (loader.ts)

```
loadPluginConfig(directory)
│
 ├─→ Load user config from ~/.config/opencode/oh-my-opencode-slim.json
 │   └─→ Validate with PluginConfigSchema
 │       └─→ Return null if invalid/missing
 │
 ├─→ Load project config from <directory>/.opencode/oh-my-opencode-slim.json
 │   └─→ Validate with PluginConfigSchema
 │       └─→ Return null if invalid/missing
 │
 ├─→ Deep merge configs (project overrides user)
 │   ├─→ Top-level: project replaces user
 │   └─→ Nested (agents, tmux): deep merge
 │
 ├─→ Apply environment preset override (OH_MY_OPENCODE_SLIM_PRESET)
 │
 └─→ Resolve and merge preset
     ├─→ Find preset in config.presets[preset]
     ├─→ Deep merge preset agents with root agents
     └─→ Warn if preset not found
```

### Prompt Loading Flow (loader.ts)

```
loadAgentPrompt(agentName)
│
 ├─→ Check ~/.config/opencode/oh-my-opencode-slim/{agentName}.md
 │   └─→ If exists → read as replacement prompt
 │
 └─→ Check ~/.config/opencode/oh-my-opencode-slim/{agentName}_append.md
     └─→ If exists → read as append prompt
```

### MCP Resolution Flow (agent-mcps.ts)

```
getAgentMcpList(agentName, config)
│
 ├─→ Get agent override config (with alias support)
 │
 ├─→ If agent has explicit mcps config
 │   └─→ Return parseList(agent.mcps, availableMcps)
 │
 └─→ Otherwise return DEFAULT_AGENT_MCPS[agentName]
```

### Deep Merge Algorithm (loader.ts)

```
deepMerge(base, override)
│
 ├─→ If base is undefined → return override
 ├─→ If override is undefined → return base
 │
 └─→ For each key in override
     ├─→ If both values are non-array objects
     │   └─→ Recursively deepMerge
     └─→ Otherwise → override replaces base
```

## Integration

### Dependencies

**External Dependencies**
- `zod`: Runtime schema validation with type inference

**Internal Dependencies**
- None (schema.ts and constants.ts are leaf modules; no internal cross-dependencies)

### Consumers

**Direct Consumers**
- `src/loader.ts`: Uses schemas and constants for config loading/merging
- `src/index.ts`: Main plugin entry point
- `src/skills/`: Agent skill implementations
- `src/agent/`: Agent configuration and initialization

**Configuration Usage Patterns**

1. **Schema Validation**
   ```typescript
   const validated = PluginConfigSchema.parse(rawConfig);
   ```

2. **Agent Configuration**
   ```typescript
   const agentOverride = getAgentOverride(config, agentName);
   const model = agentOverride?.model ?? DEFAULT_MODELS[agentName];
   ```

3. **MCP Assignment**
   ```typescript
   const mcps = getAgentMcpList(agentName, config);
   ```

4. **Prompt Customization**
   ```typescript
   const { prompt, appendPrompt } = loadAgentPrompt(agentName);
   ```

### Constants Usage

**Polling Configuration**
- `POLL_INTERVAL_MS` (500ms): Standard polling interval
- `POLL_INTERVAL_SLOW_MS` (1000ms): Slower polling for background tasks
- `POLL_INTERVAL_BACKGROUND_MS` (2000ms): Background task polling

**Timeouts**
- `DEFAULT_TIMEOUT_MS` (2 minutes): Default operation timeout
- `MAX_POLL_TIME_MS` (5 minutes): Maximum polling duration

**Stability**
- `STABLE_POLLS_THRESHOLD` (3): Number of stable polls before considering state settled

**Result Limits**
- `BACKGROUND_MAX_RESULT_SIZE` (100KB): Maximum background task result size
- `BACKGROUND_RESULT_TRUNCATION_MESSAGE`: Message appended to truncated results

### Default Models

| Agent      | Model                          |
|------------|--------------------------------|
| orchestrator | `kimi-for-coding/k2p5`        |
| oracle      | `openai/gpt-5.2-codex`        |
| librarian   | `openai/gpt-5.1-codex-mini`   |
| explorer    | `openai/gpt-5.1-codex-mini`   |
| designer    | `kimi-for-coding/k2p5`        |
| fixer       | `openai/gpt-5.1-codex-mini`   |

### Default MCP Assignments

| Agent      | Default MCPs                          |
|------------|---------------------------------------|
| orchestrator | `['websearch']`                       |
| designer    | `[]`                                  |
| oracle      | `[]`                                  |
| librarian   | `['websearch', 'context7', 'grep_app']` |
| explorer    | `[]`                                  |
| fixer       | `[]`                                  |

## File Organization

```
src/config/
├── index.ts          # Public API exports
├── loader.ts         # Config loading and merging logic
├── schema.ts         # Zod schemas and TypeScript types
├── constants.ts      # Agent names, defaults, timeouts
├── utils.ts          # Helper functions (agent overrides)
└── agent-mcps.ts     # MCP configuration and resolution
```

## Error Handling

**Configuration Loading**
- Missing config files: Returns empty config (expected behavior)
- Invalid JSON: Logs warning, returns null
- Schema validation failure: Logs detailed error, returns null
- File read errors (non-ENOENT): Logs warning, returns null

**Prompt Loading**
- Missing prompt files: Returns empty object (expected behavior)
- File read errors: Logs warning, continues

**Preset Resolution**
- Invalid preset name: Logs warning with available presets, continues without preset

## Extension Points

**Adding New Agents**
1. Add to `SUBAGENT_NAMES` in `constants.ts`
2. Add default model to `DEFAULT_MODELS`
3. Add default MCPs to `DEFAULT_AGENT_MCPS` in `agent-mcps.ts`

**Adding New MCPs**
1. Add to `McpNameSchema` enum in `schema.ts`
2. Update `DEFAULT_AGENT_MCPS` as needed

**Adding New Configuration Options**
1. Add to `PluginConfigSchema` in `schema.ts`
2. Update deep merge logic in `loader.ts` if nested
3. Document in user-facing config documentation