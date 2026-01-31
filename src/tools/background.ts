import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundTask, BackgroundTaskManager } from '../background';
import { SUBAGENT_NAMES } from '../config';
import type { TmuxConfig } from '../config/schema';

const z = tool.schema;

// Constants
const SYNC_TIMEOUT_MS = 30_000;
const LARGE_RESULT_THRESHOLD = 5000;

/**
 * Formats duration between start and end time
 */
function formatDuration(startedAt: Date, completedAt?: Date): string {
  const end = completedAt ?? new Date();
  return `${Math.floor((end.getTime() - startedAt.getTime()) / 1000)}s`;
}

/**
 * Formats task result for output
 */
function formatTaskOutput(task: BackgroundTask): string {
  const duration = formatDuration(task.startedAt, task.completedAt);
  const resultLen = task.result?.length ?? 0;

  const lines = [
    `Task: ${task.id}`,
    `Status: ${task.status}`,
    `Description: ${task.description}`,
    `Duration: ${duration}`,
    `Result Size: ${resultLen} bytes`,
  ];

  if (task.isResultTruncated) {
    lines.push('Result truncated due to size limit.');
  }

  lines.push('');

  switch (task.status) {
    case 'completed':
      if (task.result != null) lines.push(task.result);
      break;
    case 'failed':
      lines.push(`Error: ${task.error}`);
      break;
    case 'cancelled':
      lines.push('(Task cancelled)');
      break;
  }

  if (resultLen > LARGE_RESULT_THRESHOLD) {
    lines.push(
      '[Tip: Extract key findings and discard this output to free context.]',
    );
  }

  return lines.join('\n');
}

/**
 * Handles synchronous wait for task completion
 */
async function handleSyncWait(
  manager: BackgroundTaskManager,
  taskId: string,
): Promise<string | undefined> {
  const completed = await manager.waitForCompletion(taskId, SYNC_TIMEOUT_MS);

  if (
    !completed ||
    !['completed', 'failed', 'cancelled'].includes(completed.status)
  ) {
    return undefined;
  }

  manager.clearPendingRetrieval(taskId);
  const duration = formatDuration(completed.startedAt, completed.completedAt);

  switch (completed.status) {
    case 'completed':
      return completed.result ?? `Task completed (${duration})`;
    case 'failed':
      return `Task failed (${duration}): ${completed.error}`;
    case 'cancelled':
      return `Task cancelled (${duration})`;
  }
}

/**
 * Creates background task management tools for the plugin.
 */
export function createBackgroundTools(
  _ctx: PluginInput,
  manager: BackgroundTaskManager,
  _tmuxConfig?: TmuxConfig,
): Record<string, ToolDefinition> {
  const agentNames = SUBAGENT_NAMES.join(', ');

  const background_task = tool({
    description: `Launch async agent task.

FLOW: launch → FORGET → notification → retrieve

⚠️ NEVER call background_output before notification (throws error)

Agents: ${agentNames}

Max 10 concurrent.`,

    args: {
      description: z
        .string()
        .describe('Short description of the task (5-10 words)'),
      prompt: z.string().describe('The task prompt for the agent'),
      agent: z.string().describe(`Agent to use: ${agentNames}`),
      wait: z
        .boolean()
        .optional()
        .describe(
          'If true, block until task completes and return result directly (for short tasks <30s). Skips notification.',
        ),
    },
    async execute(args, toolContext) {
      if (!toolContext || typeof toolContext !== 'object') {
        throw new Error('Invalid toolContext: expected object');
      }

      const agent = String(args.agent);
      const prompt = String(args.prompt);
      const description = String(args.description);
      const wait = args.wait === true;

      const task = manager.launch({
        agent,
        prompt,
        description,
        parentSessionId: toolContext.sessionID,
      });

      if (wait) {
        const result = await handleSyncWait(manager, task.id);
        if (result !== undefined) {
          return result;
        }
      }

      return `Task ${task.id} launched.`;
    },
  });

  const background_output = tool({
    description: `Get results from completed background task.

⚠️ ONLY call AFTER notification (throws error if before)

✅ launch → notification → background_output
❌ launch → background_output              // Too soon
❌ launch → background_output → ...        // Polling`,

    args: {
      task_id: z
        .string()
        .regex(/^bg_[a-f0-9]{8}$/, {
          message:
            'Task ID must be a valid background task ID (e.g., bg_abc123de)',
        })
        .describe('Task ID from the completion notification'),
    },
    async execute(args) {
      const taskId = String(args.task_id);
      const task = manager.getResult(taskId);

      if (!task) {
        throw new Error(
          `Task not found: ${taskId}. Task may have been cleared or ID is invalid.`,
        );
      }

      if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
        const elapsed = Math.floor(
          (Date.now() - task.startedAt.getTime()) / 1000,
        );
        throw new Error(
          `Task ${taskId} is ${task.status} (${elapsed}s).\n\n` +
            '⚠️ STOP POLLING.\n' +
            'Wait for notification, then call background_output.',
        );
      }

      manager.clearPendingRetrieval(taskId);
      return formatTaskOutput(task);
    },
  });

  const background_cancel = tool({
    description: `Cancel background task(s).

Use when:
- Task is no longer needed
- Task is stuck/running too long
- Cleaning up resources

Only cancels pending/starting/running tasks (not completed/failed).`,
    args: {
      task_id: z
        .string()
        .regex(/^bg_[a-f0-9]{8}$/, {
          message:
            'Task ID must be a valid background task ID (e.g., bg_abc123de)',
        })
        .optional()
        .describe('Specific task to cancel'),
      all: z.boolean().optional().describe('Cancel all running tasks'),
    },
    async execute(args) {
      if (args.all === true) {
        const count = await manager.cancel();
        return `Cancelled ${count} task(s).`;
      }

      if (typeof args.task_id === 'string') {
        const count = await manager.cancel(args.task_id);
        return count > 0
          ? `Cancelled task ${args.task_id}.`
          : `Task ${args.task_id} not found or not running.`;
      }

      return 'Specify task_id or use all=true.';
    },
  });

  return { background_task, background_output, background_cancel };
}
