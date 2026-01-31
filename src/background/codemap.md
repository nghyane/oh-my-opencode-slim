# Background Module Codemap

## Responsibility

The `src/background/` module manages long-running AI agent tasks that execute asynchronously in isolated sessions. It enables fire-and-forget task execution, allowing users to continue working while background tasks complete independently. The module handles task lifecycle management, session creation, completion detection, optional tmux pane integration for visual task tracking, and persistent state recovery after process restarts.

## Design

### Core Abstractions

#### BackgroundTask Interface
Represents a background task with complete lifecycle tracking:
- **id**: Unique task identifier (`bg_<random>`)
- **sessionId**: OpenCode session ID (set when starting)
- **description**: Human-readable task description
- **agent**: Agent name handling the task
- **status**: Task state (`pending` | `starting` | `running` | `completed` | `failed` | `cancelled`)
- **stateVersion**: Integer incremented on each state change for atomic compare-and-swap operations
- **notificationState**: Atomic notification delivery state (`pending` | `sending` | `sent` | `failed`)
- **result**: Final output from agent (when completed)
- **error**: Error message (when failed)
- **isResultTruncated**: Whether result was truncated due to size limit
- **config**: Task configuration
- **parentSessionId**: Parent session for notifications
- **startedAt**: Creation timestamp
- **completedAt**: Completion/failure timestamp
- **prompt**: Initial prompt sent to agent

#### LaunchOptions Interface
Configuration for launching new background tasks:
- **agent**: Agent to handle the task
- **prompt**: Initial prompt to send to the agent
- **description**: Human-readable task description
- **parentSessionId**: Parent session ID for task hierarchy

#### TaskPersistence Interface (NEW)
Handles persistent storage of task state for crash recovery:
- **save(tasks)**: Serializes all tasks to JSON file
- **load()**: Deserializes tasks from JSON file, returns empty Map on failure
- **delete()**: Removes persistence file

### Key Patterns

#### 1. Fire-and-Forget Launch Pattern
Two-phase task launch:
- **Phase A (sync)**: Creates task record and returns immediately with `pending` status
- **Phase B (async)**: Session creation and prompt sending happen in background

#### 2. Start Queue with Concurrency Control and Locking
- Tasks are queued for background start
- Configurable `maxConcurrentStarts` limit (default: 10)
- Queue processing with mutex lock (`queueLock`) prevents concurrent processing
- `pendingQueueProcess` flag ensures queue is reprocessed after current operation
- `startQueueSet` provides O(1) membership testing for queue operations
- Prevents overwhelming the system with simultaneous session starts

#### 3. Event-Driven Completion Detection with Debounce
- Listens to `session.status` events instead of polling
- Uses 500ms debounce (`idleDebounceMs`) to ensure final assistant message is persisted
- Cancels debounce if session becomes `busy` again (agent still working)
- Falls back to polling for reliability

#### 4. Multi-Index Task Tracking
- `tasks` Map: Task ID → BackgroundTask (primary storage)
- `tasksBySessionId` Map: Session ID → Task ID (event routing)
- `tasksByParentSession` Map: Parent Session ID → Set of Task IDs (query by parent)
- `pendingRetrievalsBySession` Map: Parent Session ID → Set of completed Task IDs (notification tracking)

#### 5. Promise-Based Waiting with Resource Cleanup
- `completionResolvers` Map stores pending wait promises
- `waitForCompletion()` returns promise that resolves on task completion
- Supports optional timeout parameter (default: 30 minutes)
- Resources registered with `TaskResourceRegistry` for automatic cleanup

#### 6. Atomic State Transitions with Versioning
- `stateVersion` field enables compare-and-swap (CAS) operations
- `VALID_TRANSITIONS` defines allowed state machine transitions
- `tryTransition()` method atomically validates and applies transitions
- Prevents race conditions during concurrent state updates

#### 7. Task Resource Registry Pattern (NEW)
Centralized cleanup registry for preventing memory leaks:
- `TaskResourceRegistry` manages disposable resources (timers, resolvers)
- `TimerDisposable` wraps idle debounce timers
- `ResolverDisposable` wraps completion promise resolvers
- All resources automatically cleaned up on task finalization

