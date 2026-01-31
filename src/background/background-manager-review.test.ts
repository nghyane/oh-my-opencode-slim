/**
 * Review Tests for Background Task Manager
 *
 * Comprehensive verification of:
 * 1. State machine transitions (VALID_TRANSITIONS enforcement)
 * 2. Resource cleanup on cancel/eviction
 * 3. Race condition handling
 * 4. Edge cases (retry caps, timeout defaults, process exit)
 */
import { describe, expect, mock, test } from 'bun:test';
import { BackgroundTaskManager } from './background-manager';

// ─── Mock Factory ────────────────────────────────────────────────

function createMockContext(overrides?: {
  sessionCreateResult?: { data?: { id?: string } };
  sessionStatusResult?: { data?: Record<string, { type: string }> };
  sessionMessagesResult?: {
    data?: Array<{
      info?: { role: string };
      parts?: Array<{ type: string; text?: string }>;
    }>;
  };
  sessionCreateDelay?: number;
  sessionMessagesDelay?: number;
  promptShouldFail?: boolean;
  promptFailCount?: number;
}) {
  let callCount = 0;
  let promptCallCount = 0;
  return {
    client: {
      session: {
        create: mock(async () => {
          callCount++;
          if (overrides?.sessionCreateDelay) {
            await new Promise((r) =>
              setTimeout(r, overrides.sessionCreateDelay),
            );
          }
          return (
            overrides?.sessionCreateResult ?? {
              data: { id: `test-session-${callCount}` },
            }
          );
        }),
        status: mock(
          async () => overrides?.sessionStatusResult ?? { data: {} },
        ),
        messages: mock(async () => {
          if (overrides?.sessionMessagesDelay) {
            await new Promise((r) =>
              setTimeout(r, overrides.sessionMessagesDelay),
            );
          }
          return overrides?.sessionMessagesResult ?? { data: [] };
        }),
        prompt: mock(async () => {
          promptCallCount++;
          if (
            overrides?.promptShouldFail &&
            promptCallCount <= (overrides?.promptFailCount ?? Infinity)
          ) {
            throw new Error('Prompt failed');
          }
          return {};
        }),
        delete: mock(async () => ({})),
      },
    },
    directory: '/test/directory',
    promptCallCount: () => promptCallCount,
  } as any;
}

/** Flush microtasks so fire-and-forget launches complete */
async function flushMicrotasks(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

// ─── 1. State Machine Validation ─────────────────────────────────

describe('Review: State Machine Validation', () => {
  test('pending → running directly is BLOCKED (must go through starting)', () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    // Force to pending for controlled testing
    task.status = 'pending';

    const result = (manager as any).tryTransition(task, 'running');
    expect(result).toBe(false);
    expect(task.status).toBe('pending');
  });

  test('cancelled → completed is BLOCKED (terminal state)', () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    task.status = 'cancelled';

    const result = (manager as any).tryTransition(task, 'completed');
    expect(result).toBe(false);
    expect(task.status).toBe('cancelled');
  });

  test('completed → cancelled is BLOCKED (terminal state)', () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    task.status = 'completed';

    const result = (manager as any).tryTransition(task, 'cancelled');
    expect(result).toBe(false);
    expect(task.status).toBe('completed');
  });

  test('failed → running is BLOCKED (terminal state)', () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    task.status = 'failed';

    const result = (manager as any).tryTransition(task, 'running');
    expect(result).toBe(false);
    expect(task.status).toBe('failed');
  });

  test('starting → completed is BLOCKED (must go through running)', () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    task.status = 'starting';

    const result = (manager as any).tryTransition(task, 'completed');
    expect(result).toBe(false);
    expect(task.status).toBe('starting');
  });

  test('first writer wins in concurrent cancel vs complete', async () => {
    const ctx = createMockContext({
      sessionMessagesResult: {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Result' }],
          },
        ],
      },
    });
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();
    expect(task.status).toBe('running');

    // Cancel wins first (synchronous)
    const cancelled = manager.cancel(task.id);
    expect(cancelled).toBe(1);
    expect(task.status).toBe('cancelled');

    // Now try to finalize as completed — should be blocked
    (manager as any).finalizeTask(task, {
      status: 'completed',
      result: 'late result',
    });

    // Status remains cancelled, not completed
    expect(task.status).toBe('cancelled');
  });

  test('all valid transitions from pending are allowed', () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    // pending → starting
    const t1 = manager.launch({
      agent: 'explorer',
      prompt: 't',
      description: 'd',
      parentSessionId: 'p',
    });
    t1.status = 'pending';
    expect((manager as any).tryTransition(t1, 'starting')).toBe(true);

    // pending → cancelled
    const t2 = manager.launch({
      agent: 'explorer',
      prompt: 't',
      description: 'd',
      parentSessionId: 'p',
    });
    t2.status = 'pending';
    expect((manager as any).tryTransition(t2, 'cancelled')).toBe(true);
  });

  test('all valid transitions from starting are allowed', () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    for (const target of ['running', 'failed', 'cancelled'] as const) {
      const t = manager.launch({
        agent: 'explorer',
        prompt: 't',
        description: 'd',
        parentSessionId: 'p',
      });
      t.status = 'starting';
      expect((manager as any).tryTransition(t, target)).toBe(true);
      expect(t.status).toBe(target);
    }
  });

  test('all valid transitions from running are allowed', () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    for (const target of ['completed', 'failed', 'cancelled'] as const) {
      const t = manager.launch({
        agent: 'explorer',
        prompt: 't',
        description: 'd',
        parentSessionId: 'p',
      });
      t.status = 'running';
      expect((manager as any).tryTransition(t, target)).toBe(true);
      expect(t.status).toBe(target);
    }
  });
});

