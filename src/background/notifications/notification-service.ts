/**
 * Notification Service with Circuit Breaker
 *
 * Provides reliable notification delivery with circuit breaker pattern,
 * retry logic with exponential backoff, and event emission for observability.
 */

import type { BackgroundTask } from '../background-manager';
import type { TaskEvent } from '../events';
import { globalEventBus } from '../state-machine';

/** Circuit breaker states */
type CircuitState = 'closed' | 'open' | 'half-open';

/** Circuit breaker configuration options */
export interface CircuitBreakerOptions {
  failureThreshold: number;
  recoveryTimeoutMs: number;
  halfOpenMaxCalls: number;
}

/** Circuit breaker implementation for preventing cascade failures */
class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private halfOpenCalls = 0;
  private options: CircuitBreakerOptions;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = {
      failureThreshold: options.failureThreshold ?? 5,
      recoveryTimeoutMs: options.recoveryTimeoutMs ?? 30000,
      halfOpenMaxCalls: options.halfOpenMaxCalls ?? 3,
    };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (this.shouldAttemptReset()) {
        this.state = 'half-open';
        this.halfOpenCalls = 0;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    if (
      this.state === 'half-open' &&
      this.halfOpenCalls >= this.options.halfOpenMaxCalls
    ) {
      throw new Error('Circuit breaker HALF-OPEN limit reached');
    }

    if (this.state === 'half-open') {
      this.halfOpenCalls++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /** Handle successful execution */
  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.failureCount = 0;
      this.halfOpenCalls = 0;
    } else {
      this.failureCount = 0;
    }
  }

  /** Handle failed execution */
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.options.failureThreshold) {
      this.state = 'open';
    }
  }

  /** Check if enough time has passed to attempt reset */
  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) return true;
    return Date.now() - this.lastFailureTime >= this.options.recoveryTimeoutMs;
  }

  /** Get current circuit state */
  getState(): CircuitState {
    return this.state;
  }

  /** Get circuit breaker statistics */
  getStats(): { state: CircuitState; failureCount: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
    };
  }
}

/** Notification service configuration */
export interface NotificationServiceOptions {
  circuitBreaker?: Partial<CircuitBreakerOptions>;
  retryAttempts?: number;
  retryDelayMs?: number;
}

/** Notification service for reliable task completion notifications */
export class NotificationService {
  private circuitBreaker: CircuitBreaker;
  private options: Required<NotificationServiceOptions>;
  private sendFn:
    | ((sessionId: string, message: unknown) => Promise<void>)
    | null = null;

  constructor(options: NotificationServiceOptions = {}) {
    this.options = {
      circuitBreaker: options.circuitBreaker ?? {},
      retryAttempts: options.retryAttempts ?? 3,
      retryDelayMs: options.retryDelayMs ?? 1000,
    };
    this.circuitBreaker = new CircuitBreaker(this.options.circuitBreaker);
  }

  /** Set the notification sending function */
  setSendFunction(
    fn: (sessionId: string, message: unknown) => Promise<void>,
  ): void {
    this.sendFn = fn;
  }

  /** Send notification for a completed task */
  async send(task: BackgroundTask): Promise<void> {
    if (!task.parentSessionId) {
      return;
    }

    if (!this.sendFn) {
      throw new Error('NotificationService: send function not set');
    }

    const message = this.buildNotificationMessage(task);

    // Emit notification attempt event
    const attemptEvent: TaskEvent & { payload: { sessionId: string } } = {
      type: 'notification.attempt',
      taskId: task.id,
      timestamp: new Date(),
      version: task.stateVersion + 1,
      payload: { sessionId: task.parentSessionId },
    };
    globalEventBus.emit(attemptEvent);

    try {
      await this.circuitBreaker.execute(async () => {
        if (task.parentSessionId) {
          await this.sendWithRetry(task.parentSessionId, message);
        }
      });

      // Emit success event
      const successEvent: TaskEvent & { payload: { sessionId: string } } = {
        type: 'notification.sent',
        taskId: task.id,
        timestamp: new Date(),
        version: task.stateVersion + 1,
        payload: { sessionId: task.parentSessionId },
      };
      globalEventBus.emit(successEvent);
    } catch (error) {
      // Emit failure event
      const failedEvent: TaskEvent & {
        payload: { sessionId: string; attempts: number; error: string };
      } = {
        type: 'notification.failed',
        taskId: task.id,
        timestamp: new Date(),
        version: task.stateVersion + 1,
        payload: {
          sessionId: task.parentSessionId,
          attempts: this.options.retryAttempts,
          error: (error as Error).message,
        },
      };
      globalEventBus.emit(failedEvent);
      throw error;
    }
  }

  /** Send with retry logic and exponential backoff */
  private async sendWithRetry(
    sessionId: string,
    message: unknown,
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.options.retryAttempts; attempt++) {
      try {
        if (!this.sendFn) throw new Error('Send function not set');
        await this.sendFn(sessionId, message);
        return;
      } catch (error) {
        lastError = error as Error;

        if (attempt < this.options.retryAttempts - 1) {
          const delay = this.options.retryDelayMs * 2 ** attempt;
          await this.sleep(delay);
        }
      }
    }

    throw lastError ?? new Error('Notification failed after retries');
  }

  /** Build notification message for a task */
  private buildNotificationMessage(task: BackgroundTask): unknown {
    return {
      type: 'background-task-completed',
      taskId: task.id,
      status: task.status,
      result: task.result,
      error: task.error,
      truncated: task.isResultTruncated,
      completedAt: task.completedAt,
    };
  }

  /** Sleep utility for delay */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Get circuit breaker state and statistics */
  getCircuitState(): { state: CircuitState; failureCount: number } {
    return this.circuitBreaker.getStats();
  }
}

/** Global notification service instance */
export const globalNotificationService = new NotificationService();