#### 8. Notification Retry with Exponential Backoff (NEW)
- Atomic notification state tracking (`pending` | `sending` | `sent` | `failed`)
- Max retry attempts: 3
- Retry delays: [1000ms, 2000ms, 4000ms] (exponential backoff)
- Pending notifications stored in `pendingNotifications` Map
- Skips notification if `completionResolvers` has task (someone waiting via `background_output`)

#### 9. Memory-Efficient Task Eviction (NEW)
- `taskEvictionQueue` tracks finalized tasks in completion order
- `maxCompletedTasks` limit (default: 100) controls memory usage
- Oldest tasks evicted when limit exceeded
- Sessions deleted from server during eviction to prevent leaks
- Results and errors cleared before eviction

#### 10. Orphaned Task Detection (NEW)
- Periodic sweep every 60 seconds via `orphanedSweepTimer`
- Detects tasks with deleted parent sessions
- Detects stuck tasks (running > 30 minutes)
- Finalizes orphaned tasks with appropriate error messages

### Classes

#### BackgroundTaskManager
Main orchestrator for background task lifecycle:

**State:**
- `tasks`: Map of all tracked tasks
- `tasksBySessionId`: Session ID to task ID mapping
- `tasksByParentSession`: Parent session ID to task IDs mapping
- `client`: OpenCode client API
- `directory`: Working directory for tasks
- `tmuxEnabled`: Whether tmux integration is active
- `pluginConfig`: Plugin configuration
- `taskConfig`: Background task configuration
- `tmuxManager`: Optional TmuxSessionManager reference
- `startQueue`: Array of tasks waiting to start
- `startQueueSet`: Set for O(1) queue membership testing
- `activeStarts`: Count of currently starting tasks
- `maxConcurrentStarts`: Concurrency limit
- `queueLock`: Mutex for queue processing
- `pendingQueueProcess`: Flag for queued reprocessing
- `completionResolvers`: Map of waiting promises
- `pendingNotifications`: Map of notifications pending retry
- `maxNotificationRetries`: Maximum retry attempts (3)
- `notificationRetryDelays`: Array of retry delays
- `orphanedSweepTimer`: Interval for orphaned task detection
- `pendingIdleTasks`: Map of idle debounce timers
- `idleDebounceMs`: Debounce delay (500ms)
- `resourceRegistry`: Centralized resource cleanup registry
- `finalizingTasks`: Set preventing concurrent finalization
- `taskEvictionQueue`: Queue for memory eviction
- `maxCompletedTasks`: Maximum completed tasks to retain
- `pendingRetrievals`: Set of tasks with pending retrieval
- `pendingRetrievalsBySession`: Session ID to pending retrieval IDs

**Key Methods:**
- `launch(opts)`: Create and queue a new background task (sync)
- `handleSessionStatus(event)`: Process session.status events
- `getResult(taskId)`: Retrieve current task state
- `waitForCompletion(taskId, timeout)`: Wait for task completion
- `cancel(taskId?)`: Cancel one or all tasks
- `cleanup()`: Clean up all tasks and resources
- `saveState()`: Persist task state to disk (NEW)
- `loadState()`: Restore task state from disk (NEW)
- `pause()`: Pause accepting new tasks (NEW)
- `resume()`: Resume accepting new tasks (NEW)
- `drain(options)`: Wait for all running tasks to complete (NEW)
- `getRunningTasksForSession(parentSessionId)`: Query running tasks by parent (NEW)
- `getPendingRetrievalsForSession(sessionId)`: Get completed tasks for retrieval (NEW)
 ready- `hasAnyTaskStateForSession(parentSessionId)`: Check for any tasks (NEW)
- `markAsPendingRetrieval(taskId)`: Mark task as retrieved (NEW)
- `clearPendingRetrieval(taskId)`: Clear pending retrieval flag (NEW)

#### TmuxSessionManager
Manages tmux pane lifecycle for background sessions:

**State:**
- `client`: OpenCode client API
- `tmuxConfig`: Tmux configuration
- `serverUrl`: OpenCode server URL
- `sessions`: Map of tracked sessions
- `pollInterval`: Polling timer
- `enabled`: Whether tmux integration is active