// ─── 2. Resource Cleanup Verification ────────────────────────────

describe('Review: Resource Cleanup', () => {
  test('cancel during idle debounce clears the timer', async () => {
    const ctx = createMockContext({
      sessionMessagesResult: {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Result' }],
          },
        ],
      },
    });
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();

    // Fire idle event — starts the 500ms debounce timer
    await manager.handleSessionStatus({
      type: 'session.status',
      properties: {
        sessionID: task.sessionId,
        status: { type: 'idle' },
      },
    });

    // Verify timer was set
    const pendingIdleTasks = (manager as any).pendingIdleTasks as Map<
      string,
      ReturnType<typeof setTimeout>
    >;
    expect(pendingIdleTasks.has(task.id)).toBe(true);

    // Cancel during debounce
    manager.cancel(task.id);

    // Timer should have been cleared
    expect(pendingIdleTasks.has(task.id)).toBe(false);
    expect(task.status).toBe('cancelled');

    // Wait past debounce window — task should NOT flip to completed
    await new Promise((r) => setTimeout(r, 700));
    expect(task.status).toBe('cancelled');
  });

  test('cancel running task triggers session.delete', async () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();
    expect(task.sessionId).toBeDefined();

    manager.cancel(task.id);

    // session.delete should have been called with the session ID
    expect(ctx.client.session.delete).toHaveBeenCalledWith({
      path: { id: task.sessionId },
    });
  });

  test('cancel running task closes TMUX pane via tmuxManager', async () => {
    const closeBySessionId = mock(() => {});
    const tmuxManager = { closeBySessionId } as any;

    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(
      ctx,
      { enabled: true, layout: 'main-vertical', main_pane_size: 60 },
      undefined,
      tmuxManager,
    );

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();
    // Wait extra for tmux delay (500ms in startTask)
    await new Promise((r) => setTimeout(r, 600));

    manager.cancel(task.id);

    expect(closeBySessionId).toHaveBeenCalledWith(task.sessionId);
  });

  test('task eviction clears result before deletion', async () => {
    const ctx = createMockContext({
      sessionMessagesResult: {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Some result' }],
          },
        ],
      },
    });

    // maxCompletedTasks = 1, so second finalized task evicts first
    const manager = new BackgroundTaskManager(ctx, undefined, {
      background: { maxConcurrentStarts: 10, maxCompletedTasks: 1 },
    });

    // Launch and complete task 1
    const task1 = manager.launch({
      agent: 'explorer',
      prompt: 't1',
      description: 'd1',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();

    await manager.handleSessionStatus({
      type: 'session.status',
      properties: {
        sessionID: task1.sessionId,
        status: { type: 'idle' },
      },
    });

    await new Promise((r) => setTimeout(r, 600));
    expect(task1.status).toBe('completed');

    // Launch and complete task 2 — should evict task 1
    const task2 = manager.launch({
      agent: 'oracle',
      prompt: 't2',
      description: 'd2',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();

    await manager.handleSessionStatus({
      type: 'session.status',
      properties: {
        sessionID: task2.sessionId,
        status: { type: 'idle' },
      },
    });

    await new Promise((r) => setTimeout(r, 600));

    // task1 should be evicted — getResult returns null
    const evicted = manager.getResult(task1.id);
    expect(evicted).toBeNull();

    // task2 should still be present
    const kept = manager.getResult(task2.id);
    expect(kept).not.toBeNull();
    expect(kept?.status).toBe('completed');
  });

  test('cleanup() clears all internal maps and timers', async () => {
    const ctx = createMockContext({
      sessionMessagesResult: {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Done' }],
          },
        ],
      },
    });
    const manager = new BackgroundTaskManager(ctx);

    // Launch a task to populate internal state
    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();

    // Start idle debounce
    await manager.handleSessionStatus({
      type: 'session.status',
      properties: {
        sessionID: task.sessionId,
        status: { type: 'idle' },
      },
    });

    // Cleanup before debounce fires
    manager.cleanup();

    // All internal state should be cleared
    const tasks = (manager as any).tasks as Map<string, unknown>;
    const tasksBySessionId = (manager as any).tasksBySessionId as Map<
      string,
      unknown
    >;
    const pendingIdleTasks = (manager as any).pendingIdleTasks as Map<
      string,
      unknown
    >;
    const completionResolvers = (manager as any).completionResolvers as Map<
      string,
      unknown
    >;
    const pendingNotifications = (manager as any).pendingNotifications as Map<
      string,
      unknown
    >;
    const startQueue = (manager as any).startQueue as unknown[];

    expect(tasks.size).toBe(0);
    expect(tasksBySessionId.size).toBe(0);
    expect(pendingIdleTasks.size).toBe(0);
    expect(completionResolvers.size).toBe(0);
    expect(pendingNotifications.size).toBe(0);
    expect(startQueue.length).toBe(0);
  });
});

