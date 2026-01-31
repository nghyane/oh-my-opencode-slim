import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BackgroundTask } from './background-manager';

export interface PersistedTask {
  id: string;
  sessionId?: string;
  description: string;
  agent: string;
  status: BackgroundTask['status'];
  stateVersion: number;
  notificationState: BackgroundTask['notificationState'];
  result?: string;
  error?: string;
  isResultTruncated?: boolean;
  parentSessionId: string;
  startedAt: string;
  completedAt?: string;
  prompt: string;
  config: {
    maxConcurrentStarts: number;
    maxCompletedTasks: number;
  };
}

export class TaskPersistence {
  private filePath: string;

  constructor(directory: string) {
    this.filePath = resolve(directory, '.opencode', 'background-tasks.json');
  }

  async save(tasks: Map<string, BackgroundTask>): Promise<void> {
    const data: Record<string, PersistedTask> = {};
    for (const [id, task] of tasks) {
      data[id] = this.serialize(task);
    }
    await writeFile(this.filePath, JSON.stringify(data, null, 2));
  }

  async load(): Promise<Map<string, PersistedTask>> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(content) as Record<string, PersistedTask>;
      return new Map(Object.entries(data));
    } catch {
      return new Map();
    }
  }

  async delete(): Promise<void> {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(this.filePath);
    } catch {
      // File doesn't exist, ignore
    }
  }

  private serialize(task: BackgroundTask): PersistedTask {
    return {
      id: task.id,
      sessionId: task.sessionId,
      description: task.description,
      agent: task.agent,
      status: task.status,
      stateVersion: task.stateVersion,
      notificationState: task.notificationState,
      result: task.result,
      error: task.error,
      isResultTruncated: task.isResultTruncated,
      parentSessionId: task.parentSessionId,
      startedAt: task.startedAt.toISOString(),
      completedAt: task.completedAt?.toISOString(),
      prompt: task.prompt,
      config: task.config,
    };
  }
}
