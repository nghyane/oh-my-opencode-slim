/**
 * Atomic State Machine with Recovery
 *
 * Provides atomic state transitions with compare-and-swap versioning,
 * recovery paths on failure, and event emission for all transitions.
 */

import type { BackgroundTask } from './background-manager';
import { TaskEventBus } from './events';

/**
 * State definition with transition rules and hooks.
 */
export interface StateDefinition {
  readonly allowedTransitions: readonly string[];
  readonly isTerminal: boolean;
  readonly onEnter?: (task: BackgroundTask) => Promise<void> | void;
  readonly onExit?: (task: BackgroundTask) => Promise<void> | void;
  readonly timeoutMs?: number;
  readonly recoveryState?: string;
}

/**
 * Result of a state transition attempt.
 */
export interface TransitionResult {
  success: boolean;
  reason?:
    | 'INVALID_TRANSITION'
    | 'EXIT_HOOK_FAILED'
    | 'ENTER_HOOK_FAILED'
    | 'VERSION_MISMATCH';
  error?: Error;
  previousState?: string;
  newState?: string;
}

/**
 * Default state definitions for background tasks.
 */
export const STATE_DEFINITIONS: Record<string, StateDefinition> = {
  pending: {
    allowedTransitions: ['starting', 'cancelled'],
    isTerminal: false,
    timeoutMs: 60000,
    recoveryState: 'cancelled',
  },
  starting: {
    allowedTransitions: ['running', 'failed', 'cancelled'],
    isTerminal: false,
    timeoutMs: 30000,
    recoveryState: 'failed',
  },
  running: {
    allowedTransitions: ['completed', 'failed', 'cancelled'],
    isTerminal: false,
    timeoutMs: 30 * 60 * 1000,
    recoveryState: 'failed',
  },
  completed: {
    allowedTransitions: [],
    isTerminal: true,
  },
  failed: {
    allowedTransitions: [],
    isTerminal: true,
  },
  cancelled: {
    allowedTransitions: [],
    isTerminal: true,
  },
};

/**
 * Global event bus instance for state transitions.
 */
export const globalEventBus = new TaskEventBus();

/**
 * Atomic state machine for background task lifecycle management.
 *
 * Features:
 * - Compare-and-swap (CAS) for atomic transitions with version checking
 * - Recovery states when onEnter hooks fail
 * - Event emission for all state changes
 * - Support for custom state definitions
 */
export class AtomicStateMachine {
  private stateDefinitions: Record<string, StateDefinition>;

  constructor(
    definitions: Record<string, StateDefinition> = STATE_DEFINITIONS,
  ) {
    this.stateDefinitions = definitions;
  }

  /**
   * Attempt atomic state transition with compare-and-swap.
   */
  async transition(
    task: BackgroundTask,
    newStatus: string,
    context?: { error?: Error; result?: string; truncated?: boolean },
  ): Promise<TransitionResult> {
    const currentVersion = task.stateVersion;
    const currentDef = this.stateDefinitions[task.status];
    const newDef = this.stateDefinitions[newStatus];

    if (!newDef) {
      return {
        success: false,
        reason: 'INVALID_TRANSITION',
        previousState: task.status,
      };
    }

    if (!currentDef.allowedTransitions.includes(newStatus)) {
      return {
        success: false,
        reason: 'INVALID_TRANSITION',
        previousState: task.status,
      };
    }

    if (currentDef.onExit) {
      try {
        await currentDef.onExit(task);
      } catch (error) {
        return {
          success: false,
          reason: 'EXIT_HOOK_FAILED',
          error: error as Error,
          previousState: task.status,
        };
      }
    }

    if (task.stateVersion !== currentVersion) {
      return {
        success: false,
        reason: 'VERSION_MISMATCH',
        previousState: task.status,
      };
    }

    const previousState = task.status;
    task.status = newStatus as BackgroundTask['status'];
    task.stateVersion = currentVersion + 1;

    if (context?.error) {
      task.error = context.error.message;
    }
    if (context?.result !== undefined) {
      task.result = context.result;
    }
    if (context?.truncated !== undefined) {
      task.isResultTruncated = context.truncated;
    }

    if (newDef.onEnter) {
      try {
        await newDef.onEnter(task);
      } catch (error) {
        if (newDef.recoveryState && newDef.recoveryState !== newStatus) {
          task.status = newDef.recoveryState as BackgroundTask['status'];
          task.stateVersion = currentVersion + 2;
          task.error = `Enter hook failed, recovered to ${newDef.recoveryState}: ${(error as Error).message}`;
        }

        return {
          success: false,
          reason: 'ENTER_HOOK_FAILED',
          error: error as Error,
          previousState,
          newState: task.status,
        };
      }
    }

    globalEventBus.emit({
      type: 'task.transition',
      taskId: task.id,
      timestamp: new Date(),
      version: task.stateVersion,
      from: previousState,
      to: newStatus,
    });

    return { success: true, previousState, newState: newStatus };
  }

  /**
   * Check if a transition is valid without performing it.
   */
  canTransition(fromState: string, toState: string): boolean {
    const def = this.stateDefinitions[fromState];
    if (!def) return false;
    return def.allowedTransitions.includes(toState);
  }

  /**
   * Check if a state is terminal.
   */
  isTerminal(state: string): boolean {
    const def = this.stateDefinitions[state];
    return def?.isTerminal ?? false;
  }

  /**
   * Get allowed transitions from a state.
   */
  getAllowedTransitions(state: string): readonly string[] {
    const def = this.stateDefinitions[state];
    return def?.allowedTransitions ?? [];
  }
}

/**
 * Global state machine instance.
 */
export const globalStateMachine = new AtomicStateMachine();