**Key Methods:**
- `onSessionCreated(event)`: Spawn tmux pane for child sessions
- `onSessionStatus(event)`: Close pane when session becomes idle
- `pollSessions()`: Fallback polling for status updates
- `closeSession(sessionId)`: Close pane and remove tracking
- `closeBySessionId(sessionId)`: Close pane by session ID (NEW)
- `cleanup()`: Close all panes and stop polling

#### TaskPersistence (NEW)
Handles persistent storage of task state:

**State:**
- `filePath`: Path to persistence file (`.opencode/background-tasks.json`)

**Key Methods:**
- `save(tasks)`: Serialize and persist all tasks
- `load()`: Load and deserialize tasks
- `delete()`: Remove persistence file

### Interfaces

#### TrackedSession (TmuxSessionManager)
- `sessionId`: OpenCode session ID
- `paneId`: Tmux pane identifier
- `parentId`: Parent session ID
- `title`: Session title
- `createdAt`: Creation timestamp
- `lastSeenAt`: Last seen timestamp
- `missingSince`: When session went missing (optional)

#### SessionEvent
- `type`: Event type (`session.created`, `session.status`)
- `properties`: Event properties containing session info

#### PersistedTask (NEW)
- Serialized representation of BackgroundTask for JSON storage
- Uses ISO string for Date fields (startedAt, completedAt)
- Includes all task metadata for crash recovery

## Flow

### Task Launch Flow

```
User calls launch()
  ↓
Validate agent against allowed subagents
  ↓
Create BackgroundTask with status='pending', stateVersion=0, notificationState='pending'
  ↓
Store in tasks Map
  ↓
Update tasksByParentSession secondary index
  ↓
Enqueue in startQueue and startQueueSet
  ↓
processQueue() acquires queueLock
  ↓
While activeStarts < maxConcurrentStarts and queue not empty:
  ↓
  Dequeue task (O(1) with Set lookup)
  ↓
  Check isTaskStartable() (pending | starting)
  ↓
  reserveStartSlot() - atomic transition to 'starting'
  ↓
  Increment activeStarts
  ↓
  startTask() executes (fire-and-forget)
      ↓
      Create OpenCode session with parentID
      ↓
      tryTransition(task, 'running') - CAS with stateVersion
      ↓
      commitSessionMapping() - stores sessionId in tasksBySessionId
      ↓
      Wait 500ms if tmux enabled (gives TmuxSessionManager time to spawn pane)
      ↓
      Resolve agent variant and apply to prompt
      ↓
      Build system prompt with task constraints
      ↓
      Send prompt to session (disables background_task and task tools)
      ↓
      Decrement activeStarts, release queueLock, scheduleQueueProcess()
  ↓
  Release queueLock if no pending reprocess
```

### Completion Detection Flow

```
session.status event received (idle)
  ↓
handleSessionStatus() checks event type
  ↓
Lookup taskId from tasksBySessionId
  ↓
Verify task exists and status === 'running'
  ↓
Check if already finalizing (prevents race)
  ↓
Clear existing idle debounce timer
  ↓
Set new debounce timer (500ms)
  ↓
    Timer fires after debounce
    ↓
    Re-check task status === 'running'
    ↓
    resolveTaskSession()
        ↓
        Check finalizing flag again
        ↓
        Fetch session messages
        ↓
        Filter assistant messages
        ↓
        Extract text and reasoning parts
        ↓
        Join extracted content
        ↓
        finalizeTask() with { status: 'completed', result }
            ↓
            Check finalizing flag (prevent concurrent)
            ↓
            Add to finalizingTasks Set
            ↓
            Check if already terminal (completed | failed)
            ↓
            Try atomic transition to 'completed'
            ↓
            Set completedAt timestamp
            ↓
            Truncate result if exceeding size limit
            ↓
            Clear pending idle timer
            ↓
            Delete from tasksBySessionId (prevent memory leak)
            ↓
            Push to taskEvictionQueue
            ↓
            cleanupOldCompletedTasks() if over limit
            ↓
            sendCompletionNotification(task) with retry logic
                ↓
                Check notificationState === 'pending'
                ↓
                Check completionResolvers doesn't have taskId
                ↓
                Mark notificationState = 'sending'
                ↓
                Check parent session health
                ↓
                Deliver notification message
                ↓
                Mark notificationState = 'sent'
                ↓
                markAsPendingRetrieval(taskId)
            ↓
            Resolve completionResolvers if waiting
            ↓
            resourceRegistry.cleanup(task.id) - dispose all resources
            ↓
            Log completion
            ↓
            Remove from finalizingTasks Set
```

