<div align="center">

# oh-my-opencode-slim

**A lightweight, powerful agent orchestration plugin for OpenCode**

<img src="img/hero.png" alt="Agent Orchestration - Hub and Spoke Model" width="520">

*Transform your AI assistant into a manager capable of delegating complex tasks to specialized sub-agents, running searches in the background, and managing multi-step workflows with ease.*

</div>

> Slimmed-down fork of [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) — focused on core agent orchestration without the extra bells and whistles.

---

## Installation

### For Humans

Run the interactive installer:

```bash
bunx oh-my-opencode-slim install
```

Or use non-interactive mode:

```bash
bunx oh-my-opencode-slim install --no-tui --antigravity=yes --openai=yes --cerebras=no
```

**Alternative: Ask any coding agent**

Paste this into Claude Code, AmpCode, Cursor, or any coding agent:

```
Install and configure by following the instructions here:
https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/refs/heads/master/README.md
```

### For LLM Agents

<details>
<summary>Instructions for LLM Agents (click to expand)</summary>

If you're an LLM Agent helping set up oh-my-opencode-slim, follow these steps.

---

#### Step 1: Check OpenCode Installation

```bash
opencode --version
```

If not installed, direct the user to https://opencode.ai/docs first.

---

#### Step 2: Ask About Provider Access

Ask these questions **one at a time**, waiting for responses:

1. "Do you have an **Antigravity** subscription?" *(Provides Claude + Gemini via `google/` prefix)*
2. "Do you have access to **OpenAI** API?" *(Enables `openai/` models)*
3. "Do you have access to **Cerebras** API?" *(Enables `cerebras/` for fast exploration)*

---

#### Step 3: Run the Installer

Based on answers, run:

```bash
bunx oh-my-opencode-slim install --no-tui --antigravity=<yes|no> --openai=<yes|no> --cerebras=<yes|no>
```

**Examples:**
```bash
# Antigravity + OpenAI
bunx oh-my-opencode-slim install --no-tui --antigravity=yes --openai=yes --cerebras=no

# OpenAI only
bunx oh-my-opencode-slim install --no-tui --antigravity=no --openai=yes --cerebras=no

# All providers
bunx oh-my-opencode-slim install --no-tui --antigravity=yes --openai=yes --cerebras=yes
```

The installer automatically:
- Adds the plugin to `~/.config/opencode/opencode.json`
- Adds `opencode-antigravity-auth` plugin (if Antigravity enabled)
- Configures Google provider with model definitions
- Generates agent model mappings in `~/.config/opencode/oh-my-opencode-slim.json`

---

#### Step 4: Authentication

After installation, guide the user:

**For Antigravity:**
```bash
opencode auth login
# Select: Google → OAuth with Google (Antigravity)
```

**For OpenAI:**
```bash
export OPENAI_API_KEY="sk-..."
```

**For Cerebras:**
```bash
export CEREBRAS_API_KEY="..."
```

---

#### Step 5: Verify

```bash
opencode
```

---

#### Troubleshooting

If the installer fails, check the expected config format:
```bash
bunx oh-my-opencode-slim install --help
```

Then manually create the config files at:
- `~/.config/opencode/opencode.json`
- `~/.config/opencode/oh-my-opencode-slim.json`

</details>

---

## Architecture & Flow

The plugin follows a "Hub and Spoke" model:

1. **The Orchestrator (Hub)**: The main entry point for user requests. It analyzes the task and decides which specialized agents to call.
2. **Specialized Agents (Spokes)**: Domain-specific experts (e.g., UI/UX, Documentation, Architecture) that handle narrow tasks with high precision.
3. **Background Manager**: A robust engine that allows the Orchestrator to "fire and forget" tasks (like deep codebase searches or documentation research) while continuing to work on other parts of the problem.

### The Flow of a Request

1. **User Prompt**: "Refactor the auth logic and update the docs."
2. **Orchestrator**: Creates a TODO list.
3. **Delegation**:
   - Launches an `@explore` background task to find all auth-related files.
   - Launches a `@librarian` task to check the latest documentation for the auth library used.
4. **Integration**: Once background results are ready, the Orchestrator performs the refactor.
5. **Finalization**: Passes the changes to `@document-writer` to update the README.

---

## Agents

