/**
 * Bundled Claude Code-style task tracking and coordination, ported from
 * @tintinweb/pi-tasks.
 *
 * Tools:
 *   TaskCreate   — Create a structured task
 *   TaskList     — List all tasks with status
 *   TaskGet      — Get full task details
 *   TaskUpdate   — Update task fields, status, dependencies
 *   TaskOutput   — Get output from a background task process
 *   TaskStop     — Stop a running background task process
 *   TaskExecute  — Execute tasks as subagents (requires @tintinweb/pi-subagents)
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  canonicalJson,
  type ReadWorkflowAggregateArtifactResult,
  readResultArtifactBody,
  readWorkflowAggregateArtifactBody,
  readWorkflowAggregateArtifactManifest,
} from "../result-artifact.js";
import { SUBAGENTS_RPC_PROTOCOL_VERSION } from "../subagent-contract.js";
import type { ResultArtifactStatus } from "../types.js";
import type { LifetimeUsage } from "../usage.js";
import type { WorkflowChildAttempt, WorkflowCoverageAggregate } from "../workflow/attempt.js";
import { AutoClearManager } from "./auto-clear.js";
import type {
  TaskExecutionBinding,
  TaskExecutionClaim,
  TaskExecutionKind,
  TaskExecutionRef,
  TaskExecutionSettle,
} from "./execution-contract.js";
import { isTaskExecutionClaim, isTaskExecutionRef } from "./execution-contract.js";
import { ProcessTracker } from "./process-tracker.js";
import {
  type CadenceConfig,
  createCadenceState,
  drainReminderForContext,
  evaluateToolResult,
  onTurnStart,
  resetCadenceState,
} from "./reminder-cadence.js";
import { resolveTaskGlyphs } from "./task-glyphs.js";
import {
  assertTaskOutputSafeId,
  formatTaskOutputChildren,
  formatTaskOutputResult,
  formatTaskOutputSummary,
  parseTaskWorkflowAggregateMetadata,
  TASK_OUTPUT_PRIVATE_MARKER,
  TASK_OUTPUT_RESULT_DEFAULT_LIMIT,
  TASK_OUTPUT_RESULT_MAX_LIMIT,
  type TaskOutputAgentSummary,
  type TaskOutputSummaryContext,
  type TaskOutputWorkflowSummary,
} from "./task-output-view.js";
import { reclaimGlobalSessionTasksDir, sessionTaskFile } from "./task-paths.js";
import { TaskStore } from "./task-store.js";
import { loadGlobalTasksConfig, loadTasksConfig } from "./tasks-config.js";
import type {
  Task,
  TaskCascadeConfig,
  TaskStatus,
} from "./types.js";
import { openSettingsMenu } from "./ui/settings-menu.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

// ---- Debug ----

const DEBUG = !!process.env.PI_TASKS_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-subagents:tasks]", ...args);
}

// ---- Helpers ----

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined };
}

interface TaskAgentRecord {
  artifactId?: string;
  artifactStatus?: ResultArtifactStatus;
  error?: string;
  id: string;
  invocation?: { modelId?: string; modelName?: string };
  lifetimeUsage?: LifetimeUsage;
  result?: string;
  resultArtifactPath?: string;
  resultBodyEnabled?: boolean;
  status: string;
  taskExecutionRef?: TaskExecutionRef;
  toolUses?: number;
  turnCount?: number;
}

interface TaskAgentRegistry {
  getRecord(id: string): TaskAgentRecord | undefined;
}

function getTaskAgentRegistry(): TaskAgentRegistry | undefined {
  const registry = (globalThis as unknown as { [key: symbol]: unknown })[
    Symbol.for("pi-subagents:manager")
  ];
  if (!registry || typeof registry !== "object" || !("getRecord" in registry)) return undefined;
  return typeof registry.getRecord === "function" ? registry as TaskAgentRegistry : undefined;
}

interface TaskAgentSpawnOptions {
  description: string;
  isBackground: true;
  maxTurns?: number;
  model?: string;
  taskExecution: TaskExecutionClaim;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCascadeConfig(value: unknown): TaskCascadeConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const config = value as Record<string, unknown>;
  return {
    ...(typeof config.additionalContext === "string" ? { additionalContext: config.additionalContext } : {}),
    ...(typeof config.maxTurns === "number" ? { maxTurns: config.maxTurns } : {}),
    ...(typeof config.model === "string" ? { model: config.model } : {}),
  };
}

function eventAgentId(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("id" in data)) return undefined;
  return typeof data.id === "string" ? data.id : undefined;
}

function eventTaskExecutionRef(data: unknown): TaskExecutionRef | undefined {
  if (!data || typeof data !== "object" || !("taskExecutionRef" in data)) return undefined;
  return isTaskExecutionRef(data.taskExecutionRef) ? data.taskExecutionRef : undefined;
}

function taskExecutionRefMatchesClaim(
  ref: TaskExecutionRef,
  claim: TaskExecutionClaim,
  executorId: string,
): boolean {
  return ref.executorId === executorId
    && ref.storeId === claim.storeId
    && ref.taskId === claim.taskId
    && ref.taskAttemptId === claim.taskAttemptId
    && ref.attemptId === claim.attemptId
    && ref.kind === claim.kind;
}

function sameTaskExecutionRef(left: TaskExecutionRef, right: TaskExecutionRef): boolean {
  return left.storeId === right.storeId
    && left.taskId === right.taskId
    && left.taskAttemptId === right.taskAttemptId
    && left.attemptId === right.attemptId
    && left.kind === right.kind
    && left.executorId === right.executorId;
}

/** Task tool names — used to detect task tool usage for reminder suppression. */
const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute"]);

/** How many turns without task tool usage before injecting a reminder. */
const REMINDER_INTERVAL = 4;

/** Shorter interval used while any task is in_progress, so stale work is caught faster. */
const ACTIVE_REMINDER_INTERVAL = 2;

/** Cap on how many tasks the reminder echoes, to bound its size on large lists. */
const REMINDER_MAX_TASKS = 10;

/** Effective reminder interval for a given task list (pure — no disk I/O). */
function intervalFor(tasks: Task[]): number {
  return tasks.some(t => t.status === "in_progress") ? ACTIVE_REMINDER_INTERVAL : REMINDER_INTERVAL;
}

/** How many turns completed tasks linger before auto-clearing. */
const AUTO_CLEAR_DELAY = 4;

/** Neutralize a task field for the echo: collapse newlines and strip reminder tags. */
function sanitizeField(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/<\/?system-reminder>/gi, "").trim();
}

/**
 * Build the system reminder, shaped after Claude Code's todo reminders: an
 * empty-list nudge, or a state echo that dumps the current list as JSON. The
 * wording mirrors Claude Code (adapted to this extension's task tool names).
 */
function buildSystemReminder(tasks: Task[]): string {
  if (tasks.length === 0) {
    return [
      "<system-reminder>",
      "This is a reminder that your task list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a task list please use the TaskCreate tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.",
      "</system-reminder>",
    ].join("\n");
  }

  // Bound the echo on large lists. When over the cap, drop completed tasks
  // first (the reminder exists to surface unfinished work); ties keep task
  // order since Array.sort is stable.
  let shown = tasks;
  if (tasks.length > REMINDER_MAX_TASKS) {
    const rank = (t: Task) => (t.status === "in_progress" ? 0 : t.status === "pending" ? 1 : 2);
    shown = [...tasks].sort((a, b) => rank(a) - rank(b)).slice(0, REMINDER_MAX_TASKS);
  }
  const hidden = tasks.length - shown.length;
  const overflow = hidden > 0
    ? ` (${hidden} more task${hidden === 1 ? "" : "s"} not shown — use TaskList for the full list.)`
    : "";

  const items = shown.map(t => {
    const item: Record<string, string> = {
      id: t.id,
      content: sanitizeField(t.subject),
      status: t.status,
    };
    if (t.activeForm) item.activeForm = sanitizeField(t.activeForm);
    return item;
  });

  // When truncated, don't claim these are the full contents.
  const prefix = "The task tools haven't been used recently. DO NOT mention this explicitly to the user.";
  const header = hidden > 0
    ? `${prefix} Here are your most relevant tasks (list truncated):`
    : `${prefix} Here are the latest contents of your task list:`;

  return [
    "<system-reminder>",
    header,
    "",
    `${JSON.stringify(items)}.${overflow} Continue on with the tasks at hand if applicable.`,
    "</system-reminder>",
  ].join("\n");
}

export type WorkflowTaskOutputStatus = "running" | "paused" | "completed" | "failed" | "killed";

export interface WorkflowTaskOutputSnapshot {
  id: string;
  status: WorkflowTaskOutputStatus;
  name?: string;
  doneCount: number;
  totalCount: number;
  replayedCount: number;
  totalTokens: number;
  totalToolCalls: number;
  elapsedMs: number;
  output?: string;
  scriptPath?: string;
  taskExecutionRef?: TaskExecutionRef;
  attempts?: readonly WorkflowChildAttempt[];
  coverage?: WorkflowCoverageAggregate;
  resultBodyEnabled?: boolean;
  aggregateArtifactId?: string;
  aggregateArtifactStatus?: ResultArtifactStatus;
  evidenceIncomplete?: boolean;
}