### Cancellation Flow

```
User calls cancel(taskId?)
  ↓
If taskId provided:
  ↓
  doCancelSingleTask(task)
  ↓
Else:
  ↓
  Iterate all tasks, call doCancelSingleTask for each
  ↓
doCancelSingleTask():
  ↓
  Clear pending idle debounce timer
  ↓
  Check if cancellable (pending | starting | running)
  ↓
  Record if in startQueue
  ↓
  tryTransition(task, 'cancelled') - atomic with stateVersion
  ↓
  Remove from startQueue if pending (O(1) with Set)
  ↓
  If sessionId exists:
    ↓
    Delete session from server
    ↓
    tmuxManager.closeBySessionId(sessionId) - NEW method
    ↓
    Extract last assistant message
    ↓
    finalizeTask() with { status: 'cancelled', result }
  ↓
  Else:
    ↓
    finalizeTask() with { status: 'cancelled' }
  ↓
  Return true if cancelled, false otherwise
```

### Tmux Integration Flow

```
session.created event received
  ↓
onSessionCreated() checks enabled and parentID
  ↓
Skip if not child session or already tracked
  ↓
spawnTmuxPane() with session info
  ↓
  Create pane with title
  ↓
  Connect to OpenCode server URL
  ↓
  Return paneId
  ↓
Store in sessions Map with paneId, createdAt, lastSeenAt
  ↓
Start polling (if not already running)
```

```
session.status event received (idle)
  ↓
onSessionStatus() checks enabled
  ↓
closeSession()
  ↓
  closeTmuxPane()
  ↓
  Delete from sessions Map
  ↓
  Stop polling if no sessions left
```

### Polling Fallback Flow (TmuxSessionManager)

```
pollSessions() runs on POLL_INTERVAL_BACKGROUND_MS (5000ms) interval
  ↓
If no sessions tracked, stop polling
  ↓
Fetch all session statuses
  ↓
For each tracked session:
  ↓
  Check status in returned data
  ↓
  If found: update lastSeenAt, clear missingSince
  ↓
  If not found and first time missing: set missingSince
  ↓
  Check idle (completed) → mark to close
  ↓
  Check missingTooLong (> 3 polling intervals) → mark to close
  ↓
  Check timeout (> 10 minutes) → mark to close
  ↓
  Close all marked sessions
```

### Persistence Flow (NEW)

```
saveState() called (e.g., on graceful shutdown)
  ↓
Instantiate TaskPersistence with working directory
  ↓
Iterate all tasks in tasks Map
  ↓
For each task, serialize to PersistedTask:
  ↓
  Convert Date fields to ISO strings
  ↓
  Preserve all metadata
  ↓
Write JSON to .opencode/background-tasks.json
```

```
loadState() called (e.g., on startup after crash)
  ↓
Instantiate TaskPersistence with working directory
  ↓
Read and parse .opencode/background-tasks.json
  ↓
For each persisted task:
  ↓
  If status === 'running' | 'starting':
    ↓
    Mark as 'failed' with error 'Task interrupted by process restart'
  ↓
  Restore BackgroundTask with proper Date conversion
  ↓
  Rebuild all secondary indices:
    ↓
    tasksByParentSession
    ↓
    tasksBySessionId
```

### Lifecycle Management Flow (NEW)

```
pause() called
  ↓
Set internal paused flag
  ↓
Log pause event
```

```
resume() called
  ↓
Clear internal paused flag
  ↓
Log resume event
  ↓
processQueue() resumes processing
```

```
drain({ timeout? }) called
  ↓
Loop until timeout or no running/starting tasks:
  ↓
  Filter tasks by status (running | starting)
  ↓
  If no tasks, return
  ↓
  Wait 1000ms before rechecking
  ↓
  Throw error on timeout
```

### Orphan Detection Flow (NEW)