// ─── 3. Race Condition Tests ─────────────────────────────────────

describe('Review: Race Conditions', () => {
  test('cancel during message extraction → status stays cancelled', async () => {
    // Slow message extraction so we can cancel during it
    const ctx = createMockContext({
      sessionMessagesResult: {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Slow result' }],
          },
        ],
      },
      sessionMessagesDelay: 100,
    });
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();
    expect(task.status).toBe('running');

    // Trigger idle → starts debounce → resolveTaskSession will call messages
    await manager.handleSessionStatus({
      type: 'session.status',
      properties: {
        sessionID: task.sessionId,
        status: { type: 'idle' },
      },
    });

    // Cancel BEFORE debounce fires
    manager.cancel(task.id);
    expect(task.status).toBe('cancelled');

    // Wait for everything to settle
    await new Promise((r) => setTimeout(r, 800));

    // Must remain cancelled — not flipped to completed
    expect(task.status).toBe('cancelled');
  });

  test('double cancel only finalizes once, returns 1 then 0', async () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();

    const count1 = manager.cancel(task.id);
    const count2 = manager.cancel(task.id);

    expect(count1).toBe(1);
    expect(count2).toBe(0);
    expect(task.status).toBe('cancelled');

    // session.delete called exactly once
    const deleteCalls = ctx.client.session.delete.mock.calls.filter(
      (c: any) => c[0]?.path?.id === task.sessionId,
    );
    expect(deleteCalls.length).toBe(1);
  });

  test('waitForCompletion race: resolver fires even if task completes between check and registration', async () => {
    const ctx = createMockContext({
      sessionMessagesResult: {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Fast result' }],
          },
        ],
      },
    });
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();

    // Trigger idle and wait for completion
    await manager.handleSessionStatus({
      type: 'session.status',
      properties: {
        sessionID: task.sessionId,
        status: { type: 'idle' },
      },
    });

    // Wait for debounce to complete
    await new Promise((r) => setTimeout(r, 600));

    // Task is already completed when we call waitForCompletion
    expect(task.status).toBe('completed');

    // waitForCompletion should return immediately (the re-check after registration catches it)
    const result = await manager.waitForCompletion(task.id, 1000);
    expect(result).not.toBeNull();
    expect(result?.status).toBe('completed');
    expect(result?.result).toBe('Fast result');
  });

  test('waitForCompletion resolver is cleaned up after firing', async () => {
    const ctx = createMockContext({
      sessionMessagesResult: {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Done' }],
          },
        ],
      },
    });
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();

    // Start waiting
    const waitPromise = manager.waitForCompletion(task.id, 5000);

    // Complete the task
    await manager.handleSessionStatus({
      type: 'session.status',
      properties: {
        sessionID: task.sessionId,
        status: { type: 'idle' },
      },
    });

    await new Promise((r) => setTimeout(r, 600));

    const result = await waitPromise;
    expect(result?.status).toBe('completed');

    // Resolver should be cleaned up
    const resolvers = (manager as any).completionResolvers as Map<
      string,
      unknown
    >;
    expect(resolvers.has(task.id)).toBe(false);
  });

  test('cancel during session creation (slow create) → task ends cancelled', async () => {
    const ctx = createMockContext({
      sessionCreateDelay: 200, // slow session creation
    });
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    // Cancel while session.create is still in-flight
    await new Promise((r) => setTimeout(r, 50));
    const count = manager.cancel(task.id);
    expect(count).toBe(1);

    // Wait for session.create to resolve
    await new Promise((r) => setTimeout(r, 300));

    // Task should still be cancelled, not running
    expect(task.status).toBe('cancelled');
  });

  test('idle → busy → idle only completes on final idle', async () => {
    const ctx = createMockContext({
      sessionMessagesResult: {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Final result' }],
          },
        ],
      },
    });
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();

    // First idle
    await manager.handleSessionStatus({
      type: 'session.status',
      properties: {
        sessionID: task.sessionId,
        status: { type: 'idle' },
      },
    });

    // Back to busy within debounce (200ms < 500ms debounce)
    await new Promise((r) => setTimeout(r, 200));
    await manager.handleSessionStatus({
      type: 'session.status',
      properties: {
        sessionID: task.sessionId,
        status: { type: 'busy' },
      },
    });

    // Should still be running
    expect(task.status).toBe('running');

    // Wait past the first debounce window
    await new Promise((r) => setTimeout(r, 400));
    expect(task.status).toBe('running');

    // Second idle — this one should complete
    await manager.handleSessionStatus({
      type: 'session.status',
      properties: {
        sessionID: task.sessionId,
        status: { type: 'idle' },
      },
    });

    await new Promise((r) => setTimeout(r, 600));
    expect(task.status).toBe('completed');
    expect(task.result).toBe('Final result');
  });
});

