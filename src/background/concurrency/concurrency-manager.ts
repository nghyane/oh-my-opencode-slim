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
   */
  async acquire(model: string): Promise<void> {
    const limit = this.getLimit(model);
    const current = this.counts.get(model) ?? 0;

    if (current < limit) {
      this.counts.set(model, current + 1);
      return;
    }

    // Wait for slot to become available
    return new Promise((resolve) => {
      const queue = this.queues.get(model) ?? [];
      queue.push(resolve);
      this.queues.set(model, queue);
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
        return; // Slot transferred, don't decrement
      }
    }
    // Decrement count
    this.counts.set(model, Math.max(0, (this.counts.get(model) ?? 1) - 1));
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
        const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
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
}

// Global instance with default config
export const globalConcurrencyManager = new ConcurrencyManager();
