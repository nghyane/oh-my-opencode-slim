/**
 * Saga Pattern Exports
 *
 * Exports saga-related types and classes for task finalization
 * with compensation support.
 */

export {
  type Compensation,
  SagaOrchestrator,
  type SagaResult,
  type SagaStep,
  TaskFinalizationSaga,
} from './task-finalization-saga.js';
