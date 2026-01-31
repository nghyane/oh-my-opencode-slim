/**
 * Task Finalization Saga
 *
 * Implements saga pattern for task finalization:
 * - Each step has a compensation (rollback) action
 * - If any step fails, previous steps are compensated
 * - Ensures atomic finalization semantics
 */

import type { BackgroundTask, TaskOutcome } from '../background-manager';
import type { TaskEventBus } from '../events';
import type { GuaranteedCleanupManager } from '../resources/resource-manager';

/**
 * Compensation action for rollback
 */
export interface Compensation {
  /** Execute the compensation */
  execute(): Promise<void>;

  /** Compensation name for logging */
  readonly name: string;
}

/**
 * Saga step interface
 */
export interface SagaStep {
  /** Step name */
  readonly name: string;

  /** Execute the step */
  execute(): Promise<boolean>;

  /** Get compensation for this step if needed */
  getCompensation?(): Compensation;
}

/**
 * Saga execution result
 */
export interface SagaResult {
  readonly success: boolean;
  readonly completedSteps: string[];
  readonly failedStep?: string;
  readonly error?: string;
}

/**
 * Task finalization saga
 *
 * Steps:
 * 1. Extract result from session
 * 2. Send notification
 * 3. Clean up resources
 */
export class TaskFinalizationSaga {
  private resourceManager: GuaranteedCleanupManager | null = null;
  private steps: SagaStep[] = [];
  private completedSteps: string[] = [];
  private compensations: Compensation[] = [];

  /**
   * Set the resource manager
   */
  setResourceManager(manager: GuaranteedCleanupManager): void {
    this.resourceManager = manager;
  }

  constructor(
    private task: BackgroundTask,
    private outcome: TaskOutcome,
    _eventBus: TaskEventBus,
    resourceManager: GuaranteedCleanupManager,
    private extractResultFn: () => Promise<string>,
    private sendNotificationFn: () => Promise<void>,
  ) {
    // Initialize resourceManager from parameter
    this.resourceManager = resourceManager;
    this.buildSteps();
  }

  /**
   * Build the saga steps
   */
  private buildSteps(): void {
    // Step 1: Extract result
    this.steps.push({
      name: 'extract-result',
      execute: async () => {
        try {
          if (this.outcome.status === 'completed') {
            this.task.result = await this.extractResultFn();
          } else if (this.outcome.status === 'failed') {
            this.task.error = this.outcome.error;
            if (this.outcome.result) {
              this.task.result = this.outcome.result;
            }
          } else if (this.outcome.status === 'cancelled') {
            if (this.outcome.result) {
              this.task.result = this.outcome.result;
            }
          }
          return true;
        } catch {
          return false;
        }
      },
      getCompensation: () => ({
        name: 'clear-result',
        execute: async () => {
          this.task.result = undefined;
          this.task.error = undefined;
        },
      }),
    });

    // Step 2: Send notification
    this.steps.push({
      name: 'send-notification',
      execute: async () => {
        try {
          await this.sendNotificationFn();
          return true;
        } catch {
          // Notification failure doesn't fail the saga
          return true;
        }
      },
    });

    // Step 3: Clean up resources
    this.steps.push({
      name: 'cleanup-resources',
      execute: async () => {
        try {
          this.resourceManager?.cleanup(this.task.id);
          return true;
        } catch {
          return false;
        }
      },
    });
  }

  /**
   * Execute the saga
   */
  async execute(): Promise<SagaResult> {
    if (!this.resourceManager) {
      throw new Error(
        'TaskFinalizationSaga: ResourceManager not set. Call setResourceManager() first.',
      );
    }

    for (const step of this.steps) {
      const success = await step.execute();

      if (success) {
        this.completedSteps.push(step.name);

        // Store compensation for potential rollback
        if (step.getCompensation) {
          this.compensations.unshift(step.getCompensation());
        }
      } else {
        // Step failed - compensate completed steps
        await this.compensate();

        return {
          success: false,
          completedSteps: this.completedSteps,
          failedStep: step.name,
          error: `Step '${step.name}' failed`,
        };
      }
    }

    return {
      success: true,
      completedSteps: this.completedSteps,
    };
  }

  /**
   * Compensate (rollback) completed steps
   */
  private async compensate(): Promise<void> {
    for (const compensation of this.compensations) {
      try {
        await compensation.execute();
      } catch (err) {
        // Log but continue with other compensations
        console.error(
          `[TaskFinalizationSaga] Compensation '${compensation.name}' failed:`,
          err,
        );
      }
    }
  }
}

/**
 * Saga orchestrator for managing multiple sagas
 */
export class SagaOrchestrator {
  private activeSagas = new Map<string, TaskFinalizationSaga>();

  /**
   * Start a finalization saga
   */
  async startFinalization(
    taskId: string,
    saga: TaskFinalizationSaga,
  ): Promise<SagaResult> {
    this.activeSagas.set(taskId, saga);

    try {
      const result = await saga.execute();
      return result;
    } finally {
      this.activeSagas.delete(taskId);
    }
  }

  /**
   * Check if a task has an active saga
   */
  hasActiveSaga(taskId: string): boolean {
    return this.activeSagas.has(taskId);
  }

  /**
   * Dispose all active sagas
   */
  dispose(): void {
    this.activeSagas.clear();
  }
}
