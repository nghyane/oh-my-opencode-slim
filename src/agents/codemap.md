# Agents Directory Codemap

## Responsibility

The `src/agents/` directory defines and configures the multi-agent orchestration system for OpenCode. It creates specialized AI agents with distinct roles, capabilities, and behaviors that work together under an orchestrator to optimize coding tasks for quality, speed, cost, and reliability.

## Design

### Core Architecture

**AgentDefinition Interface** (defined in `orchestrator.ts`)
```typescript
interface AgentDefinition {
  name: string;
  description?: string;
  config: AgentConfig;
}
```

**AgentFactory Type** (defined in `index.ts`)
```typescript
type AgentFactory = (
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
) => AgentDefinition;
```

**SubagentName Type** (defined in `index.ts`)
```typescript
type SubagentName = 'explorer' | 'librarian' | 'oracle' | 'designer' | 'fixer';
```

All agents follow a consistent factory pattern:
- `createXAgent(model, customPrompt?, customAppendPrompt?)` → `AgentDefinition`
- Custom prompts can fully replace or append to default prompts
- Temperature varies by agent role (0.1-0.7) to balance precision vs creativity
- All agents import `AgentDefinition` from `orchestrator.ts` and `Prompts` from `../prompts/index.js`

### Agent Classification

**SubagentName Type**
```typescript
type SubagentName = 'explorer' | 'librarian' | 'oracle' | 'designer' | 'fixer';
```

**Classification Helper**
```typescript
function isSubagent(name: string): name is SubagentName;
```

**Primary Agent**
- **Orchestrator**: Central coordinator that delegates tasks to specialists

**Subagents** (5 specialized agents)
1. **Explorer** - Codebase navigation and search (temperature: 0.1)
2. **Librarian** - Documentation and library research (temperature: 0.1)
3. **Oracle** - Strategic technical advisor (temperature: 0.1)
4. **Designer** - UI/UX specialist (temperature: 0.7)
5. **Fixer** - Fast implementation specialist (temperature: 0.2)

### Configuration System

**Override Application**
- Model and temperature can be overridden per agent via user config
- Fallback mechanism: Fixer inherits Librarian's model if not configured
- Default models defined in `../config/DEFAULT_MODELS`

**Permission System**
- All agents get `question: 'allow'` by default
- Skill permissions applied via `getSkillPermissionsForAgent()`
- Nested permission structure: `{ question, skill: { ... } }`

**Custom Prompts**
- Loaded via `loadAgentPrompt(name)` from config (returns `{ prompt?, appendPrompt? }`)
- `customPrompt` replaces default prompt entirely
- `customAppendPrompt` appends to default prompt with newline separator
- Prompts sourced from `../prompts/index.js` (Prompts.designer, Prompts.explorer, etc.)

### Agent Specialization Matrix

| Agent | Primary Focus | Tools | Constraints | Temperature | Prompt Source |
|-------|--------------|-------|-------------|-------------|---------------|
| Explorer | Codebase search | grep, glob, ast_grep_search | Read-only, parallel | 0.1 | Prompts.explorer |
| Librarian | External docs | context7, grep_app, websearch | Evidence-based | 0.1 | Prompts.librarian |
| Oracle | Architecture | Analysis tools | Read-only, advisory | 0.1 | Prompts.oracle |
| Designer | UI/UX | Tailwind, CSS | Visual excellence | 0.7 | Prompts.designer |
| Fixer | Implementation | edit/write tools | No research/delegation | 0.2 | Prompts.fixer |

## Flow

### Agent Creation Flow

```
createAgents(config?)
    │
    ├─→ For each subagent:
    │   ├─→ Get model from DEFAULT_MODELS (fixer falls back to librarian)
    │   ├─→ Load custom prompts via loadAgentPrompt(name)
    │   ├─→ Call factory function
    │   ├─→ Apply overrides (model, temperature)
    │   └─→ Apply default permissions (question: 'allow', skill permissions)
    │
    ├─→ Create orchestrator:
    │   ├─→ Get model from DEFAULT_MODELS
    │   ├─→ Load custom prompts
    │   ├─→ Call factory function
    │   ├─→ Apply overrides
    │   └─→ Apply default permissions
    │
    └─→ Return [orchestrator, ...subagents]
```

**Fixer Fallback Logic**: If fixer has no model configured but librarian does, fixer inherits librarian's model for backward compatibility with existing user configurations.

### SDK Configuration Flow

```
getAgentConfigs(config?)
    │
    ├─→ createAgents(config)
    │
    ├─→ For each agent:
    │   ├─→ Extract config and description
    │   ├─→ Add MCP list via getAgentMcpList(agentName, config)
    │   ├─→ Set mode:
    │   │   ├─→ 'primary' for orchestrator
    │   │   └─→ 'subagent' for others
    │   └─→ Map to Record<string, SDKAgentConfig & { mcps?: string[] }>
    │
    └─→ Return config object
```

### Orchestrator Delegation Flow

```
User Request
    │
    ↓
Understand (parse requirements)
    │
    ↓
Path Analysis (quality, speed, cost, reliability)
    │
    ↓
Delegation Check
    │
    ├─→ Need to discover unknowns? → @explorer
    ├─→ Complex/evolving APIs? → @librarian
    ├─→ High-stakes decisions? → @oracle
    ├─→ User-facing polish? → @designer
    ├─→ Clear spec, parallel tasks? → @fixer
    └─→ Simple/quick? → Do yourself
    │
    ↓
Parallelize (if applicable)
    │
    ├─→ Multiple @explorer searches?
    ├─→ @explorer + @librarian research?
    └─→ Multiple @fixer instances?
    │
    ↓
Execute & Integrate
    │
    ↓
Verify (lsp_diagnostics, tests)
```

