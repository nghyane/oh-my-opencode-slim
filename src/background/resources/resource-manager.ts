export interface ManagedResource {
  readonly id: string;
  readonly priority: number; // Lower = cleanup first
  dispose(): Promise<void> | void;
  isDisposed(): boolean;
}

export class GuaranteedCleanupManager {
  private resources = new Map<string, Map<string, ManagedResource>>();

  private cleanupInProgress = new Set<string>();

  private exitHandlersRegistered = false;

  constructor() {
    this.registerExitHandlers();
  }

  private registerExitHandlers(): void {
    if (this.exitHandlersRegistered) return;
    this.exitHandlersRegistered = true;

    // Synchronous cleanup for process exit
    const syncCleanup = () => {
      this.syncCleanupAll();
    };

    process.once('exit', syncCleanup);
    process.once('SIGINT', () => {
      syncCleanup();
      process.exit(0);
    });
    process.once('SIGTERM', () => {
      syncCleanup();
      process.exit(0);
    });
  }

  register(taskId: string, resource: ManagedResource): void {
    const taskResources = this.resources.get(taskId) ?? new Map();
    taskResources.set(resource.id, resource);
    this.resources.set(taskId, taskResources);
  }

  async cleanup(taskId: string, timeoutMs = 5000): Promise<void> {
    if (this.cleanupInProgress.has(taskId)) {
      return; // Idempotent
    }
    this.cleanupInProgress.add(taskId);

    const taskResources = this.resources.get(taskId);
    if (!taskResources) {
      this.cleanupInProgress.delete(taskId);
      return;
    }

    // Sort by priority (lower = first)
    const sorted = Array.from(taskResources.values()).sort(
      (a, b) => a.priority - b.priority,
    );

    const errors: Error[] = [];

    for (const resource of sorted) {
      if (resource.isDisposed()) continue;

      try {
        await this.disposeWithTimeout(resource, timeoutMs);
      } catch (error) {
        errors.push(error as Error);
        // Continue cleanup despite error
      }
    }

    this.resources.delete(taskId);
    this.cleanupInProgress.delete(taskId);

    if (errors.length > 0) {
      throw new AggregateError(errors, `Cleanup failed for task ${taskId}`);
    }
  }

  private syncCleanupAll(): void {
    // Synchronous cleanup for process exit - best effort
    for (const [, resources] of this.resources) {
      for (const resource of resources.values()) {
        try {
          const result = resource.dispose();
          if (result instanceof Promise) {
            // Fire and forget - we can't wait on exit
            result.catch(() => {});
          }
        } catch {
          // Ignore errors during exit
        }
      }
    }
  }

  private disposeWithTimeout(
    resource: ManagedResource,
    timeoutMs: number,
  ): Promise<void> {
    return Promise.race([
      Promise.resolve(resource.dispose()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Dispose timeout')), timeoutMs),
      ),
    ]) as Promise<void>;
  }

  getRegisteredResources(taskId: string): ManagedResource[] {
    const taskResources = this.resources.get(taskId);
    return taskResources ? Array.from(taskResources.values()) : [];
  }

  hasResources(taskId: string): boolean {
    const taskResources = this.resources.get(taskId);
    return taskResources !== undefined && taskResources.size > 0;
  }

  /**
   * Clean up all resources for all tasks (synchronous for process exit)
   */
  cleanupAll(): void {
    this.syncCleanupAll();
    this.resources.clear();
  }
}

// Global instance
export const globalResourceManager = new GuaranteedCleanupManager();
