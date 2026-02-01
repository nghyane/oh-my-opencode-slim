/**
 * Simple Notification Service
 *
 * Gửi notification trực tiếp đến parent session khi task hoàn thành.
 * Không có queue, không retry phức tạp, không persistence.
 * Nếu session đã đóng thì notification sẽ fail silently.
 */

import type { BackgroundTask } from '../background-manager';
import type { NotificationSentEvent } from '../events';
import { globalEventBus } from '../state-machine';

export class NotificationService {
  private sendFn?: (sessionId: string, message: unknown) => Promise<void>;

  /** Set the notification sending function */
  setSendFunction(
    fn: (sessionId: string, message: unknown) => Promise<void>,
  ): void {
    this.sendFn = fn;
  }

  /** Send notification for a completed task */
  async send(task: BackgroundTask): Promise<void> {
    if (!task.parentSessionId || !this.sendFn) {
      return;
    }

    const message = this.buildNotificationMessage(task);

    try {
      await this.sendFn(task.parentSessionId, message);

      // Emit success event
      const successEvent: NotificationSentEvent = {
        type: 'notification.sent',
        taskId: task.id,
        timestamp: new Date(),
        version: task.stateVersion + 1,
        parentSessionId: task.parentSessionId,
      };
      globalEventBus.emit(successEvent);
    } catch {
      // Fail silently - if session is closed, no need to notify
      // This is expected behavior when parent session ends
    }
  }

  /** Build notification message for a task */
  private buildNotificationMessage(task: BackgroundTask): {
    type: string;
    taskId: string;
    status: string;
    description: string;
  } {
    return {
      type: 'background_task_complete',
      taskId: task.id,
      status: task.status,
      description: task.description,
    };
  }
}
