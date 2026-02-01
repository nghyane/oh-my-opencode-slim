/**
 * Metrics Collector
 *
 * Subscribes to all background task events and tracks metrics
 * for monitoring system health and performance.
 */

import type {
  NotificationFailedEvent,
  NotificationSentEvent,
  TaskCancelledEvent,
  TaskCompletedEvent,
  TaskCreatedEvent,
  TaskEventBus,
  TaskFailedEvent,
  TaskTransitionEvent,
} from '../events';

export interface Counter {
  value: number;
  inc(delta?: number): void;
}

export interface Gauge {
  value: number;
  inc(delta?: number): void;
  dec(delta?: number): void;
  set(value: number): void;
}

export interface Histogram {
  observe(value: number): void;
  getBuckets(): Map<number, number>;
}

export interface TaskMetrics {
  tasksCreated: Counter;
  tasksCompleted: Counter;
  tasksFailed: Counter;
  tasksCancelled: Counter;
  activeTasks: Gauge;
  queueSize: Gauge;
  taskDuration: Histogram;
  stateTransitions: Counter;
  notificationLatency: Histogram;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  queueDepth: number;
  activeTasks: number;
  recentErrorRate: number;
  lastError?: string;
}

class SimpleCounter implements Counter {
  value = 0;
  inc(delta = 1): void {
    this.value += delta;
  }
}

class SimpleGauge implements Gauge {
  value = 0;
  inc(delta = 1): void {
    this.value += delta;
  }
  dec(delta = 1): void {
    this.value -= delta;
  }
  set(value: number): void {
    this.value = value;
  }
}

class SimpleHistogram implements Histogram {
  private buckets = new Map<number, number>();
  private values: number[] = [];
  private bucketBounds = [10, 50, 100, 500, 1000, 5000, 10000, 30000, 60000];

  observe(value: number): void {
    this.values.push(value);

    // Update buckets
    for (const bound of this.bucketBounds) {
      if (value <= bound) {
        this.buckets.set(bound, (this.buckets.get(bound) ?? 0) + 1);
      }
    }

    // Keep only last 1000 values to prevent unbounded growth
    if (this.values.length > 1000) {
      this.values.shift();
    }
  }

  getBuckets(): Map<number, number> {
    return new Map(this.buckets);
  }

  getPercentile(p: number): number {
    if (this.values.length === 0) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    const index = Math.floor((p / 100) * sorted.length);
    return sorted[Math.min(index, sorted.length - 1)];
  }

  getAverage(): number {
    if (this.values.length === 0) return 0;
    return this.values.reduce((a, b) => a + b, 0) / this.values.length;
  }
}

export class TaskMetricsCollector {
  private metrics: TaskMetrics;
  private eventBus: TaskEventBus;
  private errorTimestamps: number[] = [];
  private unsubscribeFns: Array<() => void> = [];
  private taskCreatedTimes = new Map<string, number>();

  constructor(eventBus: TaskEventBus) {
    this.eventBus = eventBus;
    this.metrics = {
      tasksCreated: new SimpleCounter(),
      tasksCompleted: new SimpleCounter(),
      tasksFailed: new SimpleCounter(),
      tasksCancelled: new SimpleCounter(),
      activeTasks: new SimpleGauge(),
      queueSize: new SimpleGauge(),
      taskDuration: new SimpleHistogram(),
      stateTransitions: new SimpleCounter(),
      notificationLatency: new SimpleHistogram(),
    };

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Task created
    this.unsubscribeFns.push(
      this.eventBus.on('task.created', (e: TaskCreatedEvent) => {
        this.metrics.tasksCreated.inc();
        this.metrics.activeTasks.inc();
        this.taskCreatedTimes.set(e.taskId, e.timestamp.getTime());
      }),
    );

    // Task completed
    this.unsubscribeFns.push(
      this.eventBus.on('task.completed', (e: TaskCompletedEvent) => {
        this.metrics.tasksCompleted.inc();
        this.metrics.activeTasks.dec();
        // Calculate duration from created to completed
        const createdTime = this.taskCreatedTimes.get(e.taskId);
        if (createdTime) {
          const duration = e.timestamp.getTime() - createdTime;
          this.metrics.taskDuration.observe(duration);
          this.taskCreatedTimes.delete(e.taskId);
        }
      }),
    );

    // Task failed
    this.unsubscribeFns.push(
      this.eventBus.on('task.failed', (e: TaskFailedEvent) => {
        this.metrics.tasksFailed.inc();
        this.metrics.activeTasks.dec();
        this.recordError();
        this.taskCreatedTimes.delete(e.taskId);
      }),
    );

    // Task cancelled
    this.unsubscribeFns.push(
      this.eventBus.on('task.cancelled', (e: TaskCancelledEvent) => {
        this.metrics.tasksCancelled.inc();
        this.metrics.activeTasks.dec();
        this.taskCreatedTimes.delete(e.taskId);
      }),
    );

    // State transitions
    this.unsubscribeFns.push(
      this.eventBus.on('task.transition', (_e: TaskTransitionEvent) => {
        this.metrics.stateTransitions.inc();
      }),
    );

    // Notification latency
    this.unsubscribeFns.push(
      this.eventBus.on('notification.sent', (_e: NotificationSentEvent) => {
        // Would need notification start time to calculate latency
        // For now, just track count
      }),
    );

    this.unsubscribeFns.push(
      this.eventBus.on('notification.failed', (_e: NotificationFailedEvent) => {
        this.recordError();
      }),
    );
  }

  private recordError(): void {
    const now = Date.now();
    this.errorTimestamps.push(now);

    // Keep only last 5 minutes of errors
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    this.errorTimestamps = this.errorTimestamps.filter(
      (t) => t > fiveMinutesAgo,
    );
  }

  getMetrics(): TaskMetrics {
    return this.metrics;
  }

  getHealth(): HealthStatus {
    const recentErrors = this.errorTimestamps.length;
    const totalRecent =
      this.metrics.tasksCompleted.value +
      this.metrics.tasksFailed.value +
      this.metrics.tasksCancelled.value;
    const errorRate = totalRecent > 0 ? recentErrors / totalRecent : 0;

    let status: HealthStatus['status'] = 'healthy';
    if (errorRate > 0.5) {
      status = 'unhealthy';
    } else if (errorRate > 0.2 || this.metrics.queueSize.value > 100) {
      status = 'degraded';
    }

    return {
      status,
      queueDepth: this.metrics.queueSize.value,
      activeTasks: this.metrics.activeTasks.value,
      recentErrorRate: errorRate,
    };
  }

  updateQueueSize(size: number): void {
    this.metrics.queueSize.set(size);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribeFns) {
      unsubscribe();
    }
    this.unsubscribeFns = [];
    this.taskCreatedTimes.clear();
  }
}