```
orphanedSweepTimer fires every 60000ms (60 seconds)
  ↓
checkOrphanedSessions()
  ↓
Iterate all tasksBySessionId entries
  ↓
For each running or starting task:
  ↓
  Skip if already finalizing
  ↓
  Check if parent session still exists:
    ↓
    Try fetch session.messages
    ↓
    If fails: parent deleted → finalize as orphaned
        ↓
        Extract last assistant message
        ↓
        finalizeTask() with failed status and error
    ↓
    If succeeds: check for timeout
        ↓
        If running > 30 minutes:
            ↓
            Extract last assistant message
            ↓
            finalizeTask() with failed status and timeout error
```

## Integration

### Dependencies

#### Internal Dependencies
- `@opencode-ai/plugin`: PluginInput type, client API
- `../agents`: isSubagent, SUBAGENT_NAMES for validation
- `../config`: BackgroundTaskConfig, PluginConfig, TmuxConfig, POLL_INTERVAL_BACKGROUND_MS
- `../config/constants`: BACKGROUND_MAX_RESULT_SIZE, BACKGROUND_RESULT_TRUNCATION_MESSAGE
- `../config/schema`: TmuxConfig type
- `../utils`: applyAgentVariant, resolveAgentVariant, log
- `../utils/tmux`: tmux utilities (spawnTmuxPane, closeTmuxPane, isInsideTmux)
- `./persistence`: TaskPersistence class (NEW)

#### External Dependencies
- `node:crypto`: randomUUID for task ID generation
- `node:fs/promises`: File I/O for persistence (NEW)
- `node:path`: Path resolution for persistence (NEW)

### Consumers

#### Direct Consumers
- Main plugin entry point (`src/index.ts`)
- Background task skill (`src/skills/background-task.ts`)

#### Integration Points

1. **Plugin Initialization**
   - BackgroundTaskManager instantiated with PluginInput, TmuxConfig, PluginConfig, and optional TmuxSessionManager
   - TmuxSessionManager instantiated with PluginInput and TmuxConfig
   - Both managers register for session events

2. **Event Handling**
   - BackgroundTaskManager handles `session.status` for completion detection
   - TmuxSessionManager handles `session.created` and `session.status`

3. **Skill Integration**
   - Background task skill calls `launch()` to create tasks
   - Skill calls `getResult()` and `waitForCompletion()` to retrieve results
   - Skill calls `cancel()` to cancel tasks
   - Skill may call `saveState()` and `loadState()` for persistence (NEW)

4. **Cleanup**
   - Both managers provide `cleanup()` methods
   - Called during plugin shutdown to release resources
   - BackgroundTaskManager also handles `process` exit signals (SIGINT, SIGTERM)

5. **Tmux Coordination**
   - BackgroundTaskManager passes tmuxManager reference to TmuxSessionManager
   - TmuxSessionManager closes panes on cancellation via `closeBySessionId()` (NEW)
   - BackgroundTaskManager waits 500ms after session creation for pane spawn

### Configuration

#### BackgroundTaskConfig
- `maxConcurrentStarts`: Maximum concurrent task starts (default: 10)
- `maxCompletedTasks`: Maximum completed tasks to retain in memory (default: 100) - NEW

#### TmuxConfig
- `enabled`: Whether tmux integration is active
- Additional tmux-specific settings (see `../config/schema`)

### Error Handling

- Session creation failures mark tasks as `failed` with error message
- Message extraction failures mark tasks as `failed` but preserve last output
- Tmux pane spawn failures are logged but don't fail the task
- Polling errors are logged but don't stop the manager
- Notification failures trigger retry with exponential backoff
- Parent session deletion triggers orphaned task detection
- Process restart marks running tasks as failed with appropriate error
- State serialization failures are logged but don't crash the manager
- Concurrent finalization attempts are prevented via `finalizingTasks` Set
- State transition conflicts are blocked with version check

### Logging

All operations are logged with context:
- Task launch, start, completion, failure, cancellation
- State transitions blocked (with from/to states)
- Session creation and pane spawning
- Polling lifecycle (start/stop)
- Resource cleanup events
- Notification send/retry/success/failure
- Persistence save/load operations
- Orphan detection sweep results
- Error conditions with stack traces where applicable

Logs use the format `[component-name] message` with structured metadata for debugging.
