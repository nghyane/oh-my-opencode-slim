/**
 * Background Task Manager
 *
 * Manages long-running AI agent tasks that execute in separate sessions.
 * Background tasks run independently from the main conversation flow, allowing
 * the user to continue working while tasks complete asynchronously.
 *
 * Key features:
 * - Fire-and-forget launch (returns task_id immediately)
 * - Creates isolated sessions for background work
 * - Event-driven completion detection via session.status
 * - Start queue with configurable concurrency limit
 * - Supports task cancellation and result retrieval
 * - Atomic state transitions with versioning
 * - Centralized resource lifecycle management
 */

import { randomUUID } from 'node:crypto';

import type { PluginInput } from '@opencode-ai/plugin';
import { isSubagent } from '../agents';
import type { BackgroundTaskConfig, PluginConfig } from '../config';
import {
  BACKGROUND_MAX_RESULT_SIZE,
  BACKGROUND_RESULT_TRUNCATION_MESSAGE,
  SUBAGENT_NAMES,
} from '../config/constants';
import type { TmuxConfig } from '../config/schema';
import { applyAgentVariant, resolveAgentVariant } from '../utils';
import { log } from '../utils/logger';
import type { TmuxSessionManager } from './tmux-session-manager';

type OpencodeClient = PluginInput['client'];

/**
 * Prompt body interface for agent execution.
 * Extends the base PromptBody type with proper typing.
 */
interface AgentPromptBody {
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  system?: string;
  tools?: { [key: string]: boolean };
  parts: Array<{ type: 'text'; text: string }>;
  variant?: string;
}

/**
 * Notification state for atomic notification handling.
 */
type NotificationState = 'pending' | 'sending' | 'sent' | 'failed';

/**
 * Represents a background task running in an isolated session.
 * Tasks are tracked from creation through completion or failure.
 */
export interface BackgroundTask {
  id: string; // Unique task identifier (e.g., "bg_abc123")
  sessionId?: string; // OpenCode session ID (set when starting)
  description: string; // Human-readable task description
  agent: string; // Agent name handling the task
  status:
    | 'pending'
    | 'starting'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';
  stateVersion: number; // Incremented on each state change for atomic operations
  notificationState: NotificationState; // Atomic notification state
  result?: string; // Final output from the agent (when completed)
  error?: string; // Error message (when failed)
  isResultTruncated?: boolean; // Whether result was truncated due to size limit
  config: BackgroundTaskConfig; // Task configuration
  parentSessionId: string; // Parent session ID for notifications
  startedAt: Date; // Task creation timestamp
  completedAt?: Date; // Task completion/failure timestamp
  prompt: string; // Initial prompt
}

/**
 * Options for launching a new background task.
 */
export interface LaunchOptions {
  agent: string; // Agent to handle the task
  prompt: string; // Initial prompt to send to the agent
  description: string; // Human-readable task description
  parentSessionId: string; // Parent session ID for task hierarchy
}

/**
 * Discriminated union for task finalization outcomes.
 */
export type TaskOutcome =
  | { status: 'completed'; result: string }
  | { status: 'failed'; error: string; result?: string }
  | { status: 'cancelled'; result?: string };

/**
 * Tracks a notification that failed to send and is pending retry.
 */
interface PendingNotification {
  taskId: string;
  sessionId: string;
  message: string;
  attempts: number;
  timerId?: ReturnType<typeof setTimeout>;
}

/**
 * Disposable resource interface for cleanup registry.
 */
interface Disposable {
  dispose(): void;
}

/**
 * Centralized resource registry for task lifecycle management.
 * Ensures all resources (timers, resolvers, mappings) are properly cleaned up.
 */
class TaskResourceRegistry {
  private resources = new Map<string, Set<Disposable>>();

  register(taskId: string, resource: Disposable): void {
    const set = this.resources.get(taskId) ?? new Set();
    set.add(resource);
    this.resources.set(taskId, set);
  }

  cleanup(taskId: string): void {
    const set = this.resources.get(taskId);
    if (set) {
      for (const resource of set) {
        try {
          resource.dispose();
        } catch (err) {
          log('[task-resource-registry] dispose error', {
            taskId,
            error: String(err),
          });
        }
      }
      this.resources.delete(taskId);
    }
  }

  cleanupAll(): void {
    for (const [taskId] of this.resources) {
      this.cleanup(taskId);
    }
  }
}

/**
 * Timer wrapper that implements Disposable.
 */
class TimerDisposable implements Disposable {
  constructor(private timerId: ReturnType<typeof setTimeout> | undefined) {}

  dispose(): void {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = undefined;
    }
  }
}

/**
 * Resolver wrapper that implements Disposable.
 */
class ResolverDisposable implements Disposable {
  constructor(
    private taskId: string,
    private resolvers: Map<string, (task: BackgroundTask | null) => void>,
  ) {}

  dispose(): void {
    const resolver = this.resolvers.get(this.taskId);
    if (resolver) {
      resolver(null);
      this.resolvers.delete(this.taskId);
    }
  }
}

