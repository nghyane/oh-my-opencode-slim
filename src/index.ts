import type { Plugin } from '@opencode-ai/plugin';
import { getAgentConfigs } from './agents';
import { BackgroundTaskManager, TmuxSessionManager } from './background';
import { loadPluginConfig, type TmuxConfig } from './config';
import { parseList } from './config/agent-mcps';
import {
  createAutoUpdateCheckerHook,
  createPhaseReminderHook,
  createPostReadNudgeHook,
} from './hooks';
import { createBuiltinMcps } from './mcp';

import {
  ast_grep_replace,
  ast_grep_search,
  createBackgroundTools,
  grep,
  lsp_diagnostics,
  lsp_find_references,
  lsp_goto_definition,
  lsp_rename,
} from './tools';
import { lspManager } from './tools/lsp/client';
import { startTmuxCheck } from './utils';
import { log } from './utils/logger';

const OhMyOpenCodeLite: Plugin = async (ctx) => {
  const config = loadPluginConfig(ctx.directory);
  const agents = getAgentConfigs(config);

  // Parse tmux config with defaults
  const tmuxConfig: TmuxConfig = {
    enabled: config.tmux?.enabled ?? false,
    layout: config.tmux?.layout ?? 'main-vertical',
    main_pane_size: config.tmux?.main_pane_size ?? 60,
  };

  log('[plugin] initialized with tmux config', {
    tmuxConfig,
    rawTmuxConfig: config.tmux,
    directory: ctx.directory,
  });

  // Start background tmux check if enabled
  if (tmuxConfig.enabled) {
    startTmuxCheck();
  }

  const backgroundManager = new BackgroundTaskManager(ctx, tmuxConfig, config);
  const backgroundTools = createBackgroundTools(
    ctx,
    backgroundManager,
    tmuxConfig,
  );
  const mcps = createBuiltinMcps(config.disabled_mcps);

  // Initialize TmuxSessionManager to handle OpenCode's built-in Task tool sessions
  const tmuxSessionManager = new TmuxSessionManager(ctx, tmuxConfig);

  // Initialize auto-update checker hook
  const autoUpdateChecker = createAutoUpdateCheckerHook(ctx, {
    showStartupToast: true,
    autoUpdate: true,
  });

  // Initialize phase reminder hook for workflow compliance
  const phaseReminderHook = createPhaseReminderHook();

  // Initialize post-read nudge hook
  const postReadNudgeHook = createPostReadNudgeHook();

  // Setup graceful shutdown handlers
  const setupGracefulShutdown = () => {
    const shutdown = async (signal: string) => {
      log(`Received ${signal}, starting graceful shutdown...`);

      // Stop accepting new background tasks
      backgroundManager.pause();

      // Wait for running tasks with timeout
      try {
        await backgroundManager.drain({ timeout: 30000 });
        log('All background tasks completed or timed out');
      } catch {
        log('Warning: Some background tasks did not complete in time');
      }

      // Cleanup resources
      await tmuxSessionManager.cleanup();
      await lspManager.stopAll();

      log('Graceful shutdown complete');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  };

  setupGracefulShutdown();

  return {
    name: 'oh-my-opencode-slim',

    agent: agents,

    tool: {
      ...backgroundTools,
      lsp_goto_definition,
      lsp_find_references,
      lsp_diagnostics,
      lsp_rename,
      grep,
      ast_grep_search,
      ast_grep_replace,
    },

    mcp: mcps,

    config: async (opencodeConfig: Record<string, unknown>) => {
      (opencodeConfig as { default_agent?: string }).default_agent =
        'orchestrator';

      // Merge Agent configs
      if (!opencodeConfig.agent) {
        opencodeConfig.agent = { ...agents };
      } else {
        Object.assign(opencodeConfig.agent, agents);
      }
      const configAgent = opencodeConfig.agent as Record<string, unknown>;

      // Merge MCP configs
      const configMcp = opencodeConfig.mcp as
        | Record<string, unknown>
        | undefined;
      if (!configMcp) {
        opencodeConfig.mcp = { ...mcps };
      } else {
        Object.assign(configMcp, mcps);
      }

      // Get all MCP names from our config
      const allMcpNames = Object.keys(mcps);

      // For each agent, create permission rules based on their mcps list
      for (const [agentName, agentConfig] of Object.entries(agents)) {
        const agentMcps = (agentConfig as { mcps?: string[] })?.mcps;
        if (!agentMcps) continue;

        // Get or create agent permission config
        if (!configAgent[agentName]) {
          configAgent[agentName] = { ...agentConfig };
        }
        const agentConfigEntry = configAgent[agentName] as Record<
          string,
          unknown
        >;
        const agentPermission = (agentConfigEntry.permission ?? {}) as Record<
          string,
          unknown
        >;

        // Parse mcps list with wildcard and exclusion support
        const allowedMcps = parseList(agentMcps, allMcpNames);

        // Create permission rules for each MCP
        // MCP tools are named as <server>_<tool>, so we use <server>_*
        for (const mcpName of allMcpNames) {
          const sanitizedMcpName = mcpName.replace(/[^a-zA-Z0-9_-]/g, '_');
          const permissionKey = `${sanitizedMcpName}_*`;
          const action = allowedMcps.includes(mcpName) ? 'allow' : 'deny';

          // Only set if not already defined by user
          if (!(permissionKey in agentPermission)) {
            agentPermission[permissionKey] = action;
          }
        }

        // Update agent config with permissions
        agentConfigEntry.permission = agentPermission;
      }
    },

    event: async (input) => {
      // Handle auto-update checking
      autoUpdateChecker.event(input);

      // Handle tmux pane spawning for OpenCode's Task tool sessions
      await tmuxSessionManager.onSessionCreated(
        input.event as {
          type: string;
          properties?: {
            info?: { id?: string; parentID?: string; title?: string };
          };
        },
      );

      // Handle session.status events for:
      // 1. BackgroundTaskManager: completion detection
      // 2. TmuxSessionManager: pane cleanup
      await backgroundManager.handleSessionStatus(
        input.event as {
          type: string;
          properties?: { sessionID?: string; status?: { type: string } };
        },
      );
      await tmuxSessionManager.onSessionStatus(
        input.event as {
          type: string;
          properties?: { sessionID?: string; status?: { type: string } };
        },
      );
    },

    // Inject phase reminder before sending to API (doesn't show in UI)
    'experimental.chat.messages.transform':
      phaseReminderHook['experimental.chat.messages.transform'],

    // Nudge after file reads to encourage delegation
    'tool.execute.after': postReadNudgeHook['tool.execute.after'],

    // Inject background task status into parent session's system prompt.
    // Note: This hook only affects the main chat session's system prompt.
    // Background tasks run in isolated sessions with their own system prompts
    // (built inline via session.prompt with buildBackgroundTaskSystemPrompt),
    // so they do not receive this transform. This is intentional - background
    // tasks have dedicated constraints in their <BackgroundTask> XML block.
    'experimental.chat.system.transform': async (
      input: { sessionID: string },
      output: { system: string[] },
    ): Promise<void> => {
      // Early exit: skip all work if no background state exists
      if (!backgroundManager.hasAnyTaskStateForSession(input.sessionID)) {
        return;
      }

      const running = backgroundManager.getRunningTasksForSession(
        input.sessionID,
      );
      const pending = backgroundManager.getPendingRetrievalsForSession(
        input.sessionID,
      );

      if (running.length === 0 && pending.length === 0) return;

      const lines: string[] = [];
      for (const t of running) {
        lines.push(`- ${t.id}: ${t.description} (${t.agent}, running)`);
      }
      for (const t of pending) {
        lines.push(
          `- ${t.id}: completed, wait for notification then call background_output`,
        );
      }

      output.system.push(
        `\n<BackgroundTasks>\n${lines.join('\n')}\n</BackgroundTasks>`,
      );
    },
  };
};

export default OhMyOpenCodeLite;

export type {
  AgentName,
  AgentOverrideConfig,
  McpName,
  PluginConfig,
  TmuxConfig,
  TmuxLayout,
} from './config';
export type { RemoteMcpConfig } from './mcp';