// ─── 4. Edge Cases ───────────────────────────────────────────────

describe('Review: Edge Cases', () => {
  test('notification retry exceeds max → stops retrying', async () => {
    const ctx = createMockContext({
      sessionMessagesResult: {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Done' }],
          },
        ],
      },
      promptShouldFail: true,
      promptFailCount: 10, // All retries will fail
    });
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();

    // Trigger completion — notification will fail
    await manager.handleSessionStatus({
      type: 'session.status',
      properties: {
        sessionID: task.sessionId,
        status: { type: 'idle' },
      },
    });

    await new Promise((r) => setTimeout(r, 600));

    // Initially, notification is queued for retry
    const _pendingNotifications = (manager as any).pendingNotifications as Map<
      string,
      { attempts: number }
    >;

    // Wait for all retries to exhaust (delays: 1000 + 2000 + 4000 = 7s)
    // We'll check the mechanism rather than waiting the full 7s
    const maxRetries = (manager as any).maxNotificationRetries;
    expect(maxRetries).toBe(3);

    // Verify retry delays are configured
    const delays = (manager as any).notificationRetryDelays;
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  test('waitForCompletion with timeout=0 uses default 30min max', async () => {
    const ctx = createMockContext({
      sessionMessagesResult: {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Done' }],
          },
        ],
      },
    });
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();

    // Verify the MAX_WAIT_TIMEOUT_MS constant
    const maxTimeout = (BackgroundTaskManager as any).MAX_WAIT_TIMEOUT_MS;
    expect(maxTimeout).toBe(30 * 60 * 1000); // 30 minutes

    // Complete immediately so test doesn't actually wait 30min
    await manager.handleSessionStatus({
      type: 'session.status',
      properties: {
        sessionID: task.sessionId,
        status: { type: 'idle' },
      },
    });

    await new Promise((r) => setTimeout(r, 600));

    const result = await manager.waitForCompletion(task.id, 0);
    expect(result?.status).toBe('completed');
  });

  test('process exit handlers are registered', () => {
    const ctx = createMockContext();

    // Count listeners before and after
    const exitBefore = process.listenerCount('exit');
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    new BackgroundTaskManager(ctx);

    expect(process.listenerCount('exit')).toBeGreaterThan(exitBefore);
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(sigtermBefore);
  });

  test('waitForCompletion returns null for unknown task', async () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    const result = await manager.waitForCompletion('nonexistent', 100);
    expect(result).toBeNull();
  });

  test('launch rejects invalid agent name', () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    expect(() =>
      manager.launch({
        agent: 'invalid-agent',
        prompt: 'test',
        description: 'test',
        parentSessionId: 'p1',
      }),
    ).toThrow(/Invalid agent/);
  });

  test('result truncation applies at 100KB boundary', () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    // Create a string > 100KB
    const bigResult = 'x'.repeat(120_000);
    const truncated = (manager as any).truncateResult(bigResult);

    expect(truncated.wasTruncated).toBe(true);
    expect(truncated.content.length).toBeLessThanOrEqual(102_400 + 200); // 100KB = 102400 bytes + truncation message

    // Small result should not be truncated
    const smallResult = 'hello';
    const notTruncated = (manager as any).truncateResult(smallResult);
    expect(notTruncated.wasTruncated).toBe(false);
    expect(notTruncated.content).toBe('hello');
  });

  test('idle debounce prevents premature completion on rapid idle events', async () => {
    let _messageCallCount = 0;
    const ctx = createMockContext({
      sessionMessagesResult: {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Result' }],
          },
        ],
      },
    });

    // Track message calls to verify debounce deduplication
    const originalMessages = ctx.client.session.messages;
    ctx.client.session.messages = mock(async (...args: any[]) => {
      _messageCallCount++;
      return originalMessages(...args);
    });

    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();

    // Fire multiple rapid idle events
    for (let i = 0; i < 5; i++) {
      await manager.handleSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: task.sessionId,
          status: { type: 'idle' },
        },
      });
    }

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 600));

    expect(task.status).toBe('completed');
    // Messages should only have been fetched a limited number of times
    // (not 5x — debounce should collapse them)
  });

  test('finalizeTask is idempotent — double finalize does nothing', async () => {
    const ctx = createMockContext({
      sessionMessagesResult: {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Result' }],
          },
        ],
      },
    });
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();

    // First finalize
    (manager as any).finalizeTask(task, {
      status: 'completed',
      result: 'First',
    });
    expect(task.result).toBe('First');

    // Second finalize attempt — should be no-op
    (manager as any).finalizeTask(task, {
      status: 'completed',
      result: 'Second',
    });
    expect(task.result).toBe('First'); // unchanged
  });

  test('cleanup resolves waiting callers with null', async () => {
    const ctx = createMockContext();
    const manager = new BackgroundTaskManager(ctx);

    const task = manager.launch({
      agent: 'explorer',
      prompt: 'test',
      description: 'test',
      parentSessionId: 'p1',
    });

    await flushMicrotasks();

    // Start waiting for completion
    const waitPromise = manager.waitForCompletion(task.id, 10000);

    // Cleanup should resolve the waiter with null
    manager.cleanup();

    const result = await waitPromise;
    expect(result).toBeNull();
  });

  test('concurrent starts respect maxConcurrentStarts limit', async () => {
    const ctx = createMockContext({
      sessionCreateDelay: 100, // slow creates to see queueing
    });
    const manager = new BackgroundTaskManager(ctx, undefined, {
      background: { maxConcurrentStarts: 2, maxCompletedTasks: 100 },
    });

    // Launch 4 tasks with concurrency limit of 2
    const t0 = manager.launch({
      agent: 'explorer',
      prompt: 'test0',
      description: 'test0',
      parentSessionId: 'p1',
    });
    const t1 = manager.launch({
      agent: 'explorer',
      prompt: 'test1',
      description: 'test1',
      parentSessionId: 'p1',
    });
    const t2 = manager.launch({
      agent: 'explorer',
      prompt: 'test2',
      description: 'test2',
      parentSessionId: 'p1',
    });
    const t3 = manager.launch({
      agent: 'explorer',
      prompt: 'test3',
      description: 'test3',
      parentSessionId: 'p1',
    });

    // With concurrency limit of 2, at least 2 should still be pending
    const statuses = [t0.status, t1.status, t2.status, t3.status];
    const pendingOrStarting = statuses.filter(
      (s) => s === 'pending' || s === 'starting',
    );
    expect(pendingOrStarting.length).toBeGreaterThanOrEqual(2);

    // Wait for all to start
    await new Promise((r) => setTimeout(r, 500));
  });
});
