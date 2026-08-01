/**
 * Task augmentation (MCP 2025-11-25, SEP-1686).
 *
 * A task-augmented `tools/call` returns a handle immediately instead of the
 * result, and the client polls `tasks/get` / `tasks/result` for the outcome.
 * That decouples the tool's runtime from the HTTP request's lifetime, which
 * matters when a proxy or client timeout is shorter than a slow Starlink query.
 *
 * The SDK registers the `tasks/*` handlers itself once a TaskStore is passed to
 * the Server; this module supplies the store and the tools/call side.
 *
 * OFF BY DEFAULT, and deliberately so. Task execution outlives the HTTP
 * response, which needs two things a default Cloud Run service does not give
 * you: CPU that keeps running after the response is sent (deploy with
 * --no-cpu-throttling) and a store every instance can reach (Firestore, since
 * the polling request may land on a different instance than the one that
 * started the work). Enable with MCP_TASKS=true once both hold.
 */

import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/index.js';
import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/index.js';
import type { RequestTaskStore } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';

/** Default task retention after completion (ms). */
const DEFAULT_TASK_TTL_MS = 15 * 60 * 1000;
/** How often we suggest clients poll (ms). */
const DEFAULT_POLL_INTERVAL_MS = 1000;

export function tasksEnabled(): boolean {
  return process.env.MCP_TASKS === 'true';
}

/**
 * The tasks capability advertised at initialize.
 *
 * We support listing and cancelling, and accept task-augmented `tools/call`.
 * Returns undefined when tasks are off, so the capability is simply absent.
 */
export function tasksCapability(): ServerCapabilities['tasks'] | undefined {
  if (!tasksEnabled()) return undefined;
  return {
    list: {},
    cancel: {},
    requests: { tools: { call: {} } },
  };
}

/**
 * Builds the task store for this process.
 *
 * Firestore is used whenever the deployment is already configured for it,
 * because an in-memory store silently breaks as soon as a second instance
 * exists: the client polls `tasks/get`, the load balancer routes it to an
 * instance that never saw the task, and it 404s.
 */
export async function createTaskStore(): Promise<TaskStore | undefined> {
  if (!tasksEnabled()) return undefined;

  if (process.env.MCP_PERSISTENCE === 'firestore') {
    const { FirestoreTaskStore } = await import('./firestore-task-store.js');
    return new FirestoreTaskStore({
      collection: process.env.MCP_TASKS_COLLECTION,
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
    });
  }

  logger.warn(
    'Tasks enabled with an in-memory store. Tasks will not survive a restart and will ' +
      'not be visible to other instances — set MCP_PERSISTENCE=firestore for multi-instance deployments.',
  );
  return new InMemoryTaskStore();
}

/**
 * Starts a tool call as a task and returns the handle.
 *
 * The work runs detached from this request. Failures are recorded on the task
 * rather than thrown, so a client polling `tasks/result` always gets a real
 * answer instead of a request that never resolves.
 */
export async function startToolTask(
  taskStore: RequestTaskStore,
  toolName: string,
  run: () => Promise<CallToolResult | null>,
): Promise<{ task: Awaited<ReturnType<RequestTaskStore['createTask']>> }> {
  const task = await taskStore.createTask({
    ttl: DEFAULT_TASK_TTL_MS,
    pollInterval: DEFAULT_POLL_INTERVAL_MS,
  });

  void (async () => {
    try {
      const result = await run();
      if (result === null) {
        await taskStore.storeTaskResult(task.taskId, 'failed', {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true,
        });
        return;
      }
      // A tool error is still a delivered result: the task completed, and the
      // isError result inside it is what the model needs to see.
      await taskStore.storeTaskResult(task.taskId, 'completed', result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Task execution failed', { taskId: task.taskId, toolName, error: message });
      try {
        await taskStore.storeTaskResult(task.taskId, 'failed', {
          content: [{ type: 'text', text: `Error executing tool ${toolName}: ${message}` }],
          isError: true,
        });
      } catch (storeError) {
        logger.error('Failed to record task failure', {
          taskId: task.taskId,
          error: String(storeError),
        });
      }
    }
  })();

  return { task };
}
