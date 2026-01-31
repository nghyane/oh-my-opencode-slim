import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundTaskManager } from '../background';
import { SUBAGENT_NAMES } from '../config';
import type { TmuxConfig } from '../config/schema';

const z = tool.schema;

/**
 * Creates background task management tools for the plugin.
 * @param _ctx - Plugin input context
 * @param manager - Background task manager for launching and tracking tasks
 * @param _tmuxConfig - Optional tmux configuration for session management
 * @returns Object containing background_task, background_output, and background_cancel tools
 */
export function createBackgroundTools(
  _ctx: PluginInput,
  manager: BackgroundTaskManager,
  _tmuxConfig?: TmuxConfig,
): Record<string, ToolDefinition> {
  const agentNames = SUBAGENT_NAMES.join(', ');

  // Tool for launching agent tasks (fire-and-forget)
  const background_task = tool({
    description: `Launch an agent task that runs asynchronously.

WORKFLOW:
1. Call background_task → get task_id
2. Continue with other work OR stop and wait
3. System will notify you when the task completes
4. Call background_output with task_id to get results

Available agents: ${agentNames}

Max 10 concurrent tasks.`,

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

      // Fire-and-forget launch
      const task = manager.launch({
        agent,
        prompt,
        description,
        parentSessionId: toolContext.sessionID,
      });

      // Synchronous mode: wait for completion and return result directly
      if (wait) {
        const completed = await manager.waitForCompletion(task.id, 30_000);
        if (
          completed &&
          (completed.status === 'completed' ||
            completed.status === 'failed' ||
            completed.status === 'cancelled')
        ) {
          manager.clearPendingRetrieval(task.id);
          const duration = completed.completedAt
            ? `${Math.floor((completed.completedAt.getTime() - completed.startedAt.getTime()) / 1000)}s`
            : 'unknown';
          if (completed.status === 'completed' && completed.result != null) {
            return completed.result;
          }
          if (completed.status === 'failed') {
            return `Task failed (${duration}): ${completed.error}`;
          }
          return `Task ${completed.status} (${duration})`;
        }
        // Timeout: fall through to async mode
      }

      return `Task ${task.id} launched.`;
    },
  });

  // Tool for retrieving output from background tasks
  const background_output = tool({
    description: `Get results from a completed background task.

Call ONLY after the system notifies you the task is complete.
Calling while running will throw an error.

Returns task status, results, or error information.`,

    args: {
      task_id: z
        .string()
        .describe('Task ID from the "[Background Task Complete]" notification'),
    },
    async execute(args) {
      const taskId = String(args.task_id);

      const task = manager.getResult(taskId);

      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      // STRICT PROTOCOL ENFORCEMENT: Task must be in terminal state
      // This means the notification MUST have been sent first
      if (
        task.status !== 'completed' &&
        task.status !== 'failed' &&
        task.status !== 'cancelled'
      ) {
        const elapsed = Math.floor(
          (Date.now() - task.startedAt.getTime()) / 1000,
        );
        throw new Error(
          `Task ${taskId} is still ${task.status} (elapsed: ${elapsed}s).\n\n` +
            `Stop and wait. The system will notify you when the task completes.`,
        );
      }

      // Calculate task duration
      const duration = task.completedAt
        ? `${Math.floor(
            (task.completedAt.getTime() - task.startedAt.getTime()) / 1000,
          )}s`
        : `${Math.floor((Date.now() - task.startedAt.getTime()) / 1000)}s`;

      // Clear pending retrieval since we're retrieving now
      manager.clearPendingRetrieval(taskId);

      let output = `Task: ${task.id}
Status: ${task.status}
Description: ${task.description}
Duration: ${duration}
Result Size: ${task.result?.length ?? 0} bytes
${task.isResultTruncated ? 'Result truncated due to size limit.' : ''}
`;

      // Include task result or error based on status
      if (task.status === 'completed' && task.result != null) {
        output += task.result;
      } else if (task.status === 'failed') {
        output += `Error: ${task.error}`;
      } else if (task.status === 'cancelled') {
        output += '(Task cancelled)';
      }

      // Hint for large results to encourage context cleanup
      const resultLen = task.result?.length ?? 0;
      if (resultLen > 5000) {
        output +=
          '\n\n[Tip: Extract key findings and discard this output to free context.]';
      }

      return output;
    },
  });

  // Tool for canceling running background tasks
  const background_cancel = tool({
    description: `Cancel background task(s).

task_id: cancel specific task
all=true: cancel all running tasks

Only cancels pending/starting/running tasks.`,
    args: {
      task_id: z.string().optional().describe('Specific task to cancel'),
      all: z.boolean().optional().describe('Cancel all running tasks'),
    },
    async execute(args) {
      // Cancel all running tasks if requested
      if (args.all === true) {
        const count = manager.cancel();
        return `Cancelled ${count} task(s).`;
      }

      // Cancel specific task if task_id provided
      if (typeof args.task_id === 'string') {
        const count = manager.cancel(args.task_id);
        return count > 0
          ? `Cancelled task ${args.task_id}.`
          : `Task ${args.task_id} not found or not running.`;
      }

      return 'Specify task_id or use all=true.';
    },
  });

  return { background_task, background_output, background_cancel };
}
