/**
 * Structured Concurrency for Background Tasks
 *
 * Implements structured concurrency pattern where:
 * - Parent scopes own child scopes
 * - Cancellation propagates down the tree
 * - Children must complete before parent can complete
 */

/**
 * Cancellation token for cooperative cancellation
 */
export class CancellationToken {
  private cancelled = false;
  private cancelHandlers = new Set<() => void>();

  /**
   * Check if cancellation has been requested
   */
  isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Throw if cancellation has been requested
   */
  throwIfCancelled(): void {
    if (this.cancelled) {
      throw new CancellationError('Operation was cancelled');
    }
  }

  /**
   * Request cancellation
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;

    // Notify all handlers
    for (const handler of this.cancelHandlers) {
      try {
        handler();
      } catch (err) {
        // Don't let one handler break others
        console.error('[CancellationToken] Handler error:', err);
      }
    }
  }

  /**
   * Register a handler to be called on cancellation
   */
  onCancel(handler: () => void): () => void {
    this.cancelHandlers.add(handler);

    // If already cancelled, call immediately
    if (this.cancelled) {
      handler();
    }

    // Return unsubscribe
    return () => {
      this.cancelHandlers.delete(handler);
    };
  }
}

/**
 * Cancellation error type
 */
export class CancellationError extends Error {
  constructor(message = 'Operation was cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

/**
 * Task scope for structured concurrency
 */
export class TaskScope {
  private children = new Set<TaskScope>();
  private parent?: TaskScope;
  private cancellationToken: CancellationToken;
  private completed = false;
  private completionPromise?: Promise<void>;
  private completionResolver?: () => void;

  constructor(
    public readonly taskId: string,
    parent?: TaskScope,
  ) {
    this.cancellationToken = new CancellationToken();
    this.parent = parent;

    // Register with parent
    if (parent) {
      parent.addChild(this);
    }
  }

  /**
   * Get the cancellation token for this scope
   */
  getCancellationToken(): CancellationToken {
    return this.cancellationToken;
  }

  /**
   * Check if this scope has been cancelled
   */
  isCancelled(): boolean {
    return this.cancellationToken.isCancelled();
  }

  /**
   * Add a child scope
   */
  private addChild(child: TaskScope): void {
    if (this.completed) {
      throw new Error('Cannot add child to completed scope');
    }
    this.children.add(child);
  }

  /**
   * Remove a child scope
   */
  removeChild(child: TaskScope): void {
    this.children.delete(child);

    // If all children are done and we're waiting, resolve
    if (this.children.size === 0 && this.completionResolver) {
      this.completionResolver();
    }
  }

  /**
   * Cancel this scope and all children
   */
  cancel(): void {
    // Cancel children first (depth-first)
    for (const child of this.children) {
      child.cancel();
    }

    // Then cancel self
    this.cancellationToken.cancel();
  }

  /**
   * Create a child scope
   */
  createChild(childTaskId: string): TaskScope {
    return new TaskScope(childTaskId, this);
  }

  /**
   * Mark this scope as completed
   * Waits for all children to complete first
   */
  async complete(): Promise<void> {
    if (this.completed) return;

    // Wait for children
    if (this.children.size > 0) {
      if (!this.completionPromise) {
        this.completionPromise = new Promise<void>((resolve) => {
          this.completionResolver = resolve;
        });
      }
      await this.completionPromise;
    }

    // Unregister from parent
    if (this.parent) {
      this.parent.removeChild(this);
    }

    this.completed = true;
  }

  /**
   * Get all descendant task IDs (for cleanup)
   */
  getAllDescendants(): string[] {
    const ids: string[] = [];
    for (const child of this.children) {
      ids.push(child.taskId);
      ids.push(...child.getAllDescendants());
    }
    return ids;
  }
}

/**
 * Root scope for the background task manager
 */
export class RootScope {
  private scopes = new Map<string, TaskScope>();

  /**
   * Create a new top-level scope
   */
  create(taskId: string): TaskScope {
    const scope = new TaskScope(taskId);
    this.scopes.set(taskId, scope);
    return scope;
  }

  /**
   * Get a scope by task ID
   */
  get(taskId: string): TaskScope | undefined {
    return this.scopes.get(taskId);
  }

  /**
   * Remove a scope
   */
  remove(taskId: string): void {
    const scope = this.scopes.get(taskId);
    if (scope) {
      scope.cancel();
      this.scopes.delete(taskId);
    }
  }

  /**
   * Cancel all scopes (for shutdown)
   */
  cancelAll(): void {
    for (const scope of this.scopes.values()) {
      scope.cancel();
    }
  }

  /**
   * Wait for all scopes to complete
   */
  async waitForAll(timeoutMs: number): Promise<void> {
    const startTime = Date.now();

    while (this.scopes.size > 0) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(
          `Timeout waiting for ${this.scopes.size} scopes to complete`,
        );
      }

      // Give scopes time to complete
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Dispose all scopes
   */
  dispose(): void {
    this.cancelAll();
    this.scopes.clear();
  }
}