function generateTaskId(): string {
  return `bg_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export class BackgroundTaskManager {
  private static readonly VALID_TRANSITIONS: Record<string, readonly string[]> =
    {
      pending: ['starting', 'cancelled'],
      starting: ['running', 'failed', 'cancelled'],
      running: ['completed', 'failed', 'cancelled'],
    };

  private static readonly MAX_WAIT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  // Primary task storage
  private tasks = new Map<string, BackgroundTask>();

  // Secondary indices for O(1) lookups
  private tasksBySessionId = new Map<string, string>();
  private tasksByParentSession = new Map<string, Set<string>>();

  // Task eviction queue for memory management
  private taskEvictionQueue: string[] = [];
  private readonly maxCompletedTasks: number;

  // Pending retrievals by session
  private pendingRetrievals = new Set<string>();
  private pendingRetrievalsBySession = new Map<string, Set<string>>();

  private client: OpencodeClient;
  private directory: string;
  private tmuxEnabled: boolean;
  private pluginConfig?: PluginConfig;
  private taskConfig: BackgroundTaskConfig;
  private tmuxManager?: TmuxSessionManager;

  // Start queue with proper locking
  private startQueue: BackgroundTask[] = [];
  private startQueueSet = new Set<string>(); // O(1) lookup
  private activeStarts = 0;
  private maxConcurrentStarts: number;
  private queueLock = false;
  private pendingQueueProcess = false;

  // Completion waiting
  private completionResolvers = new Map<
    string,
    (task: BackgroundTask | null) => void
  >();

  // Notification retry
  private pendingNotifications = new Map<string, PendingNotification>();
  private readonly maxNotificationRetries = 3;
  private readonly notificationRetryDelays = [1000, 2000, 4000]; // ms

  // Orphaned task detection
  private orphanedSweepTimer?: ReturnType<typeof setInterval>;

  // Idle debounce - prevents premature completion detection
  private pendingIdleTasks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleDebounceMs = 500;

  // Resource registry for centralized cleanup
  private resourceRegistry = new TaskResourceRegistry();

  // Finalization lock to prevent concurrent finalization
  private finalizingTasks = new Set<string>();

  constructor(
    ctx: PluginInput,
    tmuxConfig?: TmuxConfig,
    config?: PluginConfig,
    tmuxManager?: TmuxSessionManager,
  ) {
    this.client = ctx.client;
    this.directory = ctx.directory;
    this.tmuxEnabled = tmuxConfig?.enabled ?? false;
    this.pluginConfig = config;
    this.taskConfig = config?.background ?? {
      maxConcurrentStarts: 10,
      maxCompletedTasks: 100,
    };
    this.maxConcurrentStarts = this.taskConfig.maxConcurrentStarts ?? 10;
    this.maxCompletedTasks = this.taskConfig.maxCompletedTasks ?? 100;
    this.tmuxManager = tmuxManager;

    // Orphan detection sweep every 60 seconds
    this.orphanedSweepTimer = setInterval(
      () => this.checkOrphanedSessions(),
      60000,
    );

    // Process exit cleanup
    const onExit = () => this.cleanup();
    process.once('exit', onExit);
    process.once('SIGINT', onExit);
    process.once('SIGTERM', onExit);
  }

  /**
   * Try to transition a task to a new status atomically with version check.
   * @returns true if transition was allowed, false if blocked
   */
  private tryTransition(
    task: BackgroundTask,
    newStatus: BackgroundTask['status'],
  ): boolean {
    const allowed = BackgroundTaskManager.VALID_TRANSITIONS[task.status];
    if (!allowed?.includes(newStatus)) {
      log('[background-manager] blocked transition', {
        taskId: task.id,
        from: task.status,
        to: newStatus,
      });
      return false;
    }

    const currentVersion = task.stateVersion;
    task.status = newStatus;
    task.stateVersion = currentVersion + 1;

    return true;
  }

  /**
   * Check if a task status is terminal (no more transitions allowed).
   */
  private isTerminal(status: BackgroundTask['status']): boolean {
    return (
      status === 'completed' || status === 'failed' || status === 'cancelled'
    );
  }

  /**
   * Get the current model for a session by fetching its most recent message.
   * This is more reliable than tracking via chat.message hook.
   */
  private async getSessionModel(
    sessionId: string,
  ): Promise<{ providerID: string; modelID: string } | undefined> {
    try {
      const messagesResult = await this.client.session.messages({
        path: { id: sessionId },
      });
      const messages = (messagesResult.data ?? []) as Array<{
        info?: {
          role: string;
          model?: { providerID: string; modelID: string };
          modelID?: string;
          providerID?: string;
        };
      }>;

      // Find the most recent message with model info (newest first)
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i].info;
        if (msg?.role === 'user' && msg.model) {
          return msg.model;
        }
        if (msg?.role === 'assistant' && msg.modelID && msg.providerID) {
          return { providerID: msg.providerID, modelID: msg.modelID };
        }
      }
    } catch {
      // Fall through to undefined
    }
    return undefined;
  }

  /**
   * Extract the last assistant message from a session.
   * Used to capture output even when task is cancelled or failed.
   */
  private async extractLastAssistantMessage(
    sessionId: string,
  ): Promise<string | undefined> {
    try {
      const messagesResult = await this.client.session.messages({
        path: { id: sessionId },
      });
      const messages = (messagesResult.data ?? []) as Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }>;

      // Find LAST assistant message (most recent)
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].info?.role === 'assistant') {
          const content: string[] = [];
          for (const part of messages[i].parts ?? []) {
            if (
              (part.type === 'text' || part.type === 'reasoning') &&
              part.text
            ) {
              content.push(part.text);
            }
          }
          if (content.length > 0) return content.join('\n\n');
        }
      }
    } catch (err) {
      log('[background-manager] extractLastAssistantMessage failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  }

  /**
   * Launch a new background task (fire-and-forget).
   *
   * Phase A (sync): Creates task record and returns immediately.
   * Phase B (async): Session creation and prompt sending happen in background.
   *
   * @param opts - Task configuration options
   * @returns The created background task with pending status
   */
  launch(opts: LaunchOptions): BackgroundTask {
    // Validate agent before creating task
    if (!isSubagent(opts.agent)) {
      throw new Error(
        `Invalid agent "${opts.agent}". Valid agents: ${SUBAGENT_NAMES.join(', ')}`,
      );
    }

    const task: BackgroundTask = {
      id: generateTaskId(),
      sessionId: undefined,
      description: opts.description,
      agent: opts.agent,
      status: 'pending',
      stateVersion: 0,
      notificationState: 'pending',
      startedAt: new Date(),
      config: {
        maxConcurrentStarts: this.maxConcurrentStarts,
        maxCompletedTasks: this.maxCompletedTasks,
      },
      parentSessionId: opts.parentSessionId,
      prompt: opts.prompt,
    };

    this.tasks.set(task.id, task);

    // Update secondary index
    const parentTasks =
      this.tasksByParentSession.get(opts.parentSessionId) ?? new Set();
    parentTasks.add(task.id);
    this.tasksByParentSession.set(opts.parentSessionId, parentTasks);

    // Queue task for background start
    this.enqueueStart(task);

    log(`[background-manager] task launched: ${task.id}`, {
      agent: opts.agent,
      description: opts.description,
    });

    return task;
  }

  /**
   * Enqueue task for background start.
   */
  private enqueueStart(task: BackgroundTask): void {
    this.startQueue.push(task);
    this.startQueueSet.add(task.id);
    this.processQueue();
  }

  /**
   * Process start queue with concurrency limit and proper locking.
   */
  private processQueue(): void {
    // Prevent concurrent queue processing
    if (this.queueLock) {
      this.pendingQueueProcess = true;
      return;
    }

    this.queueLock = true;

    try {
      while (
        this.activeStarts < this.maxConcurrentStarts &&
        this.startQueue.length > 0
      ) {
        const task = this.startQueue.shift();
        if (!task) break;

        this.startQueueSet.delete(task.id);

        if (!this.isTaskStartable(task)) continue;

        // Increment before async operation
        this.activeStarts++;

        // Fire-and-forget with proper cleanup
        this.startTask(task).finally(() => {
          this.activeStarts--;
          this.scheduleQueueProcess();
        });
      }
    } finally {
      this.queueLock = false;
      if (this.pendingQueueProcess) {
        this.pendingQueueProcess = false;
        this.processQueue();
      }
    }
  }

  /**
   * Schedule queue processing for after current task completes.
   */
  private scheduleQueueProcess(): void {
    // Use setImmediate to yield to event loop
    setImmediate(() => this.processQueue());
  }

  /**
   * Check if a task can be started (atomic check for pending/starting status).
   */
  private isTaskStartable(task: BackgroundTask): boolean {
    return task.status === 'pending' || task.status === 'starting';
  }

  /**
   * Start a task in the background (Phase B) with two-phase commit.
   */
  private async startTask(task: BackgroundTask): Promise<void> {
    // Phase 1: Pre-check and reserve slot atomically
    if (!this.reserveStartSlot(task)) {
      return;
    }

    let sessionId: string | undefined;

    try {
      // Create session
      const session = await this.client.session.create({
        body: {
          parentID: task.parentSessionId,
          title: `Background: ${task.description}`,
        },
        query: { directory: this.directory },
      });

      sessionId = session.data?.id;

      if (!sessionId) {
        throw new Error('Failed to create background session');
      }

      // Phase 2: Commit or rollback
      if (this.tryTransition(task, 'running')) {
        this.commitSessionMapping(task, sessionId);
      } else {
        await this.rollbackSessionCreation(sessionId);
        throw new Error('Task cancelled during startup');
      }

      // Give TmuxSessionManager time to spawn the pane
      if (this.tmuxEnabled) {
        await new Promise((r) => setTimeout(r, 500));
      }

      // Send prompt
      const promptQuery: Record<string, string> = { directory: this.directory };
      const resolvedVariant = resolveAgentVariant(
        this.pluginConfig,
        task.agent,
      );

      const promptBody: AgentPromptBody = {
        agent: task.agent,
        tools: { background_task: false, task: false },
        parts: [{ type: 'text', text: task.prompt }],
        system: this.buildBackgroundTaskSystemPrompt(task),
      };

      const bodyWithVariant = applyAgentVariant(resolvedVariant, promptBody);

      // Defensive: ensure background task constraints are preserved even if variant has system prompt
      const baseSystemPrompt = this.buildBackgroundTaskSystemPrompt(task);
      const finalSystem = bodyWithVariant.system
        ? `${baseSystemPrompt}\n\n<!-- Agent Variant System Prompt -->\n${bodyWithVariant.system}`
        : baseSystemPrompt;

      await this.client.session.prompt({
        path: { id: sessionId },
        body: { ...bodyWithVariant, system: finalSystem },
        query: promptQuery,
      });

      log(`[background-manager] task started: ${task.id}`, {
        sessionId,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.finalizeTask(task, { status: 'failed', error: errorMessage });
    } finally {
      this.releaseStartSlot(task);
    }
  }

  /**
   * Reserve a start slot atomically.
   */
  private reserveStartSlot(task: BackgroundTask): boolean {
    if (!this.isTaskStartable(task)) {
      return false;
    }
    if (!this.tryTransition(task, 'starting')) {
      return false;
    }
    return true;
  }

  /**
   * Release a start slot and process queue.
   */
  private releaseStartSlot(_task: BackgroundTask): void {
    // Queue processing is handled by the caller via scheduleQueueProcess
  }

  /**
   * Commit session mapping after successful transition to running.
   */
  private commitSessionMapping(task: BackgroundTask, sessionId: string): void {
    task.sessionId = sessionId;
    this.tasksBySessionId.set(sessionId, task.id);
  }

  /**
   * Rollback session creation on failure.
   */
  private async rollbackSessionCreation(sessionId: string): Promise<void> {
    try {
      await this.client.session.delete({ path: { id: sessionId } });
    } catch (err) {
      log('[background-manager] Failed to rollback session:', err);
    }
  }

  /**
   * Handle session.status events for completion detection.
   * Uses session.status instead of deprecated session.idle.
   */
  async handleSessionStatus(event: {
    type: string;
    properties?: { sessionID?: string; status?: { type: string } };
  }): Promise<void> {
    if (event.type !== 'session.status') return;

    const sessionId = event.properties?.sessionID;
    if (!sessionId) return;

    const taskId = this.tasksBySessionId.get(sessionId);
    if (!taskId) return;

    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;

    if (event.properties?.status?.type === 'idle') {
      // Check if already finalizing to prevent race
      if (this.finalizingTasks.has(taskId)) {
        return;
      }

      // Clear any existing pending timer
      const existingTimer = this.pendingIdleTasks.get(taskId);
      if (existingTimer) clearTimeout(existingTimer);

      // Add debounce to ensure the final assistant message is persisted
      const timer = setTimeout(() => {
        this.pendingIdleTasks.delete(taskId);
        // Re-check task is still running before resolving
        const currentTask = this.tasks.get(taskId);
        if (currentTask?.status === 'running') {
          this.resolveTaskSession(currentTask);
        }
      }, this.idleDebounceMs);

      this.pendingIdleTasks.set(taskId, timer);

      // Register timer for cleanup
      this.resourceRegistry.register(taskId, new TimerDisposable(timer));
    } else if (event.properties?.status?.type === 'busy') {
      // Cancel pending idle if session becomes busy again (agent is still working)
      const timer = this.pendingIdleTasks.get(taskId);
      if (timer) {
        clearTimeout(timer);
        this.pendingIdleTasks.delete(taskId);
      }
    }
  }

  /**
   * Resolve a completed session by extracting its result and finalizing the task.
   */
  private async resolveTaskSession(task: BackgroundTask): Promise<void> {
    if (!task.sessionId) return;

    // Check if already finalizing
    if (this.finalizingTasks.has(task.id)) {
      return;
    }

    // Re-check status - task might have been cancelled during await
    if (task.status !== 'running') return;

    try {
      const messagesResult = await this.client.session.messages({
        path: { id: task.sessionId },
      });
      const messages = (messagesResult.data ?? []) as Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }>;
      const assistantMessages = messages.filter(
        (m) => m.info?.role === 'assistant',
      );

      const extractedContent: string[] = [];
      for (const message of assistantMessages) {
        for (const part of message.parts ?? []) {
          if (
            (part.type === 'text' || part.type === 'reasoning') &&
            part.text
          ) {
            extractedContent.push(part.text);
          }
        }
      }

      const responseText = extractedContent
        .filter((t) => t.length > 0)
        .join('\n\n');

      const result = responseText || '(No output)';
      this.finalizeTask(task, { status: 'completed', result });
    } catch (error) {
      const lastMessage = await this.extractLastAssistantMessage(
        task.sessionId,
      );
      this.finalizeTask(task, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        result: lastMessage || '(Error occurred - no output)',
      });
    }
  }

  /**
   * Finalize a task with a typed outcome and notify waiting callers.
   * Uses compare-and-swap pattern to ensure atomic finalization.
   */
  private finalizeTask(task: BackgroundTask, outcome: TaskOutcome): void {
    // Prevent concurrent finalization
    if (this.finalizingTasks.has(task.id)) {
      return;
    }
    this.finalizingTasks.add(task.id);

    try {
      // Check if already finalized (completed or failed)
      if (task.status === 'completed' || task.status === 'failed') {
        return;
      }

      // If already cancelled and outcome is also cancelled, just ensure completedAt is set
      if (task.status === 'cancelled' && outcome.status === 'cancelled') {
        if (!task.completedAt) {
          task.completedAt = new Date();
        }
        return;
      }

      // Try to transition to the outcome status
      if (!this.tryTransition(task, outcome.status)) {
        return;
      }

      task.completedAt = new Date();

      if (outcome.status === 'completed') {
        const { wasTruncated, content } = this.truncateResult(outcome.result);
        task.result = content;
        task.isResultTruncated = wasTruncated;
      } else if (outcome.status === 'failed') {
        task.error = outcome.error;
        if (outcome.result) {
          const { wasTruncated, content } = this.truncateResult(outcome.result);
          task.result = content;
          task.isResultTruncated = wasTruncated;
        }
      } else if (outcome.status === 'cancelled' && outcome.result) {
        const { wasTruncated, content } = this.truncateResult(outcome.result);
        task.result = content;
        task.isResultTruncated = wasTruncated;
      }

      // Clean up idle timer if present
      const idleTimer = this.pendingIdleTasks.get(task.id);
      if (idleTimer) {
        clearTimeout(idleTimer);
        this.pendingIdleTasks.delete(task.id);
      }

      // Clean up tasksBySessionId map to prevent memory leak
      if (task.sessionId) {
        this.tasksBySessionId.delete(task.sessionId);
      }

      // Track finalized tasks for memory cleanup
      this.taskEvictionQueue.push(task.id);
      this.cleanupOldCompletedTasks();

      // Send notification to parent session
      if (task.parentSessionId) {
        this.sendCompletionNotification(task).catch((err) => {
          log(`[background-manager] notification failed: ${err}`);
        });
      }

      // Resolve waiting callers
      const resolver = this.completionResolvers.get(task.id);
      if (resolver) {
        resolver(task);
        this.completionResolvers.delete(task.id);
      }

      // Clean up all resources for this task
      this.resourceRegistry.cleanup(task.id);

      log(`[background-manager] task ${outcome.status}: ${task.id}`, {
        description: task.description,
      });
    } finally {
      this.finalizingTasks.delete(task.id);
    }
  }

  /**
   * Format completion notice - simple with status emoji.
   */
  private formatCompletionNotice(task: BackgroundTask): string {
    const [emoji, status] =
      task.status === 'completed'
        ? ['✓', 'completed']
        : task.status === 'cancelled'
          ? ['⊘', 'cancelled']
          : ['✗', 'failed'];

    return `${emoji} Task ${task.id} ${status}. Retrieve with: background_output task_id="${task.id}"`;
  }

  /**
   * Core notification delivery - the actual network call.
   * Shared between initial send and retry.
   */
  private async deliverNotification(
    sessionId: string,
    message: string,
  ): Promise<void> {
    const model = await this.getSessionModel(sessionId);
    await this.client.session.prompt({
      path: { id: sessionId },
      body: {
        model,
        parts: [{ type: 'text' as const, text: message }],
      },
    });
  }

  /**
   * Send completion notification to parent session with atomic state tracking.
   */
  private async sendCompletionNotification(
    task: BackgroundTask,
  ): Promise<void> {
    // Skip if already sent or in progress
    if (task.notificationState !== 'pending') {
      return;
    }

    // Skip notification if someone is waiting via background_output with timeout
    if (this.completionResolvers.has(task.id)) {
      return;
    }

    const key = `${task.parentSessionId}:${task.id}`;
    if (this.pendingNotifications.has(key)) {
      return;
    }

    // Mark as sending (atomic)
    task.notificationState = 'sending';

    // Check parent session health before sending
    if (!(await this.isParentSessionAlive(task.parentSessionId))) {
      log(
        `[background-manager] Parent session ${task.parentSessionId} is dead, cannot notify`,
      );
      task.notificationState = 'failed';
      return;
    }

    const message = this.formatCompletionNotice(task);

    try {
      await this.deliverNotification(task.parentSessionId, message);

      // Mark as sent only after successful delivery
      task.notificationState = 'sent';
      this.markAsPendingRetrieval(task.id);
    } catch {
      // Add to pending notifications for retry
      task.notificationState = 'pending'; // Allow retry
      this.pendingNotifications.set(key, {
        taskId: task.id,
        sessionId: task.parentSessionId,
        message,
        attempts: 0,
      });
      this.scheduleNotificationRetry(key);
    }
  }

  /**
   * Schedule a retry for a pending notification.
   */
  private scheduleNotificationRetry(key: string): void {
    const pending = this.pendingNotifications.get(key);
    if (!pending) return;

    if (pending.attempts >= this.maxNotificationRetries) {
      if (pending.timerId) clearTimeout(pending.timerId);

      // Mark task notification as failed
      const task = this.tasks.get(pending.taskId);
      if (task) {
        task.notificationState = 'failed';
      }

      this.pendingNotifications.delete(key);
      log(
        `[background-manager] notification permanently failed after ${pending.attempts} attempts: ${key}`,
      );
      return;
    }

    const delay = this.notificationRetryDelays[pending.attempts] ?? 4000;
    if (pending.timerId) clearTimeout(pending.timerId);

    try {
      pending.timerId = setTimeout(() => this.retryNotification(key), delay);
    } catch (err) {
      // If scheduling fails, clean up
      this.pendingNotifications.delete(key);
      log('[background-manager] Failed to schedule notification retry', {
        key,
        error: String(err),
      });
    }
  }

  /**
   * Retry a pending notification.
   */
  private async retryNotification(key: string): Promise<void> {
    const pending = this.pendingNotifications.get(key);
    if (!pending) return;

    pending.attempts++;

    try {
      await this.deliverNotification(pending.sessionId, pending.message);

      // Mark task as sent
      const task = this.tasks.get(pending.taskId);
      if (task) {
        task.notificationState = 'sent';
      }

      this.pendingNotifications.delete(key);
      this.markAsPendingRetrieval(pending.taskId);
      log(`[background-manager] notification retry succeeded: ${key}`);
    } catch {
      this.scheduleNotificationRetry(key);
    }
  }

  /**
   * Get all running background tasks for a specific parent session.
   * Uses O(1) secondary index lookup.
   *
   * @param parentSessionId - The parent session ID to filter by
   * @returns Array of task info objects with id, description, agent, and status
   */
  getRunningTasksForSession(
    parentSessionId: string,
  ): Array<{ id: string; description: string; agent: string; status: string }> {
    const taskIds = this.tasksByParentSession.get(parentSessionId);
    if (!taskIds) return [];

    const tasks: Array<{
      id: string;
      description: string;
      agent: string;
      status: string;
    }> = [];

    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId);
      if (task && task.status === 'running') {
        tasks.push({
          id: task.id,
          description: task.description,
          agent: task.agent,
          status: task.status,
        });
      }
    }

    return tasks;
  }

  /**
   * Build system prompt for background tasks.
   * Ensures task constraints are preserved.
   */
  private buildBackgroundTaskSystemPrompt(task: BackgroundTask): string {
    return `You are executing a background task.

Task ID: ${task.id}
Agent: ${task.agent}
Description: ${task.description}

Constraints:
- Return your output when complete - this will be returned to the user
- Do NOT use background_task or task tools - this is already a background task
- Focus on the task goal: ${task.prompt.slice(0, 200)}${task.prompt.length > 200 ? '...' : ''}`;
  }

  /**
   * Retrieve the current state of a background task.
   *
   * @param taskId - The task ID to retrieve
   * @returns The task object, or null if not found
   */
  getResult(taskId: string): BackgroundTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  /**
   * Wait for a task to complete.
   *
   * @param taskId - The task ID to wait for
   * @param timeout - Maximum time to wait in milliseconds (0 = no timeout)
   * @returns The completed task, or null if not found/timeout
   */
  async waitForCompletion(
    taskId: string,
    timeout = 0,
  ): Promise<BackgroundTask | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    if (this.isTerminal(task.status)) {
      return task;
    }

    return new Promise((resolve) => {
      let timerId: ReturnType<typeof setTimeout> | undefined;

      const resolver = (t: BackgroundTask | null) => {
        if (timerId) clearTimeout(timerId);
        resolve(t);
      };

      this.completionResolvers.set(taskId, resolver);

      // Register resolver for cleanup
      this.resourceRegistry.register(
        taskId,
        new ResolverDisposable(taskId, this.completionResolvers),
      );

      // Re-check: task may have completed between status check and resolver registration
      const currentTask = this.tasks.get(taskId);
      if (currentTask && this.isTerminal(currentTask.status)) {
        this.completionResolvers.delete(taskId);
        if (timerId) clearTimeout(timerId);
        resolve(currentTask);
        return;
      }

      const effectiveTimeout =
        timeout > 0 ? timeout : BackgroundTaskManager.MAX_WAIT_TIMEOUT_MS;

      if (effectiveTimeout > 0) {
        timerId = setTimeout(() => {
          this.completionResolvers.delete(taskId);

          // On timeout, mark task as failed
          const currentTask = this.tasks.get(taskId);
          if (currentTask && !this.isTerminal(currentTask.status)) {
            this.finalizeTask(currentTask, {
              status: 'failed',
              error: `Wait timeout exceeded (${effectiveTimeout}ms)`,
            });
          }

          resolve(this.tasks.get(taskId) ?? null);
        }, effectiveTimeout);
      }
    });
  }

  /**
   * Cancel one or all running background tasks.
   *
   * @param taskId - Optional task ID to cancel. If omitted, cancels all pending/running tasks.
   * @returns Number of tasks cancelled
   */
  cancel(taskId?: string): number {
    if (taskId) {
      const task = this.tasks.get(taskId);
      return task && this.doCancelSingleTask(task) ? 1 : 0;
    }

    let count = 0;
    for (const task of this.tasks.values()) {
      if (this.doCancelSingleTask(task)) count++;
    }
    return count;
  }

  /**
   * Cancel a single task. Extracted to avoid code duplication.
   * @returns true if task was cancelled, false if it wasn't cancellable
   */
  private doCancelSingleTask(task: BackgroundTask): boolean {
    // Clean up idle timer if present
    const idleTimer = this.pendingIdleTasks.get(task.id);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.pendingIdleTasks.delete(task.id);
    }

    // Check if cancellable
    if (!['pending', 'starting', 'running'].includes(task.status)) {
      return false;
    }

    // Check if in start queue before marking cancelled
    const inStartQueue = task.status === 'pending';

    // Try to mark as cancelled FIRST to prevent race with startTask
    if (!this.tryTransition(task, 'cancelled')) {
      return false;
    }

    // Remove from start queue if pending (O(1) with Set)
    if (inStartQueue && this.startQueueSet.has(task.id)) {
      this.startQueue = this.startQueue.filter((t) => t.id !== task.id);
      this.startQueueSet.delete(task.id);
    }

    // Clean up the session if one was created
    if (task.sessionId) {
      this.client.session
        .delete({ path: { id: task.sessionId } })
        .catch((err) =>
          log('[background-manager] Failed to delete session:', err),
        );

      // Close TMUX pane if tmux is enabled
      try {
        this.tmuxManager?.closeBySessionId(task.sessionId);
      } catch (err) {
        log('[background-manager] Failed to close TMUX pane', {
          taskId: task.id,
          error: err,
        });
      }

      // Extract last assistant message before deleting session
      this.extractLastAssistantMessage(task.sessionId)
        .then((lastMessage) => {
          this.finalizeTask(task, {
            status: 'cancelled',
            result: lastMessage || '(Task cancelled - no output)',
          });
        })
        .catch(() => {
          this.finalizeTask(task, { status: 'cancelled' });
        });
    } else {
      this.finalizeTask(task, { status: 'cancelled' });
    }
    return true;
  }

  /**
   * Truncate result if it exceeds the size limit.
   * @returns Object with truncation flag and the (possibly truncated) content
   */
  private truncateResult(result: string): {
    wasTruncated: boolean;
    content: string;
  } {
    if (result.length <= BACKGROUND_MAX_RESULT_SIZE) {
      return { wasTruncated: false, content: result };
    }
    const maxContentLength = Math.max(
      0,
      BACKGROUND_MAX_RESULT_SIZE - BACKGROUND_RESULT_TRUNCATION_MESSAGE.length,
    );
    const truncatedContent =
      result.slice(0, maxContentLength) + BACKGROUND_RESULT_TRUNCATION_MESSAGE;
    return { wasTruncated: true, content: truncatedContent };
  }

  /**
   * Get all pending retrievals (completed tasks with notifications sent but not retrieved)
   * Uses O(1) secondary index lookup.
   */
  getPendingRetrievalsForSession(sessionId: string): BackgroundTask[] {
    const taskIds = this.pendingRetrievalsBySession.get(sessionId);
    if (!taskIds) return [];

    const results: BackgroundTask[] = [];
    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId);
      if (task) {
        results.push(task);
      }
    }
    return results;
  }

  /**
   * Check if any background tasks exist for a given parent session.
   * Uses O(1) secondary index lookup.
   */
  hasAnyTaskStateForSession(parentSessionId: string): boolean {
    return this.tasksByParentSession.has(parentSessionId);
  }

  /**
   * Mark a task as pending retrieval (notification sent, waiting for background_output)
   */
  markAsPendingRetrieval(taskId: string): void {
    this.pendingRetrievals.add(taskId);

    const task = this.tasks.get(taskId);
    if (task) {
      const sessionSet =
        this.pendingRetrievalsBySession.get(task.parentSessionId) ?? new Set();
      sessionSet.add(taskId);
      this.pendingRetrievalsBySession.set(task.parentSessionId, sessionSet);
    }
  }

  /**
   * Clear a task from pending retrieval (background_output was called)
   */
  clearPendingRetrieval(taskId: string): void {
    this.pendingRetrievals.delete(taskId);

    const task = this.tasks.get(taskId);
    if (task) {
      const sessionSet = this.pendingRetrievalsBySession.get(
        task.parentSessionId,
      );
      if (sessionSet) {
        sessionSet.delete(taskId);
        if (sessionSet.size === 0) {
          this.pendingRetrievalsBySession.delete(task.parentSessionId);
        }
      }
    }
  }

  /**
   * Check if parent session is still alive.
   * @returns true if session exists and is accessible
   */
  private async isParentSessionAlive(sessionId: string): Promise<boolean> {
    try {
      await this.client.session.messages({ path: { id: sessionId } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Periodic sweep to detect orphaned tasks.
   * Handles cases where parent session is deleted or task is stuck.
   */
  private async checkOrphanedSessions(): Promise<void> {
    const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

    // Check both running and starting tasks
    for (const [sessionId, taskId] of this.tasksBySessionId) {
      const task = this.tasks.get(taskId);
      if (!task || (task.status !== 'running' && task.status !== 'starting'))
        continue;

      // Skip if already finalizing
      if (this.finalizingTasks.has(taskId)) continue;

      try {
        // Check if parent session still exists
        await this.client.session.messages({
          path: { id: task.parentSessionId },
        });

        // Check if task is stuck (running too long)
        if (Date.now() - task.startedAt.getTime() > TIMEOUT_MS) {
          const lastMessage = await this.extractLastAssistantMessage(sessionId);
          this.finalizeTask(task, {
            status: 'failed',
            error: `Task timed out after ${Math.round(TIMEOUT_MS / 60000)} minutes`,
            result: lastMessage,
          });
        }
      } catch {
        // Parent session is gone - finalize as orphaned
        const lastMessage = await this.extractLastAssistantMessage(sessionId);
        this.finalizeTask(task, {
          status: 'failed',
          error: 'Parent session was deleted while task was running',
          result: lastMessage,
        });
      }
    }
  }

  /**
   * Clean up all tasks.
   */
  cleanup(): void {
    // Cancel all pending notification timers before clearing
    for (const [, pending] of this.pendingNotifications) {
      if (pending.timerId) {
        clearTimeout(pending.timerId);
      }
    }

    // Clear pending idle debounce timers
    for (const timer of this.pendingIdleTasks.values()) {
      clearTimeout(timer);
    }
    this.pendingIdleTasks.clear();

    // Clear orphaned task detection sweep
    if (this.orphanedSweepTimer) {
      clearInterval(this.orphanedSweepTimer);
    }

    // Clean up all resources
    this.resourceRegistry.cleanupAll();

    this.startQueue = [];
    this.startQueueSet.clear();

    for (const [, resolver] of this.completionResolvers) {
      resolver(null);
    }
    this.completionResolvers.clear();

    this.activeStarts = 0;
    this.tasks.clear();
    this.tasksBySessionId.clear();
    this.tasksByParentSession.clear();
    this.taskEvictionQueue = [];
    this.pendingNotifications.clear();
    this.pendingRetrievals.clear();
    this.pendingRetrievalsBySession.clear();
  }

  /**
   * Remove oldest finalized tasks when limit is exceeded.
   */
  private cleanupOldCompletedTasks(): void {
    // Clean stale entries from eviction queue first
    this.taskEvictionQueue = this.taskEvictionQueue.filter((id) =>
      this.tasks.has(id),
    );

    while (this.taskEvictionQueue.length > this.maxCompletedTasks) {
      const oldestTaskId = this.taskEvictionQueue.shift();
      if (oldestTaskId) {
        const task = this.tasks.get(oldestTaskId);
        if (task) {
          // Clear from pending retrievals
          this.clearPendingRetrieval(oldestTaskId);

          // Clear result and error before eviction to free memory
          task.result = undefined;
          task.error = undefined;

          if (task.sessionId) {
            // Delete the session from the server to prevent session leaks
            this.client.session
              .delete({ path: { id: task.sessionId } })
              .catch((err) =>
                log(
                  '[background-manager] Failed to delete session during eviction:',
                  err,
                ),
              );
            this.tasksBySessionId.delete(task.sessionId);
          }

          // Remove from parent session index
          const parentSet = this.tasksByParentSession.get(task.parentSessionId);
          if (parentSet) {
            parentSet.delete(oldestTaskId);
            if (parentSet.size === 0) {
              this.tasksByParentSession.delete(task.parentSessionId);
            }
          }

          this.tasks.delete(oldestTaskId);
        }
      }
    }
  }

  /**
   * Pause accepting new tasks (for graceful shutdown)
   */
  pause(): void {
    log('[background-manager] Pausing new task acceptance');
    (this as unknown as { _paused: boolean })._paused = true;
  }

  /**
   * Resume accepting new tasks
   */
  resume(): void {
    log('[background-manager] Resuming task acceptance');
    (this as unknown as { _paused: boolean })._paused = false;
  }

  /**
   * Wait for all running tasks to complete (with timeout)
   */
  async drain(options: { timeout?: number } = {}): Promise<void> {
    const { timeout = 30000 } = options;
    const startTime = Date.now();

    log('[background-manager] Draining tasks...');

    while (Date.now() - startTime < timeout) {
      const runningTasks = Array.from(this.tasks.values()).filter(
        (t) => t.status === 'running' || t.status === 'starting',
      );

      if (runningTasks.length === 0) {
        log('[background-manager] All tasks completed');
        return;
      }

      log(`[background-manager] Waiting for ${runningTasks.length} tasks...`);
      await new Promise((r) => setTimeout(r, 1000));
    }

    throw new Error(`Drain timeout after ${timeout}ms`);
  }

  /**
   * Save task state to disk for recovery
   */
  async saveState(): Promise<void> {
    const { TaskPersistence } = await import('./persistence');
    const persistence = new TaskPersistence(process.cwd());
    await persistence.save(this.tasks);
    log('[background-manager] Task state saved');
  }

  /**
   * Load task state from disk (for recovery after crash)
   */
  async loadState(): Promise<void> {
    const { TaskPersistence } = await import('./persistence');
    const persistence = new TaskPersistence(process.cwd());
    const savedTasks = await persistence.load();

    for (const [taskId, taskData] of savedTasks) {
      const task = taskData as {
        id: string;
        sessionId?: string;
        description: string;
        agent: string;
        status: BackgroundTask['status'];
        stateVersion?: number;
        notificationState?: NotificationState;
        result?: string;
        error?: string;
        isResultTruncated?: boolean;
        parentSessionId: string;
        startedAt: string;
        completedAt?: string;
        prompt: string;
        config?: { maxConcurrentStarts: number; maxCompletedTasks: number };
      };

      if (task.status === 'running' || task.status === 'starting') {
        // Mark as failed since we can't recover the actual execution
        log(`[background-manager] Marking recovered task ${taskId} as failed`);
        task.status = 'failed';
        task.error = 'Task interrupted by process restart';
        task.completedAt = new Date().toISOString();
      }

      // Restore to memory with proper Date conversion
      const restoredTask: BackgroundTask = {
        id: task.id,
        sessionId: task.sessionId,
        description: task.description,
        agent: task.agent,
        status: task.status,
        stateVersion: task.stateVersion ?? 0,
        notificationState: task.notificationState ?? 'pending',
        result: task.result,
        error: task.error,
        isResultTruncated: task.isResultTruncated,
        parentSessionId: task.parentSessionId,
        startedAt: new Date(task.startedAt),
        completedAt: task.completedAt ? new Date(task.completedAt) : undefined,
        prompt: task.prompt,
        config: task.config ?? {
          maxConcurrentStarts: this.maxConcurrentStarts,
          maxCompletedTasks: this.maxCompletedTasks,
        },
      };

      this.tasks.set(taskId, restoredTask);

      // Restore secondary indices
      const parentSet =
        this.tasksByParentSession.get(restoredTask.parentSessionId) ??
        new Set();
      parentSet.add(taskId);
      this.tasksByParentSession.set(restoredTask.parentSessionId, parentSet);

      if (restoredTask.sessionId) {
        this.tasksBySessionId.set(restoredTask.sessionId, taskId);
      }
    }

    log(
      `[background-manager] Loaded ${savedTasks.size} tasks from persistence`,
    );
  }
}
