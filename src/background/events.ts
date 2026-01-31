/**
 * Background Task Events
 *
 * Event sourcing types for tracking all state changes in the background task system.
 * Events are emitted synchronously and can be used for debugging, metrics, and recovery.
 */

/**
 * Task status types
 */
export type TaskStatus =
  | 'pending'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Notification state types
 */
export type NotificationState = 'pending' | 'sending' | 'sent' | 'failed';

/**
 * Base event interface
 */
export interface TaskEvent {
  readonly type: string;
  readonly taskId: string;
  readonly timestamp: Date;
  readonly version: number;
}

/**
 * Task created event - emitted when task is first launched
 */
export interface TaskCreatedEvent extends TaskEvent {
  readonly type: 'task.created';
  readonly agent: string;
  readonly description: string;
  readonly parentSessionId: string;
}

/**
 * Task started event - emitted when task transitions to running
 */
export interface TaskStartedEvent extends TaskEvent {
  readonly type: 'task.started';
  readonly sessionId: string;
}

/**
 * Task completed event - emitted on successful completion
 */
export interface TaskCompletedEvent extends TaskEvent {
  readonly type: 'task.completed';
  readonly resultLength: number;
  readonly wasTruncated: boolean;
}

/**
 * Task failed event - emitted on failure
 */
export interface TaskFailedEvent extends TaskEvent {
  readonly type: 'task.failed';
  readonly error: string;
  readonly resultLength: number;
}

/**
 * Task cancelled event - emitted when task is cancelled
 */
export interface TaskCancelledEvent extends TaskEvent {
  readonly type: 'task.cancelled';
  readonly reason?: string;
}

/**
 * Task state transition event - emitted on every state change
 */
export interface TaskTransitionEvent extends TaskEvent {
  readonly type: 'task.transition';
  readonly from: TaskStatus;
  readonly to: TaskStatus;
}

/**
 * Notification sent event
 */
export interface NotificationSentEvent extends TaskEvent {
  readonly type: 'notification.sent';
  readonly parentSessionId: string;
}

/**
 * Notification failed event
 */
export interface NotificationFailedEvent extends TaskEvent {
  readonly type: 'notification.failed';
  readonly parentSessionId: string;
  readonly attempts: number;
  readonly willRetry: boolean;
}

/**
 * Union type of all task events
 */
export type TaskEvents =
  | TaskCreatedEvent
  | TaskStartedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent
  | TaskTransitionEvent
  | NotificationSentEvent
  | NotificationFailedEvent;

/**
 * Event handler type
 */
export type TaskEventHandler<T extends TaskEvent = TaskEvent> = (
  event: T,
) => void;

/**
 * Event bus for task events
 */
export class TaskEventBus {
  private handlers = new Map<string, Set<TaskEventHandler>>();

  /**
   * Subscribe to events of a specific type
   */
  on<T extends TaskEvent>(
    type: T['type'],
    handler: TaskEventHandler<T>,
  ): () => void {
    const handlers = this.handlers.get(type) ?? new Set();
    handlers.add(handler as TaskEventHandler);
    this.handlers.set(type, handlers);

    // Return unsubscribe function
    return () => {
      handlers.delete(handler as TaskEventHandler);
    };
  }

  /**
   * Subscribe to all events
   */
  onAny(handler: TaskEventHandler): () => void {
    return this.on('*' as TaskEvent['type'], handler);
  }

  /**
   * Emit an event
   */
  emit<T extends TaskEvent>(event: T): void {
    // Emit to type-specific handlers
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          // Don't let event handlers break the system
          console.error(`[TaskEventBus] Handler error for ${event.type}:`, err);
        }
      }
    }

    // Emit to wildcard handlers
    const anyHandlers = this.handlers.get('*');
    if (anyHandlers) {
      for (const handler of anyHandlers) {
        try {
          handler(event);
        } catch (err) {
          console.error(`[TaskEventBus] Wildcard handler error:`, err);
        }
      }
    }
  }
}

// Backwards compatibility alias
export { TaskEventBus as EventBus };
