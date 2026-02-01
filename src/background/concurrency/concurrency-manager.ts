/**
 * Concurrency Manager for Rate Limiting per Model/Provider
 *
 * Provides per-model concurrency limits to prevent rate limiting
 * when making requests to different AI providers.
 */

export interface ConcurrencyConfig {
  limits: Record<string, number>; // model pattern -> limit
  defaultLimit: number;
}

export class ConcurrencyManager {
  private counts = new Map<string, number>();
  private queues = new Map<string, Array<() => void>>();
  private config: ConcurrencyConfig;
  private compiledPatterns = new Map<string, RegExp>();

  constructor(config: Partial<ConcurrencyConfig> = {}) {
    this.config = {
      limits: config.limits ?? {
        'anthropic/*': 3,
        'openai/*': 5,
        'google/*': 10,
      },
      defaultLimit: config.defaultLimit ?? 3,
    };
  }

  /**
   * Acquire a slot for the given model.
   * Blocks if at capacity until a slot is available.
   * Times out after timeoutMs (default 5 minutes).
   */
  async acquire(model: string, timeoutMs = 300000): Promise<void> {
    const limit = this.getLimit(model);
    const current = this.counts.get(model) ?? 0;

    if (current < limit) {
      this.counts.set(model, current + 1);
      return;
    }

    // Wait for slot to become available with timeout
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(model) ?? [];
      queue.push(resolve);
      this.queues.set(model, queue);

      // Set timeout to reject the promise if waiting too long
      const timeout = setTimeout(() => {
        // Remove this resolve from queue if still waiting
        const index = queue.indexOf(resolve);
        if (index > -1) {
          queue.splice(index, 1);
        }
        reject(
          new Error(`Acquire timeout for model ${model} after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      // Clear timeout when resolved through another path
      const wrappedResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
      const index = queue.length - 1;
      queue[index] = wrappedResolve;
    });
  }

  /**
   * Release a slot for the given model.
   * Transfers slot to next waiter if any.
   */
  release(model: string): void {
    const queue = this.queues.get(model);
    if (queue && queue.length > 0) {
      // Transfer slot directly to next waiter
      const next = queue.shift();
      if (next) {
        next();
        // Clean up queue map if empty
        if (queue.length === 0) {
          this.queues.delete(model);
        }
        return; // Slot transferred, don't decrement
      }
    }
    // Decrement count and clean up if zero
    const newCount = Math.max(0, (this.counts.get(model) ?? 1) - 1);
    if (newCount === 0) {
      this.counts.delete(model);
    } else {
      this.counts.set(model, newCount);
    }
  }

  /**
   * Get current concurrency for a model.
   */
  getCurrent(model: string): number {
    return this.counts.get(model) ?? 0;
  }

  /**
   * Get queue length for a model.
   */
  getQueueLength(model: string): number {
    return this.queues.get(model)?.length ?? 0;
  }

  /**
   * Get limit for a model (supports wildcards).
   */
  private getLimit(model: string): number {
    // Check exact match first
    if (this.config.limits[model] !== undefined) {
      return this.config.limits[model];
    }

    // Check wildcard patterns (e.g., "anthropic/*" matches "anthropic/claude-3")
    for (const [pattern, limit] of Object.entries(this.config.limits)) {
      if (pattern.includes('*')) {
        let regex = this.compiledPatterns.get(pattern);
        if (!regex) {
          regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
          this.compiledPatterns.set(pattern, regex);
        }
        if (regex.test(model)) {
          return limit;
        }
      }
    }

    return this.config.defaultLimit;
  }

  /**
   * Get stats for all models.
   */
  getStats(): Array<{
    model: string;
    current: number;
    limit: number;
    queued: number;
  }> {
    const models = new Set([
      ...this.counts.keys(),
      ...this.queues.keys(),
      ...Object.keys(this.config.limits),
    ]);
    return Array.from(models).map((model) => ({
      model,
      current: this.getCurrent(model),
      limit: this.getLimit(model),
      queued: this.getQueueLength(model),
    }));
  }

  /**
   * Reset the manager - clears all counts and queues.
   * Useful for testing to ensure clean state between tests.
   */
  reset(): void {
    this.counts.clear();
    this.queues.clear();
  }
}

// Global instance with default config
export const globalConcurrencyManager = new ConcurrencyManager();
