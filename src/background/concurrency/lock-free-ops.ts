import type { BackgroundTask } from '../background-manager';

export interface TaskOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  result?: string;
  error?: string;
  truncated?: boolean;
}

export class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

export class LockFreeTaskOperations {
  private finalizingTasks = new Set<string>();
  private completionResolvers = new Map<
    string,
    Deferred<BackgroundTask | null>
  >();
  private tasks: Map<string, BackgroundTask>;

  /**
   * Get completion resolvers map (for testing/cleanup purposes).
   */
  getCompletionResolvers(): Map<string, Deferred<BackgroundTask | null>> {
    return this.completionResolvers;
  }

  constructor(tasks: Map<string, BackgroundTask>) {
    this.tasks = tasks;
  }

  private isTerminal(status: string): boolean {
    return ['completed', 'failed', 'cancelled'].includes(status);
  }

  /**
   * Attempt to finalize a task with race protection.
   * Returns true if finalization was performed by this call,
   * false if another operation is already finalizing or task is already terminal.
   */
  async finalizeWithRaceProtection(
    task: BackgroundTask,
    outcome: TaskOutcome,
    doFinalize: (task: BackgroundTask, outcome: TaskOutcome) => Promise<void>,
  ): Promise<boolean> {
    // Test-and-set pattern
    if (this.finalizingTasks.has(task.id)) {
      return false; // Another thread is finalizing
    }
    this.finalizingTasks.add(task.id);

    try {
      // Double-check after acquiring "lock"
      if (this.isTerminal(task.status)) {
        return false;
      }

      // Perform finalization
      await doFinalize(task, outcome);

      // Resolve any waiters
      this.resolveWaiters(task);

      return true;
    } finally {
      this.finalizingTasks.delete(task.id);
    }
  }

  /**
   * Wait for task completion with timeout and race protection.
   */
  async waitForCompletion(
    taskId: string,
    timeoutMs: number,
  ): Promise<BackgroundTask | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    if (this.isTerminal(task.status)) {
      return task;
    }

    // Create deferred promise
    const deferred = new Deferred<BackgroundTask | null>();
    this.completionResolvers.set(taskId, deferred);

    // Race protection: check again immediately after registration
    const currentTask = this.tasks.get(taskId);
    if (currentTask && this.isTerminal(currentTask.status)) {
      this.completionResolvers.delete(taskId);
      return currentTask;
    }

    // Set timeout
    const timeoutId = setTimeout(() => {
      this.completionResolvers.delete(taskId);
      deferred.resolve(this.tasks.get(taskId) ?? null);
    }, timeoutMs);

    try {
      return await deferred.promise;
    } finally {
      clearTimeout(timeoutId);
      this.completionResolvers.delete(taskId);
    }
  }

  /**
   * Resolve waiters for a completed task.
   */
  resolveWaiters(task: BackgroundTask): void {
    const deferred = this.completionResolvers.get(task.id);
    if (deferred) {
      deferred.resolve(task);
      // Don't delete here - let waitForCompletion clean up
    }
  }

  /**
   * Check if a task is being finalized.
   */
  isFinalizing(taskId: string): boolean {
    return this.finalizingTasks.has(taskId);
  }

  /**
   * Get count of pending waiters.
   */
  getPendingWaiterCount(): number {
    return this.completionResolvers.size;
  }

  /**
   * Dispose all operations
   */
  dispose(): void {
    // Resolve all pending waiters with null
    for (const [taskId, deferred] of this.completionResolvers) {
      deferred.resolve(this.tasks.get(taskId) ?? null);
    }
    this.completionResolvers.clear();
    this.finalizingTasks.clear();
  }
}
