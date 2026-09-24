/**
 * plannotator-bridge.ts — Receives approved plans from @plannotator/pi-extension
 * and mirrors their checklists into the structured task list.
 *
 * Plannotator hands a plan off for external execution by emitting
 * "plannotator:plan-approved" ({ cwd, planFilePath, planContent, feedback? })
 * and returning to idle in the same transition, so its own progress widget is
 * already gone when this bridge runs and the task widget is the single live
 * view of the plan. The handoff only happens when plannotator's executionMode
 * is "external"; in the default "automatic" mode plannotator executes the plan
 * itself, keeping its own progress widget and its own todo backend, and the
 * event never fires. On session start this bridge probes for a live plannotator
 * over its own request channel and warns once if it is not in external mode,
 * because that is the one failure mode that is otherwise invisible from this
 * side.
 *
 * Sync is one-way (plan -> tasks) and idempotent, mirroring plannotator's own
 * TodoProvider contract: re-reading an edited plan reconciles by step ordinal
 * instead of duplicating tasks. A step the plan shows checked marks its mirror
 * completed, a step that disappears drops its pending mirror, and finished
 * work stays the plan file's record rather than becoming a new task. Tasks
 * bound to an executor are never retitled, removed, or completed from under it;
 * completion is never written back into the plan file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TaskListHandle } from "./tasks/index.js";
import type { Task } from "./tasks/types.js";

/** Emitted by plannotator when an approved plan is handed off (external mode). */
export const PLANNOTATOR_PLAN_APPROVED_CHANNEL = "plannotator:plan-approved";

/** Plannotator's own cross-extension request channel; used only as a liveness probe. */
const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";

/** Bogus review id for the probe — "review-status" is a harmless read either way. */
const MODE_PROBE_REVIEW_ID = "pi-subagents:mode-probe";

const DEFAULT_PROBE_TIMEOUT_MS = 1500;

export interface PlannotatorPlanApprovedEvent {
  cwd?: string;
  planFilePath?: string;
  planContent?: string;
  feedback?: string;
}

export interface PlanChecklistItem {
  /** 1-based ordinal among non-empty checkbox lines, matching plannotator's parseChecklist. */
  step: number;
  text: string;
  completed: boolean;
}

/**
 * Parse standard markdown checkboxes from plan content.
 *
 * The pattern is copied from plannotator's generated/checklist.ts (upstream
 * does not export it as an API): `[^\S\n]` keeps a match from crossing a line
 * boundary, and whitespace-only checkbox lines are skipped so they never
 * consume an ordinal. Drift risk is accepted deliberately — a mismatch parses
 * fewer items, never wrong ones.
 */
const CHECKLIST_PATTERN = /^[-*][^\S\n]*\[([ xX])\][^\S\n]+(.+)$/gm;

export function parsePlanChecklist(content: string): PlanChecklistItem[] {
  const items: PlanChecklistItem[] = [];
  for (const match of content.matchAll(CHECKLIST_PATTERN)) {
    const text = match[2].trim();
    if (text.length > 0) {
      items.push({ step: items.length + 1, text, completed: match[1] !== " " });
    }
  }
  return items;
}

/** Runtime-owned mirror identity. Stored under the `plannotator` metadata key. */
interface PlannotatorTaskMetadata {
  planId: string;
  step: number;
}

function plannotatorMetadata(task: Task): PlannotatorTaskMetadata | undefined {
  const value: unknown = task.metadata.plannotator;
  if (typeof value !== "object" || value === null) return undefined;
  const { planId, step } = value as Record<string, unknown>;
  if (typeof planId !== "string" || typeof step !== "number") return undefined;
  return { planId, step };
}

function stepDescription(item: PlanChecklistItem, planId: string): string {
  return `${item.text}\n\n— Plannotator plan "${planId}", step ${item.step}`;
}

export interface PlanReconcileResult {
  created: number;
  updated: number;
  removed: number;
  /** Mirrors the plan reported complete on this pass. */
  completed: number;
  kept: number;
}

/**
 * Make the task list match `items` for `planId`, checked steps included.
 * Idempotent: repeated calls with the same items converge instead of
 * duplicating. A step the plan now shows checked marks its mirror completed;
 * steps absent from `items` lose their mirror only while pending and unbound —
 * a step being executed, or one the user already completed, is left exactly as
 * it is.
 */
export function reconcilePlanTasks(
  items: PlanChecklistItem[],
  planId: string,
  taskList: TaskListHandle,
): PlanReconcileResult {
  const byStep = new Map<number, Task>();
  for (const task of taskList.list()) {
    const meta = plannotatorMetadata(task);
    if (meta?.planId === planId && !byStep.has(meta.step)) byStep.set(meta.step, task);
  }

  const result: PlanReconcileResult = { created: 0, updated: 0, removed: 0, completed: 0, kept: 0 };
  for (const item of items) {
    const existing = byStep.get(item.step);
    byStep.delete(item.step);
    if (!existing) {
      // Finished work needs no mirror: the plan file is its record.
      if (item.completed) continue;
      taskList.create({
        subject: item.text,
        description: stepDescription(item, planId),
        metadata: { plannotator: { planId, step: item.step } satisfies PlannotatorTaskMetadata },
      });
      result.created++;
      continue;
    }
    result.kept++;
    // A task being executed is mid-attempt; its subject and status belong to
    // the executor's claim, not to the plan.
    if (existing.execution !== undefined) continue;
    if (item.completed) {
      if (existing.status !== "completed" && taskList.update(existing.id, { status: "completed" })) {
        result.completed++;
      }
      continue;
    }
    // Completion recorded on the task stays: the plan is not the authority on
    // work someone already finished locally.
    if (existing.status === "completed") continue;
    if (existing.subject !== item.text) {
      if (taskList.update(existing.id, { subject: item.text, description: stepDescription(item, planId) })) {
        result.updated++;
      }
    }
  }

  for (const leftover of byStep.values()) {
    if (leftover.status === "pending" && leftover.execution === undefined && taskList.delete(leftover.id)) {
      result.removed++;
    }
  }
  return result;
}