export interface WorkflowTaskOutputAdapter {
  get(runId: string): WorkflowTaskOutputSnapshot | undefined;
  list(): readonly string[];
  wait(
    runId: string,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<WorkflowTaskOutputSnapshot | undefined>;
  consume(runId: string): void;
  /** Abort one controller and resolve only after its run has settled. */
  stop?(
    runId: string,
    outcome?: { status: "completed" | "pending"; error?: string },
  ): Promise<boolean>;
}

export interface TaskExecutionCoordinator {
  claim(
    taskId: string,
    kind: TaskExecutionKind,
    attemptId?: string,
    taskAttemptId?: string,
  ): TaskExecutionClaim | undefined;
  bind(claim: TaskExecutionClaim, executorId: string): TaskExecutionRef | undefined;
  rollback(claim: TaskExecutionBinding, error?: string): boolean;
  prepare(ref: TaskExecutionRef, status: "completed" | "pending", error?: string): string | undefined;
  restore(ref: TaskExecutionRef, token: string): boolean;
  update(ref: TaskExecutionRef, fields: {
    status?: TaskStatus | "deleted";
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, unknown>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }): boolean;
  /** Merge metadata while the owner holds a terminal stop reservation. */
  updateStop(ref: TaskExecutionRef, fields: {
    metadata?: Record<string, unknown>;
  }): boolean;
  settle(ref: TaskExecutionRef, outcome: TaskExecutionSettle): boolean;
}

/**
 * Plain list operations on the current task store, for in-process integrations
 * (e.g. the plannotator bridge) that mirror external state into the task list.
 * Every method targets the store that is active at call time and refreshes the
 * widget on change. Tasks bound to an executor are never mutated through this
 * surface: `update` and `delete` refuse them, leaving execution ownership to
 * the TaskExecutionCoordinator.
 */
export interface TaskListHandle {
  /** Deep-cloned tasks of the active store, sorted by id. */
  list(): Task[];
  /** Create a pending task and refresh the widget. */
  create(input: {
    subject: string;
    description: string;
    activeForm?: string;
    metadata?: Task["metadata"];
  }): Task;
  /** Retitle, re-describe, or re-status an unbound task. Returns false when the
   *  task is missing or owned by an executor. `status` is how a mirror records
   *  progress reported by the source it tracks. */
  update(id: string, fields: {
    status?: TaskStatus;
    subject?: string;
    description?: string;
    activeForm?: string;
    metadata?: Record<string, unknown>;
  }): boolean;
  /** Delete an unbound task. Returns false when the task is missing or owned
   *  by an executor (TaskStore.delete enforces the same guard). */
  delete(id: string): boolean;
}

/** registerTasks return: the execution coordinator plus the plain list handle. */
export type TasksRegistration = TaskExecutionCoordinator & { taskList: TaskListHandle };

export interface RegisterTasksOptions {
  workflowOutput?: WorkflowTaskOutputAdapter;
  workflowAggregateReader?: (input: {
    cwd: string;
    sessionId: string;
    workflowId: string;
    taskBinding?: TaskExecutionRef;
  }) => ReadWorkflowAggregateArtifactResult;
}

const WORKFLOW_OUTPUT_UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g;
const WORKFLOW_OUTPUT_SINGLE_LINE_UNSAFE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g;

function escapeWorkflowOutputCharacter(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function sanitizeWorkflowOutputField(value: string): string {
  return value.replace(WORKFLOW_OUTPUT_UNSAFE, escapeWorkflowOutputCharacter);
}

function sanitizeWorkflowOutputLine(value: string): string {
  return value.replace(WORKFLOW_OUTPUT_SINGLE_LINE_UNSAFE, escapeWorkflowOutputCharacter);
}

function workflowOutputText(workflow: WorkflowTaskOutputSnapshot): string {
  const name = workflow.name ? ` "${sanitizeWorkflowOutputLine(workflow.name)}"` : "";
  const parts = [
    `${workflow.doneCount}/${workflow.totalCount} agents`,
    `${workflow.totalTokens} tokens`,
    `${workflow.totalToolCalls} tool use${workflow.totalToolCalls === 1 ? "" : "s"}`,
    `${workflow.elapsedMs}ms`,
  ];
  if (workflow.replayedCount > 0) parts.push(`${workflow.replayedCount} replayed`);
  const lines = [`Workflow ${workflow.id} [${workflow.status}]${name} — ${parts.join(", ")}`];
  if (workflow.scriptPath) lines.push(`Script: ${sanitizeWorkflowOutputLine(workflow.scriptPath)}`);
  if (workflow.output !== undefined) lines.push("", sanitizeWorkflowOutputField(workflow.output));
  return lines.join("\n");
}

export function registerTasks(pi: ExtensionAPI, options: RegisterTasksOptions = {}) {
  const eventUnsubs: Array<() => void> = [];
  // Project overrides require ExtensionContext.cwd, which is unavailable while
  // the extension factory runs. Start with global defaults, then merge the
  // active workspace's overrides on the first context-bearing event.
  const cfg = loadGlobalTasksConfig();
  const piTasks = process.env.PI_TASKS;
  let taskScope = cfg.taskScope ?? "session";

  /** Both session scopes persist one file per session; they differ only in where it
   *  lives, so every lifecycle rule about session files applies to each of them. */
  const isSessionScope = () => taskScope === "session" || taskScope === "session-global";

  /** Resolve both the backing path and a stable identity for the active store. */
  function resolveStoreTarget(
    cwd?: string,
    persistedSessionId?: string,
    sessionId?: string,
  ): { key: string; path?: string } {
    if (piTasks === "off") return { key: `memory:env:${sessionId ?? "pending"}` };
    if (piTasks?.startsWith("/")) return { key: `path:${piTasks}`, path: piTasks };
    if (piTasks?.startsWith(".")) {
      const path = cwd ? resolve(cwd, piTasks) : undefined;
      return path ? { key: `path:${path}`, path } : { key: "pending:relative" };
    }
    if (piTasks) return { key: `named:${piTasks}`, path: piTasks };
    if (taskScope === "memory") return { key: `memory:config:${sessionId ?? "pending"}` };
    if (!cwd) return { key: "pending:workspace" };
    if (isSessionScope() && persistedSessionId) {
      const path = sessionTaskFile(cwd, persistedSessionId, taskScope);
      return { key: `path:${path}`, path };
    }
    if (isSessionScope()) return { key: "pending:session" };
    const path = join(cwd, ".pi", "tasks", "tasks.json");
    return { key: `path:${path}`, path };
  }

  // Project and relative paths need ExtensionContext.cwd, which is unavailable
  // while the extension factory runs. Absolute and named PI_TASKS overrides can
  // still be opened immediately; all other stores start in memory.
  let storeTarget = resolveStoreTarget();
  let store = new TaskStore(storeTarget.path);
  let storeGeneration = 0;
  const tracker = new ProcessTracker();
  const widget = new TaskWidget(store, cfg);
  const executionHandles = new Map<string, { generation: number; store: TaskStore }>();
  const stopReservations = new Map<string, {
    generation: number;
    store: TaskStore;
    ref: TaskExecutionRef;
    token: string;
  }>();

  function executionHandleKey(binding: TaskExecutionBinding): string {
    return [binding.storeId, binding.taskId, binding.taskAttemptId, binding.attemptId].join("\u0000");
  }

  function rememberExecutionStore(binding: TaskExecutionBinding, taskStore = store): void {
    executionHandles.set(executionHandleKey(binding), { generation: storeGeneration, store: taskStore });
  }

  function executionHandle(binding: TaskExecutionBinding): { generation: number; store: TaskStore } | undefined {
    return executionHandles.get(executionHandleKey(binding));
  }

  function forgetExecutionStore(binding: TaskExecutionBinding): void {
    executionHandles.delete(executionHandleKey(binding));
  }

  function forgetStopReservation(ref: TaskExecutionRef): void {
    const key = executionHandleKey(ref);
    const reservation = stopReservations.get(key);
    if (reservation && sameTaskExecutionRef(reservation.ref, ref)) stopReservations.delete(key);
  }

  function prepareTaskExecution(
    ref: TaskExecutionRef,
    status: "completed" | "pending",
    error?: string,
  ): string | undefined {
    const handle = executionHandle(ref);
    const token = handle?.store.prepareExecutionStop(ref, status, error);
    if (token !== undefined && handle) {
      stopReservations.set(executionHandleKey(ref), {
        generation: handle.generation,
        store: handle.store,
        ref: { ...ref },
        token,
      });
    }
    return token;
  }

  function restoreTaskExecution(ref: TaskExecutionRef, token: string): boolean {
    return executionHandle(ref)?.store.restoreExecution(ref, token) ?? false;
  }

  function updateTaskExecution(
    ref: TaskExecutionRef,
    fields: Parameters<TaskStore["finalizeExecutionStop"]>[2],
    token?: string,
    retainBinding = false,
  ): boolean {
    const handle = executionHandle(ref);
    const committed = token !== undefined
      ? handle?.store.finalizeExecutionStop(ref, token, fields, retainBinding).casMatched === true
      : false;
    if (committed && !retainBinding) forgetExecutionStore(ref);
    if (token !== undefined) forgetStopReservation(ref);
    return committed;
  }

  // ── Subagent integration state ──
  /** Latest ExtensionContext — refreshed on every tool execution so cascade always has a valid one. */
  let latestCtx: ExtensionContext | undefined;
  /** Cascade options captured per launched agent, so overlapping executions do not overwrite each other. */
  const agentCascadeConfigs = new Map<string, TaskCascadeConfig>();
  /** Maps agent IDs to canonical execution refs for lookup and reattachment. */
  const agentTaskMap = new Map<string, TaskExecutionRef>();

  function detachTaskAgents(taskId: string): void {
    for (const [agentId, ref] of agentTaskMap) {
      if (ref.taskId !== taskId) continue;
      agentTaskMap.delete(agentId);
      agentCascadeConfigs.delete(agentId);
    }
  }

  // ── Subagent RPC helpers ──

  /** RPC reply envelope — matches pi-mono's RpcResponse shape. */
  type RpcReply<T = void> =
    | { success: true; data?: T }
    | { success: false; error: string };

  /** Call a subagents RPC method: emit request, wait for scoped reply, unwrap envelope. */
  function rpcCall<T>(channel: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const requestId = randomUUID();
    debug(`rpc:send ${channel}`, { requestId });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        debug(`rpc:timeout ${channel}`, { requestId });
        reject(new Error(`${channel} timeout`));
      }, timeoutMs);
      const unsub = pi.events.on(`${channel}:reply:${requestId}`, (raw: unknown) => {
        unsub(); clearTimeout(timer);
        debug(`rpc:reply ${channel}`, { requestId, raw });
        const reply = raw as RpcReply<T>;
        if (reply.success) resolve(reply.data as T);
        else reject(new Error(reply.error));
      });
      pi.events.emit(channel, { requestId, ...params });
      debug(`rpc:emitted ${channel}`, { requestId });
    });
  }

  /** Spawn a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function spawnSubagent(
    type: string,
    prompt: string,
    options: TaskAgentSpawnOptions,
  ): Promise<{ id: string; taskExecutionRef: TaskExecutionRef }> {
    debug("spawn:call", { type, options: { ...options, prompt: undefined } });
    return rpcCall<{ id: string; taskExecutionRef?: TaskExecutionRef }>(
      "subagents:rpc:spawn",
      { type, prompt, options },
      30_000,
    ).then(data => {
      debug("spawn:ok", data);
      if (!isTaskExecutionRef(data.taskExecutionRef)) {
        throw new Error("subagent runtime returned no valid task execution ref");
      }
      return { id: data.id, taskExecutionRef: data.taskExecutionRef };
    });
  }

  /** Stop a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function stopSubagent(agentId: string): Promise<void> {
    return rpcCall<void>("subagents:rpc:stop", { agentId }, 10_000);
  }

  interface PreparedTaskStop {
    ref: TaskExecutionRef;
    token: string;
  }

  async function stopTaskExecutor(
    task: Task,
    outcome: { status: "completed" | "pending"; error?: string } = { status: "completed" },
  ): Promise<PreparedTaskStop | undefined> {
    if (task.status !== "in_progress" || !isTaskExecutionRef(task.execution)) return undefined;
    const execution = task.execution;
    const handle = executionHandle(execution);
    const token = prepareTaskExecution(execution, outcome.status, outcome.error);
    if (token === undefined || !handle) return undefined;
    try {
      if (execution.kind === "workflow") {
        const stopped = await options.workflowOutput?.stop?.(execution.executorId, outcome);
        if (!stopped) throw new Error(`Workflow ${execution.executorId} is not running`);
      } else {
        await stopSubagent(execution.executorId);
      }
    } catch (error) {
      const reservation = stopReservations.get(executionHandleKey(execution));
      const canRestore = reservation !== undefined
        && reservation.token === token
        && reservation.store === handle.store
        && reservation.generation === storeGeneration
        && reservation.store === store;
      if (canRestore) restoreTaskExecution(execution, token);
      forgetStopReservation(execution);
      throw error;
    }
    return { ref: execution, token };
  }

  async function stopTaskExecution(
    task: Task,
    expectedGeneration = storeGeneration,
    outcome: { status: "completed" | "pending"; error?: string } = { status: "completed" },
  ): Promise<PreparedTaskStop | undefined> {
    if (task.status !== "in_progress" || !isTaskExecutionRef(task.execution)) return undefined;
    const execution = task.execution;
    const mapped = execution.kind === "agent" ? agentTaskMap.get(execution.executorId) : undefined;
    const cascadeConfig = execution.kind === "agent" ? agentCascadeConfigs.get(execution.executorId) : undefined;
    detachTaskAgents(task.id);
    try {
      return await stopTaskExecutor(task, outcome);
    } catch (error) {
      if (expectedGeneration === storeGeneration && mapped) {
        agentTaskMap.set(execution.executorId, mapped);
        if (cascadeConfig) agentCascadeConfigs.set(execution.executorId, cascadeConfig);
      }
      throw error;
    }
  }


  /** Stop and revoke an executor whose binding lost the launch metadata CAS. */
  async function cleanupFailedLaunch(
    ref: TaskExecutionRef,
    taskStore: TaskStore,
    error: string,
  ): Promise<void> {
    try {
      if (ref.kind === "workflow") await options.workflowOutput?.stop?.(ref.executorId);
      else await stopSubagent(ref.executorId);
    } catch {
      // The launch is already unauthorized; cleanup remains best effort if the
      // runtime settled or rejected the just-created executor concurrently.
    } finally {
      taskStore.rollbackExecution(ref, error);
      forgetExecutionStore(ref);
      const mapped = agentTaskMap.get(ref.executorId);
      if (!mapped || sameTaskExecutionRef(mapped, ref)) {
        agentTaskMap.delete(ref.executorId);
        agentCascadeConfigs.delete(ref.executorId);
      }
    }
  }
  /** Resolve a task ID or an exact/unambiguous agent ID prefix to its task. */
  function resolveTaskId(ref: string): string {
    if (store.get(ref)) return ref;
    const matches = [...agentTaskMap]
      .filter(([agentId]) => agentId === ref || agentId.startsWith(ref));
    if (matches.length > 1) throw new Error(`Agent ID prefix is ambiguous: ${ref}`);
    return matches[0]?.[1].taskId ?? ref;
  }

  /** Tell subagents its result has been handed to the model, which suppresses the
   *  completion notification it would otherwise deliver for the same result — the
   *  same consumption `get_subagent_result` performs when it returns one.
   *
   *  Fire-and-forget rather than an `rpcCall`: the reply carries nothing to act on,
   *  and the channel is deliberately outside the version handshake so a pi-subagents
   *  without the handler keeps notifying instead of failing the read. */
  function consumeSubagentResult(agentId: string): void {
    pi.events.emit("subagents:rpc:consume", { requestId: randomUUID(), agentId });
  }

  // ── Subagent extension presence & version detection ──
  const PROTOCOL_VERSION = SUBAGENTS_RPC_PROTOCOL_VERSION;
  let subagentsAvailable = false;
  let pendingWarning: string | undefined;

  /** Ping subagents and check protocol version. Works with any handler version. */
  function checkSubagentsVersion() {
    const requestId = randomUUID();
    const timer = setTimeout(() => { unsub(); }, 5_000);
    const unsub = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, (raw: unknown) => {
      unsub(); clearTimeout(timer);
      const remoteVersion = (() => {
        if (!raw || typeof raw !== "object" || !("data" in raw)) return undefined;
        const data = raw.data;
        if (!data || typeof data !== "object" || !("version" in data)) return undefined;
        return typeof data.version === "number" ? data.version : undefined;
      })();
      if (remoteVersion === undefined) {
        pendingWarning =
          "The bundled subagent runtime does not expose a compatible task-execution protocol; update @tintinweb/pi-subagents.";
      } else if (remoteVersion > PROTOCOL_VERSION) {
        pendingWarning =
          `Bundled task integration protocol v${PROTOCOL_VERSION} does not match ` +
          `the subagent runtime protocol v${remoteVersion}; update @tintinweb/pi-subagents.`;
      } else if (remoteVersion < PROTOCOL_VERSION) {
        pendingWarning =
          `Bundled subagent runtime protocol v${remoteVersion} does not match ` +
          `the task integration protocol v${PROTOCOL_VERSION}; update @tintinweb/pi-subagents.`;
      } else {
        subagentsAvailable = true;
      }
    });
    pi.events.emit("subagents:rpc:ping", { requestId });
  }

  checkSubagentsVersion();
  eventUnsubs.push(pi.events.on("subagents:ready", () => checkSubagentsVersion()));

  /** Build a prompt for a task being executed by a subagent.
   *  Injects completed dependency results so cascaded agents have context from prerequisites.
   */
  function buildTaskPrompt(
    task: { id: string; subject: string; description: string; blockedBy?: string[] },
    additionalContext?: string,
  ): string {
    let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;

    // Inject completed dependency results so cascaded agents have full context
    if (task.blockedBy && task.blockedBy.length > 0) {
      const depResults: string[] = [];
      for (const depId of task.blockedBy) {
        const dep = store.get(depId);
        if (dep?.metadata?.result) {
          const result = dep.metadata.result.length > 4000
            ? dep.metadata.result.slice(0, 4000) + "\n\n[... truncated — use TaskGet for full output]"
            : dep.metadata.result;
          depResults.push(`### Task #${depId}: ${dep.subject}\n${result}`);
        }
      }
      if (depResults.length > 0) {
        prompt += `\n\n## Prerequisite task results\n\n${depResults.join("\n\n")}`;
      }
    }

    if (additionalContext) prompt += `\n\n${additionalContext}`;
    prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
    return prompt;
  }

  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);

  // ── Subagent completion listener ──
  // Listens for subagent lifecycle events to update task status and optionally cascade.

  function executionRefForEvent(data: unknown, agentId: string): TaskExecutionRef | undefined {
    const carriesRef = data !== null && typeof data === "object" && "taskExecutionRef" in data;
    const mapped = agentTaskMap.get(agentId);
    if (!carriesRef) {
      // Canonical executions must prove authority with the immutable ref emitted
      // by the runtime. The local map is only a lookup/reattachment index; it
      // must never turn a metadata-free lifecycle event into commit authority.
      return undefined;
    }
    // Once a producer carries the field, it must carry the complete canonical
    // ref. Never repair a malformed or unauthorized value from local state.
    const carried = eventTaskExecutionRef(data);
    if (carried === undefined || carried.executorId !== agentId) return undefined;
    if (mapped !== undefined && !sameTaskExecutionRef(carried, mapped)) return undefined;
    return carried;
  }

  /** Explicit compatibility path for pre-binding metadata-only tasks. */
  function legacyTaskForEvent(data: unknown, agentId: string): Task | undefined {
    if (data !== null && typeof data === "object" && "taskExecutionRef" in data) return undefined;
    if (agentTaskMap.has(agentId)) return undefined;
    return store.list().find(task =>
      task.status === "in_progress"
      && task.execution === undefined
      && task.metadata.agentId === agentId,
    );
  }

  // Success → mark task completed, cascade if enabled
  async function handleSubagentCompleted(data: unknown): Promise<void> {
    const id = eventAgentId(data);
    if (!id) return;
    const ref = executionRefForEvent(data, id);
    if (!ref) {
      const legacy = legacyTaskForEvent(data, id);
      if (!legacy) return;
      const legacyResult = data && typeof data === "object" && "result" in data && typeof data.result === "string"
        ? data.result
        : undefined;
      store.update(legacy.id, {
        status: "completed",
        ...(legacyResult !== undefined ? { metadata: { result: legacyResult } } : {}),
      });
      widget.setActiveTask(legacy.id, false);
      widget.update();
      return;
    }
    const result = data && typeof data === "object" && "result" in data && typeof data.result === "string"
      ? data.result
      : undefined;
    const cascadeConfig = agentCascadeConfigs.get(id);
    agentTaskMap.delete(id);
    agentCascadeConfigs.delete(id);

    const handle = executionHandle(ref);
    const taskStore = handle?.store;
    if (!handle || !taskStore) return;
    const isCurrentGeneration = taskStore === store && handle.generation === storeGeneration;
    const task = taskStore.get(ref.taskId);
    const committed = taskStore.settleExecution(ref, {
      status: "completed",
      ...(result !== undefined ? { result } : {}),
    });
    if (!task || !committed) {
      if (!task?.execution
        || executionHandleKey(task.execution) !== executionHandleKey(ref)) {
        forgetExecutionStore(ref);
      }
      return;
    }
    forgetExecutionStore(ref);
    if (isCurrentGeneration) widget.setActiveTask(task.id, false);

    // Auto-cascade: find unblocked dependents with agentType. claimPending keeps
    // concurrent blocker completions or sessions from launching the same task twice.
    if (isCurrentGeneration && (cfg.autoCascade ?? false) && cascadeConfig && latestCtx) {
      const unblocked = taskStore.list().filter(t =>
        t.status === "pending" &&
        t.metadata?.agentType &&
        t.blockedBy.includes(task.id) &&
        t.blockedBy.every(depId => taskStore.get(depId)?.status === "completed")
      );
      for (const next of unblocked) {
        if (!isCurrentGeneration || taskStore !== store) break;
        const claimed = taskStore.claimPending(next.id, {
          kind: "agent",
          taskAttemptId: randomUUID(),
          attemptId: randomUUID(),
        });
        const claim = claimed?.execution;
        const agentType = claimed?.metadata.agentType;
        if (!claimed || !claim || !agentType) continue;
        rememberExecutionStore(claim, taskStore);
        const prompt = buildTaskPrompt(claimed, cascadeConfig.additionalContext);
        try {
          const spawned = await spawnSubagent(agentType, prompt, {
            description: claimed.subject,
            isBackground: true,
            maxTurns: cascadeConfig.maxTurns,
            ...(cascadeConfig.model ? { model: cascadeConfig.model } : {}),
            taskExecution: claim,
          });
          if (!taskExecutionRefMatchesClaim(spawned.taskExecutionRef, claim, spawned.id)) {
            try { await stopSubagent(spawned.id); } catch { /* invalid runtime reply; best-effort cleanup */ }
            taskStore.rollbackExecution(claim, "subagent runtime returned a mismatched task execution ref");
            forgetExecutionStore(claim);
            continue;
          }
          const bound = isCurrentGeneration && taskStore === store
            ? taskStore.bindExecution(claim, spawned.id)
            : undefined;
          if (!bound) {
            try { await stopSubagent(spawned.id); } catch { /* already settled or stopped by session teardown */ }
            taskStore.rollbackExecution(claim, "task or session changed before cascaded launch completed");
            forgetExecutionStore(claim);
            if (!isCurrentGeneration || taskStore !== store) break;
            continue;
          }
          const metadataCommitted = taskStore.updateExecution(bound, {
            owner: spawned.id,
            metadata: { agentId: spawned.id, taskCascadeConfig: cascadeConfig },
          });
          if (!metadataCommitted) {
            await cleanupFailedLaunch(
              bound,
              taskStore,
              "task changed before cascaded launch metadata was committed",
            );
            if (!isCurrentGeneration || taskStore !== store) break;
            continue;
          }
          agentTaskMap.set(spawned.id, bound);
          agentCascadeConfigs.set(spawned.id, cascadeConfig);
          widget.setActiveTask(claimed.id);
          await reconcileSettledAgent(spawned.id);
        } catch (error) {
          taskStore.rollbackExecution(claim, errorMessage(error));
          forgetExecutionStore(claim);
        }
      }
    }
    if (isCurrentGeneration) {
      autoClear.trackCompletion(task.id, cadence.currentTurn);
      widget.update();
    }
  }

  // Failure → store error, revert to pending, don't cascade (branch stops).
  // Intentional stop completes the task and preserves output already available.
  function handleSubagentFailed(data: unknown): void {
    const id = eventAgentId(data);
    if (!id) return;
    const ref = executionRefForEvent(data, id);
    if (!ref) {
      const legacy = legacyTaskForEvent(data, id);
      if (!legacy) return;
      const record = data as { error?: unknown; result?: unknown; status?: unknown };
      const status = typeof record.status === "string" ? record.status : "error";
      const metadata = status === "stopped"
        ? { ...(typeof record.result === "string" && record.result !== "" ? { result: record.result } : {}) }
        : { result: null, lastError: typeof record.error === "string" ? record.error : status };
      store.update(legacy.id, {
        status: status === "stopped" ? "completed" : "pending",
        metadata,
      });
      widget.setActiveTask(legacy.id, false);
      widget.update();
      return;
    }
    const record = data as { error?: unknown; result?: unknown; status?: unknown };
    const status = typeof record.status === "string" ? record.status : "error";
    const error = typeof record.error === "string" ? record.error : status;
    const result = typeof record.result === "string" ? record.result : undefined;
    const handle = executionHandle(ref);
    const taskStore = handle?.store;
    const task = taskStore?.get(ref.taskId);
    agentTaskMap.delete(id);
    agentCascadeConfigs.delete(id);
    if (!handle || !taskStore) return;
    if (!task) {
      forgetExecutionStore(ref);
      return;
    }
    const isCurrentGeneration = taskStore === store && handle.generation === storeGeneration;

    const committed = status === "stopped"
      ? taskStore.settleExecution(ref, {
          status: "completed",
          ...(result !== undefined && result !== ""
            ? { result }
            : typeof task.metadata.result === "string" ? { result: task.metadata.result } : {}),
        })
      : taskStore.settleExecution(ref, { status: "pending", error });
    if (!committed) {
      // TaskStop may have finalized the status while keeping this ref solely
      // for the runtime's same-attempt partial output. A TaskUpdate reservation
      // also accepts the output but keeps both its ref and store handle until
      // the reservation owner applies the final field update.
      if (status === "stopped" && task.status === "completed") {
        taskStore.recordSettledExecutionResult(ref, result);
      }
      const current = taskStore.get(ref.taskId);
      if (!current?.execution
        || executionHandleKey(current.execution) !== executionHandleKey(ref)) {
        forgetExecutionStore(ref);
      }
      return;
    }
    forgetExecutionStore(ref);
    if (!isCurrentGeneration) return;

    if (status === "stopped") autoClear.trackCompletion(task.id, cadence.currentTurn);
    else autoClear.resetBatchCountdown();
    widget.setActiveTask(task.id, false);
    widget.update();
  }

  eventUnsubs.push(pi.events.on("subagents:completed", handleSubagentCompleted));
  eventUnsubs.push(pi.events.on("subagents:failed", handleSubagentFailed));

  async function reconcileSettledAgent(agentId: string): Promise<void> {
    if (!agentTaskMap.has(agentId)) return;
    const record = getTaskAgentRegistry()?.getRecord(agentId);
    if (!record || record.status === "running" || record.status === "queued") return;
    if (["error", "stopped", "aborted"].includes(record.status)) {
      handleSubagentFailed(record);
    } else {
      await handleSubagentCompleted(record);
    }
  }

  // ── Context-scoped store initialization ──
  // Project paths cannot be resolved until an ExtensionContext is available.
  // Initialize on the first context-bearing event and reinitialize when a host
  // switches this extension instance to a session in another workspace.
  let configuredCwd: string | undefined;
  let persistedTasksShown = false;
  let agentsReattached = false;
  let duplicateWarningShown = false;
  function initializeStoreForContext(ctx: ExtensionContext, reloadConfig = false) {
    // Keep the config object identity stable because the widget and auto-clear
    // manager retain references to it, but replace every value so overrides
    // from a previous workspace cannot leak into the next one.
    if (reloadConfig || configuredCwd !== ctx.cwd) {
      for (const key of Object.keys(cfg) as (keyof typeof cfg)[]) delete cfg[key];
      Object.assign(cfg, loadTasksConfig(ctx.cwd));
      taskScope = cfg.taskScope ?? "session";
    }

    // `pi --no-session` mints a session ID but never a session file. Keying off the
    // ID alone would write tasks-<id>.json for a session that can never be resumed
    // and is orphaned the moment pi exits: if pi is not persisting the conversation,
    // don't persist the task list either.
    const currentSessionId = ctx.sessionManager?.getSessionId?.();
    const persistedSessionId = isSessionScope() && !piTasks && ctx.sessionManager?.getSessionFile?.()
      ? currentSessionId
      : undefined;
    const nextTarget = resolveStoreTarget(ctx.cwd, persistedSessionId, currentSessionId);
    if (nextTarget.key !== storeTarget.key) {
      storeGeneration++;
      agentTaskMap.clear();
      agentCascadeConfigs.clear();
      store = new TaskStore(nextTarget.path);
      widget.setStore(store);
      storeTarget = nextTarget;
      // The new store owns a different task list, so the agent map has to be
      // rebuilt from it rather than kept from the previous one.
      agentsReattached = false;
    }
    configuredCwd = ctx.cwd;
  }

  /** Delete an emptied session file, and — under `session-global` only — the
   *  directory that held it once its last session is gone. Nothing else is ours
   *  to reclaim: a PI_TASKS path can point anywhere, and `<workspace>/.pi/tasks/`
   *  is left standing exactly as it always has been. */
  function deleteSessionFileIfEmpty() {
    if (!store.deleteFileIfEmpty()) return;
    if (taskScope === "session-global" && !piTasks && configuredCwd) {
      reclaimGlobalSessionTasksDir(configuredCwd);
    }
  }

  /** Re-link persisted in-progress tasks to the subagents still running for them.
   *  `agentTaskMap` lives only in this extension instance, so a reload starts empty
   *  while the agents keep going — their completion events would then be dropped and
   *  the tasks would stay in_progress forever. Everything needed is already on disk:
   *  TaskExecute records the agent ID in task metadata.
   *
   *  Only in_progress tasks are relinked. A task reverted to pending keeps its
   *  `metadata.agentId`, and relinking that would let a late event resurrect work the
   *  user has already reset. Only runs once — the first caller wins. */
  function reattachAgents() {
    if (agentsReattached) return;
    agentsReattached = true;
    for (const task of store.list()) {
      const ref = task.execution;
      if (task.status !== "in_progress" || !isTaskExecutionRef(ref)) continue;
      if (ref.kind === "workflow") {
        let live = false;
        try {
          const snapshot = options.workflowOutput?.get(ref.executorId);
          live = snapshot?.status === "running" || snapshot?.status === "paused";
        } catch {
          live = false;
        }
        if (!live) {
          // A persisted workflow ref is authority only while its controller is
          // live in this extension instance. Revoke stale authority atomically;
          // there is no controller to stop after a process reload.
          store.rollbackExecution(ref, "workflow controller was interrupted before it could be reattached");
          forgetExecutionStore(ref);
          continue;
        }
      }
      rememberExecutionStore(ref);
      if (ref.kind === "agent") {
        agentTaskMap.set(ref.executorId, ref);
        const cascadeConfig = normalizeCascadeConfig(task.metadata.taskCascadeConfig);
        if (cascadeConfig) agentCascadeConfigs.set(ref.executorId, cascadeConfig);
      }
    }
  }

  /** Restore widget on session start/resume if there's unfinished work.
   *  On new sessions, auto-clear if all tasks are completed (clean slate).
   *  On resume, always show tasks (user may want to review).
   *  Only runs once — the first caller wins. */
  function showPersistedTasks(isResume = false) {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (tasks.length > 0) {
      if (!isResume && tasks.every(t => t.status === "completed")) {
        store.clearCompleted();
        if (isSessionScope()) deleteSessionFileIfEmpty();
      } else {
        widget.update();
      }
    }
  }

  // ── Turn tracking for system-reminder injection ──
  // Cadence decisions live in `reminder-cadence.ts` so they're
  // unit-testable without spinning up a fake ExtensionAPI.
  const cadence = createCadenceState();
  const cadenceConfig: CadenceConfig = {
    reminderInterval: REMINDER_INTERVAL,
    taskToolNames: TASK_TOOL_NAMES,
  };

  pi.on("turn_start", async (_event, ctx) => {
    onTurnStart(cadence);
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    initializeStoreForContext(ctx);
    if (autoClear.onTurnStart(cadence.currentTurn)) {
      if (isSessionScope()) deleteSessionFileIfEmpty();
      widget.update();
    }
  });

  // The end of a run is the only signal that separates a new batch of tasks from the
  // same batch still being built — the store looks identical either way. Nothing is
  // cleared here; this only marks the boundary for the next TaskCreate.
  pi.on("agent_settled", async () => {
    autoClear.onRunEnded();
  });

  // ── Stale-task detection ──
  // Detect when the agent has stopped referencing tasks but left them
  // in_progress. Subagent token usage stays on the existing agent surfaces;
  // attributing the parent turn's usage to every active task would double-count it.
  pi.on("turn_end", async () => {
    // Stale-task detection: catch the case where the agent finishes work in a
    // text-only turn (no tool calls, so tool_result never fires) but left tasks
    // in_progress. Cheap-first: only read the store once the turn gap could
    // matter — the in_progress interval is the smallest a reminder can need.
    if (!cadence.reminderInjectedThisCycle && !cadence.reminderDue) {
      const gap = cadence.currentTurn - cadence.lastTaskToolUseTurn;
      if (gap >= ACTIVE_REMINDER_INTERVAL && store.list().some(t => t.status === "in_progress")) {
        cadence.reminderDue = true;
      }
    }
  });

  // ── System-reminder injection ──
  //
  // tool_result is used ONLY to track cadence. We DO NOT mutate non-task
  // tool result content — appending a <system-reminder> there would
  // corrupt model-visible transcript semantics for unrelated tools (read,
  // bash, grep, …) and make tool-output debugging miserable.
  //
  // The actual injection happens in the `context` hook below, which fires
  // before each LLM call and returns a modified copy of the messages
  // without persisting or polluting any tool output.
  pi.on("tool_result", async (event) => {
    // Task tool usage resets cadence (interval is irrelevant on this path — the
    // helper resets and returns before reading it).
    if (TASK_TOOL_NAMES.has(event.toolName)) {
      evaluateToolResult(cadence, event.toolName, false, cadenceConfig);
      return {};
    }

    if (cadence.reminderInjectedThisCycle) return {};
    // Cheap-first: avoid store.list() disk I/O until the turn gap could matter.
    // ACTIVE_REMINDER_INTERVAL is the smallest interval any reminder can need.
    if (cadence.currentTurn - cadence.lastTaskToolUseTurn < ACTIVE_REMINDER_INTERVAL) return {};

    const tasks = store.list();
    // Shorter interval while in_progress; passed per-call so the shared config
    // is never mutated.
    evaluateToolResult(cadence, event.toolName, tasks.length > 0, {
      ...cadenceConfig,
      reminderInterval: intervalFor(tasks),
    });
    return {};
  });

  // Inject the transient system-reminder into the upcoming LLM call's
  // messages, never into a tool result. The reminder is appended as a
  // user message so models that don't support custom message types still
  // receive it. It is not persisted in the session store — `context`
  // returns a transformed messages array used only for this one request.
  pi.on("context", async (event) => {
    if (!drainReminderForContext(cadence)) return {};
    const tasks = store.list();

    return {
      messages: [
        ...event.messages,
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: buildSystemReminder(tasks) }],
          timestamp: Date.now(),
        },
      ],
    };
  });

  async function rollbackCurrentExecutions(error: string): Promise<void> {
    const taskStore = store;
    const generation = storeGeneration;
    const executions = new Map<string, {
      execution: TaskExecutionBinding;
      reservationToken?: string;
    }>();
    for (const task of taskStore.list()) {
      if (task.status === "in_progress" && task.execution !== undefined) {
        executions.set(executionHandleKey(task.execution), { execution: task.execution });
      }
    }
    for (const reservation of stopReservations.values()) {
      if (reservation.store === taskStore) {
        executions.set(executionHandleKey(reservation.ref), {
          execution: reservation.ref,
          reservationToken: reservation.token,
        });
      }
    }

    for (const { execution, reservationToken } of executions.values()) {
      if (reservationToken !== undefined && isTaskExecutionRef(execution)) {
        taskStore.rollbackExecutionStop(execution, reservationToken, error);
      } else {
        taskStore.rollbackExecution(execution, error);
      }
      if (isTaskExecutionRef(execution)) forgetStopReservation(execution);
      forgetExecutionStore(execution);
      detachTaskAgents(execution.taskId);
    }

    await Promise.allSettled([...executions.values()].map(async ({ execution }) => {
      if (!isTaskExecutionRef(execution)) return;
      if (execution.kind === "workflow") {
        await options.workflowOutput?.stop?.(execution.executorId);
      } else {
        await stopSubagent(execution.executorId);
      }
    }));

    if (taskStore === store && generation === storeGeneration && executions.size > 0) {
      for (const { execution } of executions.values()) widget.setActiveTask(execution.taskId, false);
      autoClear.resetBatchCountdown();
      widget.update();
    }
  }

  // Revoke execution authority before the host activates the replacement
  // session. Root workflow/agent shutdown runs after this handler.
  pi.on("session_before_switch", async () => {
    await rollbackCurrentExecutions("session changed before execution settled");
  });

  // session_start replaces the never-emitted session_switch event. Rehydrating
  // here matters because before_agent_start only fires once the user prompts.
  pi.on("session_start", async (event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);

    if (!duplicateWarningShown && typeof pi.getCommands === "function") {
      const taskCommands = pi.getCommands().filter(command =>
        command.source === "extension" && /^tasks(?::\d+)?$/.test(command.name)
      );
      if (taskCommands.length > 1) {
        duplicateWarningShown = true;
        const warning =
          "Multiple task extensions are loaded. Remove the separate @tintinweb/pi-tasks package to avoid duplicate tools, state updates, and widgets.";
        if (ctx.hasUI) ctx.ui.notify(warning, "warning");
        else console.warn(`[pi-subagents] ${warning}`);
      }
    }

    const reason = event.reason;
    // new/resume/fork reuse the running extension instance (getExtensions() is
    // cached), so session-scoped state must be reset. startup/reload re-run the
    // factory and start clean.
    const isSwitch = reason === "new" || reason === "resume" || reason === "fork";
    // A fork branches the conversation, so its tasks carry over as an independent
    // copy. Snapshot before the store re-points to the new (empty) session file.
    const forkSeed = reason === "fork" ? store.snapshot() : undefined;
    if (isSwitch) {
      // Some hosts transition directly to session_start without first emitting
      // session_before_switch. Revoke the old generation here as a fallback.
      await rollbackCurrentExecutions("session changed before execution settled");
      storeGeneration++;
      persistedTasksShown = false;
      agentsReattached = false;
      // Task IDs restart at 1 in every session, so a mapping held over from the
      // previous one points at an unrelated task here — the agent's completion would
      // close a task it never ran. reattachAgents() rebuilds what this session owns.
      agentTaskMap.clear();
      agentCascadeConfigs.clear();
      resetCadenceState(cadence);
      autoClear.reset();
      // Memory mode has no file to switch — clear tasks explicitly on /new.
      if (reason === "new" && taskScope === "memory") {
        store.clearAll();
      }
    }

    initializeStoreForContext(ctx, true);
    if (forkSeed?.tasks.length) store.seed(forkSeed); // carry the parent's tasks into the fork
    reattachAgents(); // subagents outlive a reload; relink them before events arrive
    // resume/reload/fork keep tasks; startup/new auto-clear an all-completed list.
    const keepsTasks = reason === "reload" || reason === "resume" || reason === "fork";
    showPersistedTasks(keepsTasks);
    // Those tasks are shown for review, but the run that produced them ended with the
    // session before this one — so the next batch must not be added to them either.
    if (keepsTasks) autoClear.onRunEnded();

    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
      pendingWarning = undefined;
    }
  });

  // Fallback for hosts that init UI lazily. Guarded by persistedTasksShown, so
  // it never double-renders after session_start.
  pi.on("before_agent_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    initializeStoreForContext(ctx);
    reattachAgents();
    showPersistedTasks();
    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
      pendingWarning = undefined;
    }
  });

  // Keep latestCtx fresh on every tool execution as well.
  pi.on("tool_execution_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    initializeStoreForContext(ctx);
    widget.update();
  });

  pi.on("session_shutdown", async () => {
    await rollbackCurrentExecutions("session shut down before execution settled");
    for (const unsubscribe of eventUnsubs.splice(0)) unsubscribe();
    widget.dispose();
  });

  // ──────────────────────────────────────────────────
  // Tool 1: TaskCreate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated). Create them all in one response with one TaskCreate call per task
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks
- Include \`agentType\` (e.g., "Worker", "Explorer") to mark tasks for subagent execution via TaskExecute
- To create several tasks at once, call TaskCreate multiple times in a single response — independent tool calls run in parallel, so the whole batch is created in one turn (one task per call).`,
    promptGuidelines: [
      "When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
      "Mark tasks as in_progress before starting work and completed when done.",
      "Use TaskList to check for available work after completing a task.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "A brief title for the task" }),
      description: Type.String({ description: "A detailed description of what needs to be done" }),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress (e.g., 'Running tests')" })),
      agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution (e.g., 'Worker', 'Explorer'). Tasks with agentType can be started via TaskExecute." })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary user metadata to attach to the task. workflowAggregate is reserved for the workflow runtime and is ignored." })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // A finished list must not collect the batch that follows it. The turn countdowns
      // cannot be relied on for that: they only tick at `turn_start`, so a run that ends
      // right after its last completion freezes one mid-count.
      autoClear.startNewBatch();
      const meta = Object.fromEntries(
        Object.entries(params.metadata ?? {}).filter(([key]) => key !== "workflowAggregate"),
      );
      if (params.agentType) meta.agentType = params.agentType;
      const task = store.create(params.subject, params.description, params.activeForm, Object.keys(meta).length > 0 ? meta : undefined);
      widget.update();
      return Promise.resolve(textResult(`Task #${task.id} created successfully: ${task.subject}`));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 2: TaskList
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      // Sort: pending first (by ID), then in_progress (by ID), then completed (by ID)
      const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
      const sorted = [...tasks].sort((a, b) => {
        const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        if (so !== 0) return so;
        return Number(a.id) - Number(b.id);
      });

      const lines = sorted.map(task => {
        let line = `#${task.id} [${task.status}] ${task.subject}`;

        if (task.owner) {
          line += ` (${task.owner})`;
        }

        // Only show non-completed blockers
        if (task.blockedBy.length > 0) {
          const openBlockers = task.blockedBy.filter(bid => {
            const blocker = store.get(bid);
            return blocker && blocker.status !== "completed";
          });
          if (openBlockers.length > 0) {
            line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
          }
        }

        return line;
      });

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: TaskGet
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to retrieve" }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task not found`));

      // Unescape literal \n sequences the LLM may have double-escaped in JSON
      const desc = task.description.replace(/\\n/g, "\n");

      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
      ];
      if (task.owner) {
        lines.push(`Owner: ${task.owner}`);
      }
      lines.push(`Description: ${desc}`);

      if (task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          lines.push(`Blocked by: ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }
      if (task.blocks.length > 0) {
        lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);
      }

      // Show user-authored/runtime metadata, but keep attempt and cascade bookkeeping internal.
      const metadata = Object.fromEntries(
        Object.entries(task.metadata).filter(
          ([key]) => key !== "taskAttemptId"
            && key !== "taskCascadeConfig"
            && key !== "workflowAggregate",
        ),
      );
      if (Object.keys(metadata).length > 0) {
        lines.push(`Metadata: ${JSON.stringify(metadata)}`);
      }

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: TaskUpdate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Before starting work on a task:**
- Mark it in_progress BEFORE beginning — do not start work without updating status first
- After resolving, call TaskList to find your next task

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge user metadata keys into the task (set a key to null to delete it). \`workflowAggregate\` is reserved for the workflow runtime and is ignored.
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\``,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to update" }),
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
        type: "string",
        enum: ["pending", "in_progress", "completed", "deleted"],
        description: "New status for the task",
      })),
      subject: Type.Optional(Type.String({ description: "New subject for the task" })),
      description: Type.Optional(Type.String({ description: "New description for the task" })),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
      owner: Type.Optional(Type.String({ description: "New owner for the task" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "User metadata keys to merge into the task. Set a key to null to delete it. workflowAggregate is reserved for the workflow runtime and is ignored." })),
      addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
      addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { taskId, ...unfilteredFields } = params;
      const fields = { ...unfilteredFields };
      if (fields.metadata !== undefined) {
        fields.metadata = Object.fromEntries(
          Object.entries(fields.metadata).filter(([key]) => key !== "workflowAggregate"),
        );
        if (Object.keys(fields.metadata).length === 0) delete fields.metadata;
      }
      const taskStore = store;
      const operationGeneration = storeGeneration;
      const existing = taskStore.get(taskId);
      const executionBinding = existing?.execution;
      const execution = isTaskExecutionRef(executionBinding) ? executionBinding : undefined;
      let stopReservation: PreparedTaskStop | undefined;
      if (fields.status && fields.status !== "in_progress" && existing) {
        stopReservation = await stopTaskExecution(existing, operationGeneration, {
          status: fields.status === "pending" ? "pending" : "completed",
        });
        if (existing.status !== "in_progress" && fields.status !== existing.status) {
          detachTaskAgents(taskId);
        }
      }

      const update = execution && stopReservation
        ? taskStore.finalizeExecutionStop(execution, stopReservation.token, {
            ...fields,
            status: fields.status as "completed" | "pending" | "deleted",
          })
        : executionBinding
          ? taskStore.update(taskId, fields, executionBinding)
          : taskStore.update(taskId, fields);
      const { task, changedFields, warnings } = update;
      if (stopReservation) forgetStopReservation(stopReservation.ref);
      if (update.casMatched === false) {
        return textResult(`Task #${taskId} changed while its previous executor was stopping; no update was applied`);
      }
      if (update.casMatched === true && executionBinding
        && fields.status !== undefined && fields.status !== "in_progress") {
        forgetExecutionStore(executionBinding);
      }

      if (changedFields.length === 0 && !task) {
        return textResult(`Task #${taskId} not found`);
      }

      // Update the active session's UI/cleanup state only when this call still
      // belongs to it. The captured store above is safe to finish updating even
      // if a replacement session started while the stop RPC was pending.
      if (operationGeneration === storeGeneration) {
        if (fields.status === "in_progress") {
          widget.setActiveTask(taskId);
          autoClear.resetBatchCountdown();
        } else if (fields.status === "pending") {
          autoClear.resetBatchCountdown();
        } else if (fields.status === "completed" || fields.status === "deleted") {
          widget.setActiveTask(taskId, false);
          if (fields.status === "completed") autoClear.trackCompletion(taskId, cadence.currentTurn);
        }
        widget.update();
      }
      let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
      if (warnings.length > 0) {
        msg += ` (warning: ${warnings.join("; ")})`;
      }
      return textResult(msg);
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 5: TaskOutput
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskOutput",
    label: "TaskOutput",
    description: `- Retrieves status and output from an agent-backed task or a workflow run
- Takes a task_id parameter identifying a task, an unambiguous agent ID prefix, or a wf_* run ID returned by SubagentWorkflow
- Returns the current task/workflow status and settled output when available
- Use block=true (default) to explicitly join the task or workflow
- Use block=false for a non-blocking status check
- Structured task IDs can be found using the /tasks command`,
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID, agent ID/prefix, or SubagentWorkflow wf_* run ID to inspect" }),
      block: Type.Optional(Type.Boolean({ description: "Whether to wait for completion", default: true })),
      timeout: Type.Optional(Type.Number({ description: "Max wait time in ms", default: 30000, minimum: 0, maximum: 600000 })),
      view: Type.Optional(Type.Unsafe<"summary" | "children" | "result">({
        type: "string",
        enum: ["summary", "children", "result"],
        description: "Metadata views or an explicitly requested persisted result body slice.",
      })),
      offset: Type.Optional(Type.Number({ description: "Character offset for view=result", minimum: 0 })),
      limit: Type.Optional(Type.Number({
        description: "Maximum characters for view=result",
        default: TASK_OUTPUT_RESULT_DEFAULT_LIMIT,
        minimum: 0,
        maximum: TASK_OUTPUT_RESULT_MAX_LIMIT,
      })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const task_id = params.task_id;
      const block = params.block ?? true;
      const timeout = params.timeout ?? 30000;
      const view = params.view;
      if (view !== undefined && view !== "summary" && view !== "children" && view !== "result") {
        throw new Error(`Invalid TaskOutput view: ${String(view)}`);
      }
      const offset = params.offset ?? 0;
      const limit = params.limit ?? TASK_OUTPUT_RESULT_DEFAULT_LIMIT;
      if (!Number.isInteger(offset) || offset < 0 || offset > TASK_OUTPUT_RESULT_MAX_LIMIT) {
        throw new Error("TaskOutput offset must be a non-negative integer within the result limit");
      }
      if (!Number.isInteger(limit) || limit < 0 || limit > TASK_OUTPUT_RESULT_MAX_LIMIT) {
        throw new Error("TaskOutput limit must be a non-negative integer within the result limit");
      }
      const taskStore = store;
      const operationGeneration = storeGeneration;

      const renderView = (context: TaskOutputSummaryContext): ReturnType<typeof textResult> =>
        textResult(view === "children"
          ? formatTaskOutputChildren(context)
          : formatTaskOutputSummary(context));

      const renderResult = (
        context: TaskOutputSummaryContext,
        result?: { body: string; offset: number; limit: number; totalLength: number; hasMore: boolean },
        resultError?: string,
      ): ReturnType<typeof textResult> => textResult(formatTaskOutputResult({ ...context, result, resultError }));

      const workflowSummary = (workflow: WorkflowTaskOutputSnapshot): TaskOutputWorkflowSummary => ({
        id: workflow.id,
        status: workflow.status,
        name: workflow.name,
        doneCount: workflow.doneCount,
        totalCount: workflow.totalCount,
        replayedCount: workflow.replayedCount,
        totalTokens: workflow.totalTokens,
        totalToolCalls: workflow.totalToolCalls,
        elapsedMs: workflow.elapsedMs,
        attempts: workflow.attempts ?? [],
        coverage: workflow.coverage,
        resultBodyEnabled: workflow.resultBodyEnabled,
        artifactId: workflow.aggregateArtifactId,
        artifactStatus: workflow.aggregateArtifactStatus,
        evidenceIncomplete: workflow.evidenceIncomplete,
      });

      const readWorkflowResult = (
        runId: string,
        context: TaskOutputSummaryContext,
        resultBodyEnabled: boolean | undefined,
        artifactId: string | undefined,
        expectedRef?: TaskExecutionRef,
      ): ReturnType<typeof textResult> => {
        const workflow = context.workflow;
        if (workflow?.status === "running" || workflow?.status === "paused") {
          return renderResult(context, undefined, "workflow aggregate body is unavailable");
        }
        if (resultBodyEnabled === false) {
          return renderResult(context, undefined, TASK_OUTPUT_PRIVATE_MARKER);
        }
        if (workflow?.artifactStatus !== "complete") {
          return renderResult(context, undefined, "workflow aggregate body is unavailable");
        }
        const sessionId = ctx.sessionManager?.getSessionId?.();
        if (sessionId === undefined) {
          return renderResult(context, undefined, "result body is unavailable without a persisted session");
        }
        if (artifactId === undefined) {
          return renderResult(context, undefined, "workflow aggregate body is unavailable");
        }
        assertTaskOutputSafeId(artifactId, "workflow aggregate artifact id");
        const loaded = readWorkflowAggregateArtifactBody({
          cwd: ctx.cwd,
          sessionId,
          workflowId: runId,
          ...(expectedRef !== undefined ? { taskBinding: expectedRef } : {}),
          offset,
          limit,
        });
        if ("error" in loaded) throw new Error(loaded.error);
        if (loaded.manifest.artifactId !== artifactId
          || loaded.manifest.workflowId !== runId
          || loaded.manifest.artifactStatus !== "complete") {
          throw new Error(`Workflow aggregate metadata does not match its manifest for ${runId}`);
        }
        const rendered = renderResult(context, loaded.slice);
        options.workflowOutput?.consume(runId);
        return rendered;
      };
      const readUnboundWorkflowView = (runId: string): ReturnType<typeof textResult> | undefined => {
        const sessionId = ctx.sessionManager?.getSessionId?.();
        if (sessionId === undefined) return undefined;
        const readAggregate = options.workflowAggregateReader ?? readWorkflowAggregateArtifactManifest;
        const loaded = readAggregate({
          cwd: ctx.cwd,
          sessionId,
          workflowId: runId,
        });
        if (!("manifest" in loaded) || loaded.manifest.taskBinding !== undefined) return undefined;
        const manifest = loaded.manifest;
        const context: TaskOutputSummaryContext = {
          workflow: {
            id: runId,
            status: manifest.status,
            name: manifest.workflowName,
            attempts: manifest.childAttempts,
            coverage: manifest.coverage,
            resultBodyEnabled: manifest.resultSummary !== TASK_OUTPUT_PRIVATE_MARKER,
            artifactId: manifest.artifactId,
            artifactStatus: manifest.artifactStatus,
            artifactError: manifest.artifactError,
            evidenceIncomplete: manifest.evidenceIncomplete,
          },
        };
        if (view === "result") {
          return readWorkflowResult(
            runId,
            context,
            context.workflow?.resultBodyEnabled,
            manifest.artifactId,
          );
        }
        return renderView(context);
      };

      const readWorkflowView = async (
        runId: string,
        task?: Task,
        expectedRef?: TaskExecutionRef,
      ): Promise<ReturnType<typeof textResult>> => {
        assertTaskOutputSafeId(runId, "workflow id");
        let workflow = options.workflowOutput?.get(runId);
        if (workflow && block && (workflow.status === "running" || workflow.status === "paused")) {
          workflow = await options.workflowOutput!.wait(runId, {
            timeoutMs: timeout,
            ...(signal ? { signal } : {}),
          });
          if (!workflow) throw new Error("Workflow context changed while waiting for output");
        }
        if (workflow) {
          if (workflow.id !== runId) throw new Error("Workflow snapshot identity does not match the requested run");
          if (expectedRef !== undefined && workflow.taskExecutionRef !== undefined
            && !sameTaskExecutionRef(expectedRef, workflow.taskExecutionRef)) {
            throw new Error(`Workflow ${runId} task binding does not match Task #${task?.id ?? expectedRef.taskId}`);
          }
          if (task !== undefined && operationGeneration !== storeGeneration) {
            throw new Error("Task context changed while waiting for output");
          }
          const updated = task === undefined ? undefined : taskStore.get(task.id) ?? task;
          const liveContext: TaskOutputSummaryContext = {
            ...(updated === undefined
              ? {}
              : { taskId: updated.id, taskStatus: updated.status, owner: updated.owner }),
            ...(expectedRef !== undefined ? { execution: expectedRef } : {}),
            workflow: workflowSummary(workflow),
          };
          if (view === "result") {
            return readWorkflowResult(
              runId,
              liveContext,
              liveContext.workflow?.resultBodyEnabled,
              liveContext.workflow?.artifactId,
              expectedRef,
            );
          }
          return renderView(liveContext);
        }

        if (task === undefined) {
          const unbound = readUnboundWorkflowView(runId);
          if (unbound !== undefined) return unbound;
          const known = options.workflowOutput?.list() ?? [];
          throw new Error(
            `No workflow run with ID ${runId}. ${known.length > 0
              ? `Known workflow runs: ${known.join(", ")}`
              : "No workflow runs are available in this session."}`,
          );
        }

        const rawAggregate = task.metadata.workflowAggregate;
        const aggregate = parseTaskWorkflowAggregateMetadata(rawAggregate, runId, task.id);
        if (rawAggregate !== undefined && aggregate === undefined) {
          throw new Error(`Invalid workflow aggregate metadata for Task #${task.id}`);
        }
        if (aggregate === undefined) {
          const context: TaskOutputSummaryContext = {
            taskId: task.id,
            taskStatus: task.status,
            owner: task.owner,
            workflow: {
              id: runId,
              status: task.status,
              attempts: [],
            },
          };
          return view === "result"
            ? readWorkflowResult(runId, context, undefined, undefined, expectedRef)
            : renderView(context);
        }
        if (expectedRef !== undefined && !sameTaskExecutionRef(expectedRef, aggregate.taskBinding)) {
          throw new Error(`Workflow aggregate task binding does not match Task #${task.id}`);
        }

        const sessionId = ctx.sessionManager?.getSessionId?.();
        const resultDoesNotNeedManifest = view === "result" && aggregate.artifactStatus !== "complete";
        if (aggregate.artifactStatus === "skipped" || sessionId === undefined || resultDoesNotNeedManifest) {
          const artifactError = sessionId === undefined && aggregate.artifactStatus !== "skipped"
            ? "workflow aggregate is unavailable without a persisted session"
            : undefined;
          if (view === "children" && artifactError !== undefined) throw new Error(artifactError);
          const context: TaskOutputSummaryContext = {
            taskId: task.id,
            taskStatus: task.status,
            owner: task.owner,
            execution: aggregate.taskBinding,
            workflow: {
              id: runId,
              status: aggregate.status,
              attempts: [],
              coverage: aggregate.coverage,
              resultBodyEnabled: aggregate.resultBodyEnabled,
              artifactId: aggregate.artifactId,
              artifactStatus: aggregate.artifactStatus,
              artifactError,
              evidenceIncomplete: aggregate.evidenceIncomplete,
            },
          };
          if (view === "result") {
            return readWorkflowResult(
              runId,
              context,
              aggregate.resultBodyEnabled,
              aggregate.artifactId,
              expectedRef,
            );
          }
          return renderView(context);
        }

        const readAggregate = options.workflowAggregateReader ?? readWorkflowAggregateArtifactManifest;
        const loaded = readAggregate({
          cwd: ctx.cwd,
          sessionId,
          workflowId: runId,
          taskBinding: aggregate.taskBinding,
        });
        if ("error" in loaded) {
          if (view === "children" || view === "result") throw new Error(loaded.error);
          return renderView({
            taskId: task.id,
            taskStatus: task.status,
            owner: task.owner,
            execution: aggregate.taskBinding,
            workflow: {
              id: runId,
              status: aggregate.status,
              attempts: [],
              coverage: aggregate.coverage,
              resultBodyEnabled: aggregate.resultBodyEnabled,
              artifactId: aggregate.artifactId,
              artifactStatus: aggregate.artifactStatus,
              artifactError: loaded.error,
              evidenceIncomplete: aggregate.evidenceIncomplete,
            },
          });
        }
        const manifest = loaded.manifest;
        if (manifest.status !== aggregate.status
          || manifest.artifactId !== aggregate.artifactId
          || manifest.artifactStatus !== aggregate.artifactStatus
          || canonicalJson(manifest.coverage) !== canonicalJson(aggregate.coverage)
          || Boolean(manifest.evidenceIncomplete) !== Boolean(aggregate.evidenceIncomplete)) {
          throw new Error(`Workflow aggregate metadata does not match its manifest for Task #${task.id}`);
        }
        const context: TaskOutputSummaryContext = {
          taskId: task.id,
          taskStatus: task.status,
          owner: task.owner,
          execution: aggregate.taskBinding,
          workflow: {
            id: runId,
            status: manifest.status,
            name: manifest.workflowName,
            attempts: manifest.childAttempts,
            coverage: manifest.coverage,
            resultBodyEnabled: aggregate.resultBodyEnabled,
            artifactId: manifest.artifactId,
            artifactStatus: manifest.artifactStatus,
            evidenceIncomplete: manifest.evidenceIncomplete,
          },
        };
        if (view === "result") {
          return readWorkflowResult(
            runId,
            context,
            aggregate.resultBodyEnabled,
            manifest.artifactId,
            expectedRef,
          );
        }
        return renderView(context);
      };

      const waitForAgentView = async (task: Task, agentId: string): Promise<Task> => {
        if (block && task.status === "in_progress") {
          await new Promise<void>((resolveWait) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout>;
            let unsubOk: () => void = () => {};
            let unsubFail: () => void = () => {};
            const cleanup = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              unsubOk();
              unsubFail();
              signal?.removeEventListener("abort", cleanup);
              resolveWait();
            };
            unsubOk = pi.events.on("subagents:completed", (data: unknown) => {
              if (eventAgentId(data) === agentId) cleanup();
            });
            unsubFail = pi.events.on("subagents:failed", (data: unknown) => {
              if (eventAgentId(data) === agentId) cleanup();
            });
            timer = setTimeout(cleanup, timeout);
            const current = taskStore.get(task.id);
            if (current && current.status !== "in_progress") cleanup();
            else if (signal?.aborted) cleanup();
            else signal?.addEventListener("abort", cleanup, { once: true });
          });
        }
        if (operationGeneration !== storeGeneration) {
          throw new Error("Task context changed while waiting for output");
        }
        return taskStore.get(task.id) ?? task;
      };

      const readAgentView = async (
        task: Task,
        agentId: string,
        execution?: TaskExecutionRef,
      ): Promise<ReturnType<typeof textResult>> => {
        assertTaskOutputSafeId(agentId, "agent id");
        const updated = await waitForAgentView(task, agentId);
        const record = getTaskAgentRegistry()?.getRecord(agentId);
        if (record !== undefined) {
          if (record.id !== agentId) throw new Error("Agent registry identity does not match the requested agent");
          if (record.taskExecutionRef !== undefined) {
            if (record.taskExecutionRef.executorId !== agentId
              || record.taskExecutionRef.taskId !== task.id
              || (execution !== undefined && !sameTaskExecutionRef(execution, record.taskExecutionRef))) {
              throw new Error(`Agent ${agentId} task binding does not match Task #${task.id}`);
            }
          }
        }
        const usage = record?.lifetimeUsage;
        const agent: TaskOutputAgentSummary = {
          id: agentId,
          status: record?.status ?? updated.status,
          artifactId: record?.artifactId,
          artifactStatus: record?.artifactStatus,
          resultBodyEnabled: record?.resultBodyEnabled,
          model: record?.invocation?.modelId ?? record?.invocation?.modelName,
          turns: record?.turnCount,
          toolCalls: record?.toolUses,
          tokens: usage === undefined ? undefined : usage.input + usage.output + usage.cacheWrite,
        };
        const context: TaskOutputSummaryContext = {
          taskId: updated.id,
          taskStatus: updated.status,
          owner: updated.owner,
          ...(execution !== undefined ? { execution } : {}),
          agent,
        };
        if (view === "result") {
          if (agent.status === "running" || agent.status === "queued" || agent.artifactStatus === "pending") {
            return renderResult(context, undefined, "result body is unavailable");
          }
          if (agent.resultBodyEnabled === false) {
            return renderResult(context, undefined, TASK_OUTPUT_PRIVATE_MARKER);
          }
          const sessionId = ctx.sessionManager?.getSessionId?.();
          if (sessionId === undefined) {
            return renderResult(context, undefined, "result body is unavailable without a persisted session");
          }
          if (agent.artifactId === undefined) {
            return renderResult(context, undefined, "result body is unavailable");
          }
          assertTaskOutputSafeId(agent.artifactId, "agent artifact id");
          const loaded = readResultArtifactBody({
            cwd: ctx.cwd,
            sessionId,
            agentId,
            artifactId: agent.artifactId,
            offset,
            limit,
          });
          if ("error" in loaded) throw new Error(loaded.error);
          if (loaded.manifest.agentId !== agentId || loaded.manifest.artifactId !== agent.artifactId) {
            throw new Error(`Agent result metadata does not match the requested agent ${agentId}`);
          }
          const rendered = renderResult(context, loaded.slice);
          consumeSubagentResult(agentId);
          return rendered;
        }
        return renderView(context);
      };

      if (view !== undefined) {
        if (!task_id) throw new Error("task_id is required");
        if (task_id.startsWith("wf_")) {
          const tasks = taskStore.list();
          const liveWorkflow = options.workflowOutput?.get(task_id);
          const canonicalCandidates = tasks.flatMap(candidate => {
            const execution = candidate.execution;
            return isTaskExecutionRef(execution)
                && execution.kind === "workflow"
                && execution.executorId === task_id
              ? [{ task: candidate, execution }]
              : [];
          });
          if (liveWorkflow !== undefined) {
            const snapshotRef = liveWorkflow.taskExecutionRef;
            const matchingCandidates = snapshotRef === undefined
              ? canonicalCandidates
              : canonicalCandidates.filter(candidate => sameTaskExecutionRef(candidate.execution, snapshotRef));
            if (matchingCandidates.length > 1) {
              throw new Error(`Multiple canonical tasks are bound to workflow ${task_id}`);
            }
            const canonical = matchingCandidates[0];
            return readWorkflowView(
              task_id,
              canonical?.task,
              snapshotRef ?? canonical?.execution,
            );
          }

          const aggregateCandidates = tasks.flatMap(task => {
            try {
              const aggregate = parseTaskWorkflowAggregateMetadata(
                task.metadata.workflowAggregate,
                task_id,
                task.id,
              );
              return aggregate === undefined ? [] : [{ task, execution: aggregate.taskBinding }];
            } catch {
              return [];
            }
          });
          if (aggregateCandidates.length > 1) {
            throw new Error(`Multiple tasks contain validated workflow aggregate metadata for ${task_id}`);
          }
          const aggregateCandidate = aggregateCandidates[0];
          if (aggregateCandidate !== undefined) {
            return readWorkflowView(task_id, aggregateCandidate.task, aggregateCandidate.execution);
          }

          const unbound = readUnboundWorkflowView(task_id);
          if (unbound !== undefined) return unbound;

          const legacyCandidates = tasks.filter(candidate =>
            candidate.execution === undefined
            && candidate.metadata.workflowAggregate === undefined
            && candidate.metadata.workflowId === task_id
          );
          if (legacyCandidates.length > 1) {
            throw new Error(`Multiple legacy tasks reference workflow ${task_id}`);
          }
          const legacy = legacyCandidates[0];
          return readWorkflowView(task_id, legacy);
        }

        const processOutput = tracker.getOutput(task_id);
        if (processOutput !== undefined) {
          const context = { taskId: task_id, taskStatus: processOutput.status };
          return view === "result"
            ? renderResult(context, undefined, "result body is unavailable")
            : renderView(context);
        }
        const resolvedId = resolveTaskId(task_id);
        const task = taskStore.get(resolvedId);
        if (!task) throw new Error(`No task found with ID ${task_id}`);
        const execution = task.execution;
        if (isTaskExecutionRef(execution) && execution.kind === "workflow") {
          return readWorkflowView(execution.executorId, task, execution);
        }
        if (isTaskExecutionClaim(execution) && execution.kind === "workflow") {
          const context = { taskId: task.id, taskStatus: task.status, owner: task.owner };
          return view === "result"
            ? renderResult(context, undefined, "workflow aggregate body is unavailable while the controller is starting")
            : textResult(`${formatTaskOutputSummary(context)}\nWorkflow: controller is starting`);
        }
        const rawAggregate = task.metadata.workflowAggregate;
        if (rawAggregate !== undefined) {
          const taskBinding = rawAggregate !== null && typeof rawAggregate === "object"
            && !Array.isArray(rawAggregate) && "taskBinding" in rawAggregate
            ? rawAggregate.taskBinding
            : undefined;
          const aggregateWorkflowId = taskBinding !== null && typeof taskBinding === "object"
            && !Array.isArray(taskBinding) && "executorId" in taskBinding
            && typeof taskBinding.executorId === "string"
            ? taskBinding.executorId
            : undefined;
          const aggregate = aggregateWorkflowId === undefined
            ? undefined
            : parseTaskWorkflowAggregateMetadata(rawAggregate, aggregateWorkflowId, task.id);
          if (aggregate === undefined) {
            throw new Error(`Invalid workflow aggregate metadata for Task #${task.id}`);
          }
          return readWorkflowView(aggregate.taskBinding.executorId, task, aggregate.taskBinding);
        }
        if (execution === undefined && typeof task.metadata.workflowId === "string") {
          return readWorkflowView(task.metadata.workflowId, task);
        }
        if (isTaskExecutionRef(execution) && execution.kind === "agent") {
          return readAgentView(task, execution.executorId, execution);
        }
        if (isTaskExecutionClaim(execution) && execution.kind === "agent") {
          const context = { taskId: task.id, taskStatus: task.status, owner: task.owner };
          return view === "result"
            ? renderResult(context, undefined, "result body is unavailable while the agent is starting")
            : textResult(`${formatTaskOutputSummary(context)}\nAgent: starting`);
        }
        if (execution === undefined && typeof task.metadata.agentId === "string") {
          return readAgentView(task, task.metadata.agentId);
        }
        const context = { taskId: task.id, taskStatus: task.status, owner: task.owner };
        return view === "result"
          ? renderResult(context, undefined, "result body is unavailable")
          : renderView(context);
      }

      const readPersistedWorkflow = (runId: string): string | undefined => {
        const task = taskStore.list().find(candidate =>
          candidate.metadata.workflowId === runId
          && candidate.status !== "in_progress"
          && (typeof candidate.metadata.result === "string"
            || typeof candidate.metadata.lastError === "string"),
        );
        if (!task) return undefined;
        const output = typeof task.metadata.result === "string"
          ? task.metadata.result
          : `Error: ${task.metadata.lastError}`;
        return `Task #${task.id} [${task.status}] — workflow ${runId}\n\n${sanitizeWorkflowOutputField(output)}`;
      };
      const readWorkflow = async (runId: string): Promise<WorkflowTaskOutputSnapshot> => {
        let workflow = options.workflowOutput?.get(runId);
        if (!workflow) {
          const known = options.workflowOutput?.list() ?? [];
          throw new Error(
            `No workflow run with ID ${runId}. ${known.length > 0
              ? `Known workflow runs: ${known.join(", ")}`
              : "No workflow runs are available in this session."}`,
          );
        }
        if (block && (workflow.status === "running" || workflow.status === "paused")) {
          workflow = await options.workflowOutput!.wait(runId, {
            timeoutMs: timeout,
            ...(signal ? { signal } : {}),
          });
          if (!workflow) throw new Error("Workflow context changed while waiting for output");
        }
        const settled = workflow.status !== "running" && workflow.status !== "paused";
        if (settled && workflow.output !== undefined) options.workflowOutput?.consume(runId);
        return workflow;
      };
      // Reject an empty id up front: every agent ID starts with "", so the prefix
      // match below would resolve it to whichever agent the map yields first.
      if (!task_id) throw new Error("task_id is required");

      if (task_id.startsWith("wf_")) {
        const persisted = readPersistedWorkflow(task_id);
        if (persisted !== undefined) return textResult(persisted);
        return textResult(workflowOutputText(await readWorkflow(task_id)));
      }

      const processOutput = tracker.getOutput(task_id);
      if (!processOutput) {
        // No shell process — check if this is a subagent task
        // Support both task IDs and agent IDs (resolve agent ID → task ID)
        const resolvedId = resolveTaskId(task_id);
        const task = taskStore.get(resolvedId);
        if (!task) throw new Error(`No task found with ID ${task_id}`);

        const execution = task.execution;
        const workflowId = isTaskExecutionRef(execution) && execution.kind === "workflow"
          ? execution.executorId
          : execution === undefined && typeof task.metadata.workflowId === "string"
            ? task.metadata.workflowId
            : undefined;
        if (workflowId) {
          const liveWorkflow = options.workflowOutput?.get(workflowId);
          if (liveWorkflow) {
            const workflow = await readWorkflow(workflowId);
            if (operationGeneration !== storeGeneration) {
              throw new Error("Task context changed while waiting for output");
            }
            const updated = taskStore.get(resolvedId) ?? task;
            return textResult(
              `Task #${resolvedId} [${updated.status}] — ${workflowOutputText(workflow)}`,
            );
          }

          // The controller map is session-local, while the Todo outcome is
          // persisted. A reload, resume, or fork can therefore retain the
          // workflowId after the live adapter has gone away; return the stored
          // result/error instead of treating that expected residue as an
          // unknown workflow run.
          const output = typeof task.metadata.result === "string"
            ? task.metadata.result
            : typeof task.metadata.lastError === "string"
              ? `Error: ${task.metadata.lastError}`
              : undefined;
          return textResult(
            `Task #${resolvedId} [${task.status}] — workflow ${workflowId}${
              output !== undefined ? `\n\n${sanitizeWorkflowOutputField(output)}` : ""
            }`,
          );
        }
        if (execution?.kind === "workflow") {
          return textResult(`Task #${resolvedId} [${task.status}] — workflow controller is starting`);
        }

        const agentId = isTaskExecutionRef(execution) && execution.kind === "agent"
          ? execution.executorId
          : execution === undefined && typeof task.metadata.agentId === "string"
            ? task.metadata.agentId
            : undefined;
        if (agentId) {
          // Subagent task — wait for completion if blocking
          if (block && task.status === "in_progress") {
            await new Promise<void>((resolve) => {
              let settled = false;
              let timer: ReturnType<typeof setTimeout>;
              let unsubOk: () => void = () => {};
              let unsubFail: () => void = () => {};
              const cleanup = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                unsubOk();
                unsubFail();
                signal?.removeEventListener("abort", cleanup);
                resolve();
              };
              unsubOk = pi.events.on("subagents:completed", (data: unknown) => {
                if (eventAgentId(data) === agentId) cleanup();
              });
              unsubFail = pi.events.on("subagents:failed", (data: unknown) => {
                if (eventAgentId(data) === agentId) cleanup();
              });
              timer = setTimeout(cleanup, timeout);
              // Re-read before committing to the wait. Nothing awaits since the outer
              // check, so this only differs on a shared file-backed list, where
              // store.get() reloads and another session may have finished the task.
              const current = taskStore.get(resolvedId);
              if (current && current.status !== "in_progress") cleanup();
              else if (signal?.aborted) cleanup();
              else signal?.addEventListener("abort", cleanup, { once: true });
            });
          }
          // Re-read by resolved ID — `task` predates the wait, and a file-backed
          // store deserializes a fresh object on every load, so it is stale here.
          if (operationGeneration !== storeGeneration) {
            throw new Error("Task context changed while waiting for output");
          }
          const updated = taskStore.get(resolvedId) ?? task;
          // Consume only what is actually handed over: the agent has reported back
          // (it leaves the map when it does) and the task carries its outcome. Short
          // of both — still running, or an update that never landed — the model is
          // getting a status, and the notification pi-subagents is holding is the
          // only thing that will announce the result.
          if (!agentTaskMap.has(agentId) && updated.status !== "in_progress") consumeSubagentResult(agentId);
          const output = updated.metadata?.result
            ?? (updated.metadata?.lastError ? `Error: ${updated.metadata.lastError}` : undefined);
          return textResult(
            `Task #${resolvedId} [${updated.status}] — subagent ${agentId}${output ? `\n\n${output}` : ""}`,
          );
        }
        if (execution?.kind === "agent") {
          return textResult(`Task #${resolvedId} [${task.status}] — subagent is starting`);
        }
        throw new Error(`No background process for task ${task_id}`);
      }

      if (block && processOutput.status === "running") {
        const result = await tracker.waitForCompletion(task_id, timeout ?? 30000, signal ?? undefined);
        if (result) {
          return textResult(
            `Task #${task_id} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`,
          );
        }
      }

      return textResult(
        `Task #${task_id} (${processOutput.status})${processOutput.exitCode !== undefined ? ` exit code: ${processOutput.exitCode}` : ""}\n\n${processOutput.output}`,
      );
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 6: TaskStop
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: `
- Stops a running agent-backed task by its task ID or unambiguous agent ID prefix
- Returns success only after the subagent runtime confirms the stop
- Use this tool when you need to terminate a long-running task`,
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
      shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = params.task_id ?? params.shell_id;
      if (!taskId) throw new Error("task_id is required");
      const taskStore = store;
      const operationGeneration = storeGeneration;
      const resolvedId = resolveTaskId(taskId);
      const task = taskStore.get(resolvedId);

      const stopped = await tracker.stop(taskId);
      if (!stopped) {
        // No shell process — use the task/execution captured before the first
        // await, so a concurrent session switch cannot redirect this stop to a
        // replacement task with the same numeric ID.
        const ref = task?.execution;
        if (task?.status === "in_progress" && isTaskExecutionRef(ref)) {
          const reservation = await stopTaskExecutor(task, { status: "completed" });
          if (!reservation) {
            if (operationGeneration === storeGeneration && executionHandle(ref) !== undefined) {
              throw new Error(`Task #${resolvedId} changed while stopping`);
            }
            return textResult(`Task #${resolvedId} stopped successfully`);
          }
          const retainBinding = ref.kind === "agent" && agentTaskMap.has(ref.executorId);
          const ownsReservation = stopReservations.get(executionHandleKey(ref))?.token
            === reservation.token;
          const finalized = updateTaskExecution(
            ref,
            { status: "completed" },
            reservation.token,
            retainBinding,
          );
          if (!finalized && ownsReservation && operationGeneration === storeGeneration) {
            throw new Error(`Task #${resolvedId} changed while stopping`);
          }
          if (operationGeneration === storeGeneration) {
            autoClear.trackCompletion(resolvedId, cadence.currentTurn);
            widget.setActiveTask(resolvedId, false);
            widget.update();
          }
          return textResult(`Task #${resolvedId} stopped successfully`);
        }
        throw new Error(`No running background process for task ${taskId}`);
      }

      taskStore.update(taskId, { status: "completed" });
      if (operationGeneration === storeGeneration) {
        autoClear.trackCompletion(taskId, cadence.currentTurn);
        widget.setActiveTask(taskId, false);
        widget.update();
      }
      return textResult(`Task #${taskId} stopped successfully`);
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 7: TaskExecute
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskExecute",
    label: "TaskExecute",
    description: `Execute one or more tasks as subagents.

## When to Use This Tool

- To start execution of tasks that have \`agentType\` set (created via TaskCreate with agentType parameter)
- Tasks must be \`pending\` with all blockedBy dependencies \`completed\`
- Each task runs as an independent background subagent

## Parameters

- **task_ids**: Array of task IDs to execute
- **additional_context**: Extra context appended to each agent's prompt
- **model**: Model override for agents (e.g., "sonnet", "haiku")
- **max_turns**: Maximum turns per agent`,
    promptGuidelines: [
      "Never use the Agent tool for tasks launched via TaskExecute — agents are already running.",
    ],
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "Task IDs to execute as subagents" }),
      additional_context: Type.Optional(Type.String({ description: "Extra context for agent prompts" })),
      model: Type.Optional(Type.String({ description: "Model override for agents" })),
      max_turns: Type.Optional(Type.Number({ description: "Max turns per agent", minimum: 1 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!subagentsAvailable) {
        return textResult(
          "Subagent execution is currently unavailable (the bundled runtime is not ready " +
          "or its protocol does not match). You can run these as plain Agent-tool spawns, but the task " +
          "tracker won't follow them — status stays pending, cascade won't fire, and TaskOutput stays empty."
        );
      }

      const results: string[] = [];
      const launched: string[] = [];
      const taskStore = store;
      const operationGeneration = storeGeneration;
      const cascadeConfig: TaskCascadeConfig = {
        additionalContext: params.additional_context,
        model: params.model,
        maxTurns: params.max_turns,
      };

      for (const taskId of params.task_ids) {
        if (operationGeneration !== storeGeneration) break;
        const task = taskStore.get(taskId);
        if (!task) {
          results.push(`#${taskId}: not found`);
          continue;
        }
        if (task.status !== "pending") {
          results.push(`#${taskId}: not pending (status: ${task.status})`);
          continue;
        }
        if (!task.metadata?.agentType) {
          results.push(`#${taskId}: no agentType set — create with agentType parameter or update metadata`);
          continue;
        }

        // Check all blockers are completed
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = taskStore.get(bid);
          return !blocker || blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          results.push(`#${taskId}: blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
          continue;
        }

        const claimed = taskStore.claimPending(taskId, {
          kind: "agent",
          taskAttemptId: randomUUID(),
          attemptId: randomUUID(),
        });
        const claim = claimed?.execution;
        if (!claimed || !claim) {
          results.push(`#${taskId}: already claimed by another session or execution`);
          continue;
        }
        rememberExecutionStore(claim, taskStore);

        const agentType = claimed.metadata.agentType;
        if (!agentType) {
          taskStore.rollbackExecution(claim);
          results.push(`#${taskId}: no agentType set — create with agentType parameter or update metadata`);
          continue;
        }

        const prompt = buildTaskPrompt(claimed, params.additional_context);
        try {
          const spawned = await spawnSubagent(agentType, prompt, {
            description: claimed.subject,
            isBackground: true,
            maxTurns: params.max_turns,
            ...(params.model ? { model: params.model } : {}),
            taskExecution: claim,
          });
          if (!taskExecutionRefMatchesClaim(spawned.taskExecutionRef, claim, spawned.id)) {
            try { await stopSubagent(spawned.id); } catch { /* invalid runtime reply; best-effort cleanup */ }
            taskStore.rollbackExecution(claim, "subagent runtime returned a mismatched task execution ref");
            forgetExecutionStore(claim);
            results.push(`#${taskId}: spawn failed — subagent runtime returned a mismatched task execution ref`);
            continue;
          }
          const bound = operationGeneration === storeGeneration
            ? taskStore.bindExecution(claim, spawned.id)
            : undefined;
          if (!bound) {
            try { await stopSubagent(spawned.id); } catch { /* session teardown or reset may have stopped it already */ }
            taskStore.rollbackExecution(claim, "task or session changed before agent startup completed");
            forgetExecutionStore(claim);
            results.push(
              `#${taskId}: ${operationGeneration !== storeGeneration
                ? "session changed before launch completed"
                : "task changed before launch completed"}`,
            );
            if (operationGeneration !== storeGeneration) break;
            continue;
          }
          const metadataCommitted = taskStore.updateExecution(bound, {
            owner: spawned.id,
            metadata: { agentId: spawned.id, taskCascadeConfig: cascadeConfig },
          });
          if (!metadataCommitted) {
            await cleanupFailedLaunch(
              bound,
              taskStore,
              "task changed before agent launch metadata was committed",
            );
            results.push(`#${taskId}: launch lost the task binding before metadata was committed`);
            continue;
          }
          agentTaskMap.set(spawned.id, bound);
          agentCascadeConfigs.set(spawned.id, cascadeConfig);
          widget.setActiveTask(taskId);
          await reconcileSettledAgent(spawned.id);
          launched.push(`#${taskId} → agent ${spawned.id}`);
        } catch (error) {
          debug(`spawn:error task=#${taskId}`, error);
          taskStore.rollbackExecution(claim, errorMessage(error));
          forgetExecutionStore(claim);
          results.push(`#${taskId}: spawn failed — ${errorMessage(error)}`);
        }
      }

      if (operationGeneration === storeGeneration) widget.update();

      const lines: string[] = [];
      if (launched.length > 0) {
        lines.push(
          `Launched ${launched.length} agent(s):\n${launched.join("\n")}\n` +
          "TaskOutput can explicitly join or inspect one of these tasks. Do not poll or spawn duplicate agents."
        );
      }
      if (results.length > 0) lines.push(`Skipped:\n${results.join("\n")}`);
      if (lines.length === 0) lines.push("No tasks to execute.");

      return textResult(lines.join("\n\n"));
    },
  });

  // ──────────────────────────────────────────────────
  // /tasks command
  // ──────────────────────────────────────────────────

  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear completed",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      latestCtx = ctx;
      widget.setUICtx(ctx.ui as UICtx);
      initializeStoreForContext(ctx);
      const ui = ctx.ui;

      const mainMenu = async (): Promise<void> => {
        const tasks = store.list();
        const taskCount = tasks.length;
        const completedCount = tasks.filter(t => t.status === "completed").length;

        const choices: string[] = [
          `View all tasks (${taskCount})`,
          "Create task",
        ];
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
        choices.push("Settings");

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) {
          await viewTasks();
        } else if (choice === "Create task") {
          await createTask();
        } else if (choice === "Settings") {
          await settingsMenu();
        } else if (choice.startsWith("Clear completed")) {
          for (const task of store.list()) {
            if (task.status === "completed" && task.execution === undefined) {
              detachTaskAgents(task.id);
            }
          }
          store.clearCompleted();
          if (isSessionScope()) deleteSessionFileIfEmpty();
          widget.update();
          await mainMenu();
        } else if (choice.startsWith("Clear all")) {
          const tasksToClear = store.list();
          const startingTask = tasksToClear.find(task => isTaskExecutionClaim(task.execution));
          if (startingTask && isTaskExecutionClaim(startingTask.execution)) {
            ui.notify(
              `Could not clear tasks: task #${startingTask.id} has a ${startingTask.execution.kind} execution starting; wait for startup to finish`,
              "warning",
            );
            return mainMenu();
          }
          const boundTasks = tasksToClear.filter(task => isTaskExecutionRef(task.execution));
          const preparedStops = new Map<string, PreparedTaskStop>();
          // Stop every bound executor first. No task is deleted until all stops
          // succeed, so a failed stop cannot leave a partially cleared list.
          try {
            for (const task of boundTasks) {
              const ref = task.execution;
              if (!isTaskExecutionRef(ref)) continue;
              const prepared = await stopTaskExecution(task);
              if (prepared) {
                preparedStops.set(executionHandleKey(ref), prepared);
                detachTaskAgents(task.id);
              }
            }
          } catch (error) {
            ui.notify(`Could not stop active task: ${errorMessage(error)}`, "warning");
            return mainMenu();
          }
          let changedDuringClear = false;
          for (const task of tasksToClear) {
            if (isTaskExecutionRef(task.execution)) {
              const ref = task.execution;
              const prepared = preparedStops.get(executionHandleKey(ref));
              if (prepared && !updateTaskExecution(ref, { status: "deleted" }, prepared.token)) {
                changedDuringClear = true;
              }
              continue;
            }
            detachTaskAgents(task.id);
            const updated = store.update(task.id, { status: "deleted" });
            if (updated.changedFields.length === 0 && store.get(task.id) !== undefined) {
              changedDuringClear = true;
            }
          }
          if (changedDuringClear) {
            ui.notify("Some tasks changed or started execution while clearing; those tasks were left unchanged", "warning");
          }
          if (isSessionScope()) deleteSessionFileIfEmpty();
          widget.update();
          await mainMenu();
        }
      };

      const viewTasks = async (): Promise<void> => {
        const tasks = store.list();
        if (tasks.length === 0) {
          await ui.select("No tasks", ["← Back"]);
          return mainMenu();
        }

        const glyphs = resolveTaskGlyphs(cfg.glyphs);
        const statusGlyph = (status: string) => {
          switch (status) {
            case "completed": return glyphs.completed;
            case "in_progress": return glyphs.inProgress;
            default: return glyphs.pending;
          }
        };

        const choices = tasks.map(t =>
          `${statusGlyph(t.status)} #${t.id} [${t.status}] ${t.subject}`
        );
        choices.push("← Back");

        const selected = await ui.select("Tasks", choices);
        if (!selected || selected === "← Back") return mainMenu();

        // Matched by row position rather than parsed out of the label: both the glyph
        // and the subject are free text, and either can contain something like "#42".
        const picked = tasks[choices.indexOf(selected)];
        if (picked) await viewTaskDetail(picked.id);
        else return viewTasks();
      };

      const viewTaskDetail = async (taskId: string): Promise<void> => {
        const task = store.get(taskId);
        if (!task) return viewTasks();

        const actions: string[] = [];

        if (task.status === "pending") {
          actions.push("▸ Start (in_progress)");
        }
        if (task.status === "in_progress") {
          actions.push("✓ Complete");
        }
        actions.push("✗ Delete");
        actions.push("← Back");

        const title = `#${task.id} [${task.status}] ${task.subject}\n${task.description}`;
        const action = await ui.select(title, actions);

        if (action === "▸ Start (in_progress)") {
          store.update(taskId, { status: "in_progress" });
          widget.setActiveTask(taskId);
          widget.update();
          return viewTasks();
        } else if (action === "✓ Complete") {
          const ref = isTaskExecutionRef(task.execution) ? task.execution : undefined;
          let prepared: PreparedTaskStop | undefined;
          try {
            prepared = await stopTaskExecution(task);
          } catch (error) {
            ui.notify(`Could not stop task #${taskId}: ${errorMessage(error)}`, "warning");
            return viewTasks();
          }
          const updated = ref
            ? prepared !== undefined && updateTaskExecution(ref, { status: "completed" }, prepared.token)
            : store.update(taskId, { status: "completed" }).changedFields.length > 0;
          if (!updated && ref) {
            ui.notify(`Could not complete task #${taskId}: task changed while stopping`, "warning");
            return viewTasks();
          }
          autoClear.trackCompletion(taskId, cadence.currentTurn);
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        } else if (action === "✗ Delete") {
          if (isTaskExecutionClaim(task.execution)) {
            ui.notify(
              `Could not delete task #${taskId}: ${task.execution.kind} execution is starting; wait for startup to finish`,
              "warning",
            );
            return viewTasks();
          }
          const ref = isTaskExecutionRef(task.execution) ? task.execution : undefined;
          let prepared: PreparedTaskStop | undefined;
          try {
            prepared = await stopTaskExecution(task);
          } catch (error) {
            ui.notify(`Could not stop task #${taskId}: ${errorMessage(error)}`, "warning");
            return viewTasks();
          }
          const updated = ref
            ? prepared !== undefined && updateTaskExecution(ref, { status: "deleted" }, prepared.token)
            : store.update(taskId, { status: "deleted" }).changedFields.length > 0;
          if (!updated) {
            ui.notify(`Could not delete task #${taskId}: task changed or started execution`, "warning");
            return viewTasks();
          }
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        }
        return viewTasks();
      };

      const settingsMenu = (): Promise<void> =>
        openSettingsMenu(ui, cfg, mainMenu, AUTO_CLEAR_DELAY, ctx.cwd);

      const createTask = async (): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();

        store.create(subject, description);
        widget.update();
        return mainMenu();
      };

      await mainMenu();
    },
  });

  return {
    claim(taskId, kind, attemptId = randomUUID(), taskAttemptId = randomUUID()) {
      const taskStore = store;
      const claimed = taskStore.claimPending(taskId, { kind, attemptId, taskAttemptId });
      if (!claimed?.execution) return undefined;
      rememberExecutionStore(claimed.execution, taskStore);
      widget.setActiveTask(taskId);
      autoClear.resetBatchCountdown();
      widget.update();
      return { ...claimed.execution };
    },
    bind(claim, executorId) {
      return executionHandle(claim)?.store.bindExecution(claim, executorId);
    },
    rollback(claim, error) {
      const handle = executionHandle(claim);
      const committed = handle?.store.rollbackExecution(claim, error) ?? false;
      forgetExecutionStore(claim);
      if (committed && handle?.store === store && handle.generation === storeGeneration) {
        widget.setActiveTask(claim.taskId, false);
        autoClear.resetBatchCountdown();
        widget.update();
      }
      return committed;
    },
    prepare(ref, status, error) {
      return prepareTaskExecution(ref, status, error);
    },
    restore(ref, token) {
      return restoreTaskExecution(ref, token);
    },
    update(ref, fields) {
      const handle = executionHandle(ref);
      const committed = handle?.store.updateExecution(ref, fields) ?? false;
      if (committed && handle?.store === store && handle.generation === storeGeneration) {
        widget.update();
      }
      return committed;
    },
    updateStop(ref, fields) {
      const reservation = stopReservations.get(executionHandleKey(ref));
      if (!reservation || !sameTaskExecutionRef(reservation.ref, ref)) return false;
      const committed = reservation.store.updateExecutionStopMetadata(ref, reservation.token, fields.metadata ?? {});
      if (committed && reservation.store === store && reservation.generation === storeGeneration) {
        widget.update();
      }
      return committed;
    },
    settle(ref, outcome) {
      const handle = executionHandle(ref);
      const committed = handle?.store.settleExecution(ref, outcome) ?? false;
      if (committed && !outcome.retainBinding) forgetExecutionStore(ref);
      if (committed && handle?.store === store && handle.generation === storeGeneration) {
        widget.setActiveTask(ref.taskId, false);
        if (outcome.status === "completed") autoClear.trackCompletion(ref.taskId, cadence.currentTurn);
        else autoClear.resetBatchCountdown();
        widget.update();
      }
      return committed;
    },
    taskList: {
      // `store` is captured as a binding, so every call lands on the store that
      // is active at that moment — including after a session/workspace switch
      // replaced it under initializeStoreForContext.
      list: () => store.list(),
      create(input) {
        const task = store.create(input.subject, input.description, input.activeForm, input.metadata);
        widget.update();
        return task;
      },
      update(id, fields) {
        const existing = store.get(id);
        if (!existing || existing.execution !== undefined) return false;
        const result = store.update(id, fields);
        if (result.task !== undefined && result.changedFields.length > 0) widget.update();
        return result.task !== undefined;
      },
      delete(id) {
        const deleted = store.delete(id);
        if (deleted) widget.update();
        return deleted;
      },
    },
  } satisfies TasksRegistration;
}

export default registerTasks;
