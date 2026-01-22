import { describe, expect, test, beforeEach, mock } from "bun:test"
import { BackgroundTaskManager, type BackgroundTask, type LaunchOptions } from "./background-manager"

// Mock the plugin context
function createMockContext(overrides?: {
  sessionCreateResult?: { data?: { id?: string } }
  sessionStatusResult?: { data?: Record<string, { type: string }> }
  sessionMessagesResult?: { data?: Array<{ info?: { role: string }; parts?: Array<{ type: string; text?: string }> }> }
}) {
  return {
    client: {
      session: {
        create: mock(async () => overrides?.sessionCreateResult ?? { data: { id: "test-session-id" } }),
        status: mock(async () => overrides?.sessionStatusResult ?? { data: {} }),
        messages: mock(async () => overrides?.sessionMessagesResult ?? { data: [] }),
        prompt: mock(async () => ({})),
      },
    },
    directory: "/test/directory",
  } as any
}

describe("BackgroundTaskManager", () => {
  describe("constructor", () => {
    test("creates manager with tmux disabled by default", () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)
      // Manager should be created without errors
      expect(manager).toBeDefined()
    })

    test("creates manager with tmux config", () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx, { enabled: true, layout: "main-vertical", main_pane_size: 60 })
      expect(manager).toBeDefined()
    })
  })

  describe("launch", () => {
    test("creates new session and task", async () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)

      const task = await manager.launch({
        agent: "explorer",
        prompt: "Find all test files",
        description: "Test file search",
        parentSessionId: "parent-123",
      })

      expect(task.id).toMatch(/^bg_/)
      expect(task.sessionId).toBe("test-session-id")
      expect(task.agent).toBe("explorer")
      expect(task.description).toBe("Test file search")
      expect(task.status).toBe("running")
      expect(task.startedAt).toBeDefined()
    })

    test("throws when session creation fails", async () => {
      const ctx = createMockContext({ sessionCreateResult: { data: {} } })
      const manager = new BackgroundTaskManager(ctx)

      await expect(
        manager.launch({
          agent: "explorer",
          prompt: "test",
          description: "test",
          parentSessionId: "parent-123",
        })
      ).rejects.toThrow("Failed to create background session")
    })

    test("passes model to prompt when provided", async () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)

      await manager.launch({
        agent: "explorer",
        prompt: "test",
        description: "test",
        parentSessionId: "parent-123",
        model: "custom/model",
      })

      expect(ctx.client.session.prompt).toHaveBeenCalled()
    })
  })

  describe("getResult", () => {
    test("returns null for unknown task", async () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)

      const result = await manager.getResult("unknown-task-id")
      expect(result).toBeNull()
    })

    test("returns task immediately when not blocking", async () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)

      const task = await manager.launch({
        agent: "explorer",
        prompt: "test",
        description: "test",
        parentSessionId: "parent-123",
      })

      const result = await manager.getResult(task.id, false)
      expect(result).toBeDefined()
      expect(result?.id).toBe(task.id)
    })

    test("returns completed task immediately even when blocking", async () => {
      const ctx = createMockContext({
        sessionStatusResult: { data: { "test-session-id": { type: "idle" } } },
        sessionMessagesResult: {
          data: [
            { info: { role: "assistant" }, parts: [{ type: "text", text: "Result text" }] },
          ],
        },
      })
      const manager = new BackgroundTaskManager(ctx)

      const task = await manager.launch({
        agent: "explorer",
        prompt: "test",
        description: "test",
        parentSessionId: "parent-123",
      })

      const result = await manager.getResult(task.id, true)
      expect(result?.status).toBe("completed")
      expect(result?.result).toBe("Result text")
    })
  })

  describe("cancel", () => {
    test("cancels specific running task", async () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)

      const task = await manager.launch({
        agent: "explorer",
        prompt: "test",
        description: "test",
        parentSessionId: "parent-123",
      })

      const count = manager.cancel(task.id)
      expect(count).toBe(1)

      const result = await manager.getResult(task.id)
      expect(result?.status).toBe("failed")
      expect(result?.error).toBe("Cancelled by user")
    })

    test("returns 0 when cancelling unknown task", () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)

      const count = manager.cancel("unknown-task-id")
      expect(count).toBe(0)
    })

    test("cancels all running tasks when no ID provided", async () => {
      const ctx = createMockContext()
      // Make each call return a different session ID
      let callCount = 0
      ctx.client.session.create = mock(async () => {
        callCount++
        return { data: { id: `session-${callCount}` } }
      })
      const manager = new BackgroundTaskManager(ctx)

      await manager.launch({
        agent: "explorer",
        prompt: "test1",
        description: "test1",
        parentSessionId: "parent-123",
      })

      await manager.launch({
        agent: "oracle",
        prompt: "test2",
        description: "test2",
        parentSessionId: "parent-123",
      })

      const count = manager.cancel()
      expect(count).toBe(2)
    })

    test("does not cancel already completed tasks", async () => {
      const ctx = createMockContext({
        sessionStatusResult: { data: { "test-session-id": { type: "idle" } } },
        sessionMessagesResult: {
          data: [
            { info: { role: "assistant" }, parts: [{ type: "text", text: "Done" }] },
          ],
        },
      })
      const manager = new BackgroundTaskManager(ctx)

      const task = await manager.launch({
        agent: "explorer",
        prompt: "test",
        description: "test",
        parentSessionId: "parent-123",
      })

      // Use getResult with block=true to wait for completion 
      // This triggers polling immediately rather than relying on interval
      const result = await manager.getResult(task.id, true, 5000)
      expect(result?.status).toBe("completed")

      // Now try to cancel - should fail since already completed
      const count = manager.cancel(task.id)
      expect(count).toBe(0) // Already completed, so not cancelled
    })
  })
})