### Agent Interaction Patterns

**Research → Implementation Chain**
```
Orchestrator
    ↓ delegates to
Explorer (find files) + Librarian (get docs)
    ↓ provide context to
Fixer (implement changes)
```

**Advisory Pattern**
```
Orchestrator
    ↓ delegates to
Oracle (architecture decision)
    ↓ provides guidance to
Orchestrator (implements or delegates to Fixer)
```

**Design Pattern**
```
Orchestrator
    ↓ delegates to
Designer (UI/UX implementation)
    ↓ (Designer may use Fixer for parallel tasks)
```

## Integration

### Dependencies

**External Dependencies**
- `@opencode-ai/sdk` - Core agent configuration types (`AgentConfig`)
- `@modelcontextprotocol/sdk` - MCP protocol (via config)

**Internal Dependencies**
- `../config` - Agent overrides, default models, MCP lists, custom prompts
- `../cli/skills` - Skill permission system (`getSkillPermissionsForAgent`)
- `../prompts` - Default agent prompts (Prompts.explorer, Prompts.librarian, etc.)

### Consumers

**Direct Consumers**
- `src/index.ts` - Re-exports `AgentDefinition` and `getAgentConfigs()` for plugin use
- `src/cli/index.ts` - CLI entry point uses agent configurations

**Indirect Consumers**
- OpenCode SDK - Consumes agent configurations via `getAgentConfigs()`
- MCP servers - Agents configured with specific MCP tool lists via `getAgentMcpList()`

### Configuration Integration

**Agent Override Config**
```typescript
interface AgentOverrideConfig {
  model?: string;
  temperature?: number;
  skills?: string[];
}
```

**Plugin Config**
```typescript
interface PluginConfig {
  agents?: {
    [agentName: string]: AgentOverrideConfig;
  };
  // ... other config
}
```

### Skill System Integration

Each agent gets skill-specific permissions:
- Permissions loaded from `../cli/skills`
- Applied via nested `skill` key in permissions object
- Respects user-configured skill lists if provided

### MCP Integration

Agents are configured with specific MCP tool lists:
- `getAgentMcpList(agentName, config)` returns tool list
- MCP tools enable agent capabilities (e.g., grep_app for Librarian)
- Configured per agent based on role and needs

## Key Design Decisions

1. **Factory Pattern**: Consistent agent creation via factory functions with identical signatures
2. **Type Centralization**: `AgentDefinition` interface in `orchestrator.ts` for type safety
3. **Temperature Gradient**: 0.1 (precision/research) → 0.7 (creativity/design) based on role
4. **Read-Only Specialists**: Explorer, Librarian, Oracle don't modify code by default
5. **Execution Specialist**: Fixer is the primary agent for making code changes
6. **Fallback Model**: Fixer inherits Librarian's model if not configured (backward compatibility)
7. **Prompt Precedence**: `customPrompt` overrides entirely, `customAppendPrompt` appends to defaults
8. **Parallel-First**: Orchestrator encouraged to parallelize independent tasks
9. **Evidence-Based Research**: Librarian must provide sources and citations
10. **Visual Excellence Priority**: Designer prioritizes aesthetics over code perfection
11. **Permission Centralization**: Permissions applied in `index.ts`, not in individual agent factories

## File Structure

```
src/agents/
├── index.ts           # Main entry point, agent factory registry, config application
├── orchestrator.ts    # AgentDefinition interface, orchestrator agent factory
├── explorer.ts        # Explorer agent factory (codebase search, temp: 0.1)
├── librarian.ts       # Librarian agent factory (docs research, temp: 0.1)
├── oracle.ts          # Oracle agent factory (technical advisor, temp: 0.1)
├── fixer.ts           # Fixer agent factory (implementation, temp: 0.2)
├── designer.ts        # Designer agent factory (UI/UX, temp: 0.7)
└── codemap.md         # This documentation file
```

**File Responsibilities**
- `index.ts` - Factory registry, permission application, override handling, SDK config export
- `orchestrator.ts` - Core type definitions, orchestrator agent creation
- Individual agent files - Specialized factory functions with role-specific prompts

## Extension Points

**Adding New Agents**
1. Create `src/agents/newagent.ts` with `createNewAgent()` factory function
2. Export the factory from the new file
3. Add to `SUBAGENT_FACTORIES` record in `index.ts` with type `AgentFactory`
4. Add to `SUBAGENT_NAMES` constant tuple in `../config`
5. Configure default model in `../config/DEFAULT_MODELS`
6. Add MCP configuration in `../config/agent-mcps`
7. Add skill permissions in `../cli/skills`

**Customizing Existing Agents**
- Override model/temperature via plugin config
- Replace or append to prompts via `loadAgentPrompt()`
- Configure MCP tools via agent-mcps config
- Adjust skill permissions via skills config

**Factory Pattern Requirements**
Each agent factory must:
1. Accept `model: string` as first parameter
2. Accept optional `customPrompt?: string` as second parameter
3. Accept optional `customAppendPrompt?: string` as third parameter
4. Return `AgentDefinition` with `name`, `description`, and `config` (model, temperature, prompt)