| Agent | Role | Default Model | Best Used For |
| :--- | :--- | :--- | :--- |
| **orchestrator** | Manager | `google/claude-opus-4-5-thinking` | Planning, task delegation, and overall coordination. |
| **oracle** | Architect | `openai/gpt-5.2-codex` | Complex debugging, architectural decisions, and code reviews. |
| **explore** | Searcher | `cerebras/zai-glm-4.6` | Fast codebase grep, finding patterns, and locating definitions. |
| **librarian** | Researcher | `google/gemini-3-flash` | External library docs, GitHub examples, and API research. |
| **frontend-ui-ux-engineer** | Designer | `google/gemini-3-flash` | Visual changes, CSS/styling, and React/Vue component polish. |
| **document-writer** | Scribe | `google/gemini-3-flash` | Technical documentation, READMEs, and inline code comments. |
| **multimodal-looker** | Visionary | `google/gemini-3-flash` | Analyzing screenshots, wireframes, or UI designs. |
| **code-simplicity-reviewer** | Minimalist | `google/claude-opus-4-5-thinking` | Ruthless code simplification and YAGNI principle enforcement. |

---

## Tools & Capabilities

### Background Tasks

The plugin provides tools to manage asynchronous work:

| Tool | Description |
|------|-------------|
| `background_task` | Launch an agent in a new session (`sync=true` blocks, `sync=false` runs in background) |
| `background_output` | Fetch the result of a background task by ID |
| `background_cancel` | Abort running tasks |

### LSP Tools

Language Server Protocol integration for code intelligence:

| Tool | Description |
|------|-------------|
| `lsp_goto_definition` | Jump to symbol definition |
| `lsp_find_references` | Find all usages of a symbol across the workspace |
| `lsp_diagnostics` | Get errors/warnings from the language server |
| `lsp_rename` | Rename a symbol across all files |

### Code Search Tools

Fast code search and refactoring:

| Tool | Description |
|------|-------------|
| `grep` | Fast content search using ripgrep |
| `ast_grep_search` | AST-aware code pattern matching (25 languages) |
| `ast_grep_replace` | AST-aware code refactoring with dry-run support |

### Quota Tool

For Antigravity users:

| Tool | Description |
|------|-------------|
| `antigravity_quota` | Check API quota for all Antigravity accounts (compact view with progress bars) |

---

## MCP Servers

Built-in Model Context Protocol servers (enabled by default):

| MCP | Purpose | URL |
|-----|---------|-----|
| `websearch` | Real-time web search via Exa AI | `https://mcp.exa.ai/mcp` |
| `context7` | Official library documentation | `https://mcp.context7.com/mcp` |
| `grep_app` | GitHub code search via grep.app | `https://mcp.grep.app` |

### Disabling MCPs

You can disable specific MCP servers in your config:

```json
{
  "disabled_mcps": ["websearch", "grep_app"]
}
```

---

## Configuration

You can customize the behavior of the plugin via JSON configuration files.

### Configuration Files

The plugin looks for configuration in two places (and merges them):

1. **User Global**: `~/.config/opencode/oh-my-opencode-slim.json` (or OS equivalent)
2. **Project Local**: `./.opencode/oh-my-opencode-slim.json`

| Platform | User Config Path |
| :--- | :--- |
| **Windows** | `~/.config/opencode/oh-my-opencode-slim.json` or `%APPDATA%\opencode\oh-my-opencode-slim.json` |
| **macOS/Linux** | `~/.config/opencode/oh-my-opencode-slim.json` |

### Disabling Agents

You can disable specific agents using the `disabled_agents` array:

```json
{
  "disabled_agents": ["multimodal-looker", "code-simplicity-reviewer"]
}
```

---

## Uninstallation

1. **Remove the plugin from your OpenCode config**:

   Edit `~/.config/opencode/opencode.json` and remove `"oh-my-opencode-slim"` from the `plugin` array.

2. **Remove configuration files (optional)**:
   ```bash
   rm -f ~/.config/opencode/oh-my-opencode-slim.json
   rm -f .opencode/oh-my-opencode-slim.json
   ```

---

## Credits

This is a slimmed-down fork of [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) by [@code-yeongyu](https://github.com/code-yeongyu).

---

## License

MIT