describe("BackgroundTask logic", () => {
  test("extracts content from multiple types and messages", async () => {
    const ctx = createMockContext({
      sessionStatusResult: { data: { "test-session-id": { type: "idle" } } },
      sessionMessagesResult: {
        data: [
          {
            info: { role: "assistant" },
            parts: [
              { type: "reasoning", text: "I am thinking..." },
              { type: "text", text: "First part." }
            ]
          },
          {
            info: { role: "assistant" },
            parts: [
              { type: "text", text: "Second part." },
              { type: "text", text: "" } // Should be ignored
            ]
          }
        ]
      }
    })
    const manager = new BackgroundTaskManager(ctx)
    const task = await manager.launch({ agent: "test", prompt: "test", description: "test", parentSessionId: "p1" })

    const result = await manager.getResult(task.id, true)
    expect(result?.status).toBe("completed")
    expect(result?.result).toContain("I am thinking...")
    expect(result?.result).toContain("First part.")
    expect(result?.result).toContain("Second part.")
    // Check for double newline join
    expect(result?.result).toBe("I am thinking...\n\nFirst part.\n\nSecond part.")
  })

  test("task has completedAt timestamp on success or failure", async () => {
    const ctx = createMockContext({
      sessionStatusResult: { data: { "test-session-id": { type: "idle" } } },
      sessionMessagesResult: { data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] }] }
    })
    const manager = new BackgroundTaskManager(ctx)

    // Test success timestamp
    const task1 = await manager.launch({ agent: "test", prompt: "t1", description: "d1", parentSessionId: "p1" })
    await manager.getResult(task1.id, true)
    expect(task1.completedAt).toBeInstanceOf(Date)

    // Test cancellation timestamp
    const task2 = await manager.launch({ agent: "test", prompt: "t2", description: "d2", parentSessionId: "p2" })
    manager.cancel(task2.id)
    expect(task2.completedAt).toBeInstanceOf(Date)
    expect(task2.status).toBe("failed")
  })
})