type PlannotatorExecutionMode = "automatic" | "external";

/** Read the raw executionMode of one plannotator.json. `null` is meaningful
 *  upstream (an explicit reset that overrides the inherited value). */
function readExecutionModeFile(path: string): PlannotatorExecutionMode | null | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const mode = (raw as Record<string, unknown>).executionMode;
    if (mode === null || mode === "automatic" || mode === "external") return mode;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Effective executionMode the way plannotator resolves it: project overrides
 * global per key, default "automatic". Upstream additionally gates the project
 * file on workspace trust, which this side cannot see — a distrusted project
 * override can therefore make this resolve stricter than plannotator's actual
 * mode, which only ever suppresses the warning, never raises a false one.
 */
export function resolvePlannotatorExecutionMode(agentDir: string, cwd: string): PlannotatorExecutionMode {
  const globalMode = readExecutionModeFile(join(agentDir, "plannotator.json"));
  const projectMode = readExecutionModeFile(join(cwd, ".pi", "plannotator.json"));
  const effective = projectMode !== undefined ? projectMode : globalMode;
  return effective ?? "automatic";
}

export interface PlannotatorBridgeOptions {
  taskList: TaskListHandle;
  /** Defaults to getAgentDir(); injectable for tests. */
  agentDir?: string;
  /** Defaults to 1500ms; injectable for tests. */
  probeTimeoutMs?: number;
}

export function registerPlannotatorBridge(pi: ExtensionAPI, options: PlannotatorBridgeOptions): void {
  let latestCtx: ExtensionContext | undefined;

  function report(planId: string, result: PlanReconcileResult, extra: string[] = []): void {
    const parts = [`${result.created} created`, `${result.updated} updated`, `${result.removed} removed`];
    if (result.completed > 0) parts.push(`${result.completed} completed`);
    parts.push(...extra);
    latestCtx?.ui.notify(`Plannotator plan "${planId}" mirrored to the task list: ${parts.join(", ")}.`, "info");
  }

  pi.on("turn_start", async (_event, ctx) => {
    latestCtx = ctx;
  });

  pi.events.on(PLANNOTATOR_PLAN_APPROVED_CHANNEL, (data: unknown) => {
    const event = data as PlannotatorPlanApprovedEvent | null;
    if (!event || typeof event.planContent !== "string" || typeof event.planFilePath !== "string") return;
    // planId mirrors plannotator's own derivation: the plan path relative to
    // the workspace it was approved in, falling back to the raw path.
    const cwd = typeof event.cwd === "string" ? event.cwd : latestCtx?.cwd;
    const planId = cwd
      ? relative(cwd, resolve(cwd, event.planFilePath)) || event.planFilePath
      : event.planFilePath;

    const items = parsePlanChecklist(event.planContent);
    const result = reconcilePlanTasks(items, planId, options.taskList);

    if (items.length === 0) {
      latestCtx?.ui.notify(
        `Plannotator plan "${planId}" has no checklist items; nothing was mirrored to the task list.`,
        "warning",
      );
      return;
    }
    const skipped = items.filter((item) => item.completed).length - result.completed;
    report(planId, result, skipped > 0 ? [`${skipped} already checked off`] : []);
  });

  // Warn once per process when a live plannotator would never hand plans off.
  // In "automatic" mode plannotator executes approved plans itself (showing
  // its own todo widget) and plan-approved never fires, so this warning is
  // the only surface for that misconfiguration.
  let modeChecked = false;
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    if (modeChecked) return;
    modeChecked = true;
    const present = await probePlannotator(pi, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    if (!present) return;
    const mode = resolvePlannotatorExecutionMode(options.agentDir ?? getAgentDir(), ctx.cwd);
    if (mode !== "external") {
      ctx.ui.notify(
        `Plannotator is in "${mode}" execution mode: approved plans are executed by plannotator itself and never reach pi-subagents. Set "executionMode": "external" in plannotator.json to hand plans off to the task list.`,
        "warning",
      );
    }
  });
}

/**
 * Liveness probe over plannotator's request channel. "review-status" is a
 * read-only action; any response — including an error envelope — proves a
 * plannotator extension is loaded in this process. No response within the
 * timeout means the channel has no listener.
 */
function probePlannotator(pi: ExtensionAPI, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (present: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(present);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    try {
      pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
        action: "review-status",
        payload: { reviewId: MODE_PROBE_REVIEW_ID },
        respond: () => settle(true),
      });
    } catch {
      settle(false);
    }
  });
}
