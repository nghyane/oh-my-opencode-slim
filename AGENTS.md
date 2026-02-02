# Agent Coding Guidelines

Guidelines for AI agents working in this repository.

## Project Overview

**oh-my-opencode-slim** - Lightweight agent orchestration plugin for OpenCode. Built with TypeScript, Bun, and Biome.

## Commands

| Command | Description |
|---------|-------------|
| `bun run build` | Build to `dist/` (index + cli + declarations) |
| `bun run typecheck` | TypeScript check without emit |
| `bun test` | Run all tests |
| `bun test -t "pattern"` | Run single test by name pattern |
| `bun run lint` | Biome lint |
| `bun run format` | Biome format with write |
| `bun run check` | Biome check with auto-fix (lint + format + imports) |
| `bun run check:ci` | Biome check without auto-fix (CI mode) |
| `bun run dev` | Build and run with OpenCode |

## Code Style

### Biome Configuration
- **Line width:** 80 characters
- **Indentation:** 2 spaces
- **Line endings:** LF (Unix)
- **Quotes:** Single
- **Trailing commas:** Always

### TypeScript
- **Strict mode:** Enabled
- **Module:** ESM with bundler resolution
- **No explicit `any`:** Warning (disabled in test files)
- **Declarations:** Auto-generated to `dist/`

### Imports
- Biome auto-organizes imports (`organizeImports: "on"`)
- Let formatter handle sorting
- Use path aliases from `tsconfig.json` if available

### Naming
- **Variables/functions:** camelCase
- **Classes/interfaces:** PascalCase
- **Constants:** SCREAMING_SNAKE_CASE
- **Files:** kebab-case (PascalCase for React components)

### Error Handling
- Use typed errors with descriptive messages
- Let errors propagate; avoid silent catches
- Use Zod for runtime validation

## Project Structure

```
src/
├── index.ts          # Main plugin export
├── cli/index.ts      # CLI entry point
├── skills/           # Agent skills (published)
├── prompts/agents/   # Agent system prompts
├── background/       # Background task management
└── config/           # Configuration utilities
dist/                 # Built output
docs/                 # Documentation
```

## Key Dependencies

- `@modelcontextprotocol/sdk` - MCP protocol
- `@opencode-ai/sdk` - OpenCode SDK
- `zod` - Runtime validation
- `vscode-languageserver-protocol` - LSP support
- `@ast-grep/cli` - AST search/replace

## Development Workflow

1. Make changes
2. `bun run check:ci` - verify lint/format
3. `bun run typecheck` - verify types
4. `bun test` - verify tests
5. Commit

## Git Integration

- Biome integrates with git (VCS enabled)
- Commits must pass `bun run check:ci`
- Uses `.gitignore` for ignore patterns

## Agent Orchestration

Agent prompts and workflows are defined in `src/prompts/agents/`:
- `orchestrator.md` - Main workflow (6-phase: Understand→Delegate→Split→Plan→Execute→Verify)
- `explorer.md` - Codebase search (read-only)
- `librarian.md` - External docs research (read-only)
- `oracle.md` - Strategic decisions (read-only)
- `designer.md` - UI/UX implementation
- `fixer.md` - Fast code changes

## Core Principles

- **Clarify first:** Ask before guessing
- **Minimum viable:** Simplest working solution
- **Reuse existing:** Prefer existing utilities
- **File limit:** Keep files under 300 LOC
- **No hardcoded secrets:** Use environment variables
- **Clean up:** Delete temp files after use
