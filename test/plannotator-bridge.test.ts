import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PLANNOTATOR_PLAN_APPROVED_CHANNEL,
  parsePlanChecklist,
  reconcilePlanTasks,
  registerPlannotatorBridge,
  resolvePlannotatorExecutionMode,
} from "../src/plannotator-bridge.js";
import type { TaskListHandle } from "../src/tasks/index.js";
import { TaskStore } from "../src/tasks/task-store.js";
import { mockCtx, mockPi } from "./tasks/helpers/mock-pi.js";

/** TaskListHandle backed by a real in-memory TaskStore. */
function handleFromStore(store: TaskStore): TaskListHandle {
  return {
    list: () => store.list(),
    create: (input) => store.create(input.subject, input.description, input.activeForm, input.metadata),
    update: (id, fields) => store.update(id, fields).task !== undefined,
    delete: (id) => store.delete(id),
  };
}

describe("parsePlanChecklist", () => {
  it("parses standard checkboxes with 1-based ordinals", () => {
    const items = parsePlanChecklist("# Plan\n\n- [ ] First step\n- [x] Second step\n* [X] Third step\n");
    expect(items).toEqual([
      { step: 1, text: "First step", completed: false },
      { step: 2, text: "Second step", completed: true },
      { step: 3, text: "Third step", completed: true },
    ]);
  });

  it("skips whitespace-only checkboxes without consuming an ordinal", () => {
    const items = parsePlanChecklist("- [ ] Real step\n- [ ]\n- [ ] Next step\n");
    expect(items.map((i) => [i.step, i.text])).toEqual([
      [1, "Real step"],
      [2, "Next step"],
    ]);
  });

  it("ignores non-checkbox list items and prose", () => {
    expect(parsePlanChecklist("- plain bullet\n1. numbered\n[x] no dash\n")).toEqual([]);
  });
});

describe("reconcilePlanTasks", () => {
  let store: TaskStore;
  let handle: TaskListHandle;

  beforeEach(() => {
    store = new TaskStore();
    handle = handleFromStore(store);
  });

  const items = (...texts: string[]) => texts.map((text, i) => ({ step: i + 1, text, completed: false }));

  it("creates one pending task per step with mirror metadata", () => {
    const result = reconcilePlanTasks(items("Alpha", "Beta"), "plan.md", handle);
    expect(result).toEqual({ created: 2, updated: 0, removed: 0, completed: 0, kept: 0 });
    const tasks = store.list();
    expect(tasks.map((t) => [t.subject, t.status])).toEqual([
      ["Alpha", "pending"],
      ["Beta", "pending"],
    ]);
    expect(tasks[0].metadata.plannotator).toEqual({ planId: "plan.md", step: 1 });
    expect(tasks[1].metadata.plannotator).toEqual({ planId: "plan.md", step: 2 });
  });

  it("is idempotent — re-syncing the same plan creates nothing", () => {
    reconcilePlanTasks(items("Alpha", "Beta"), "plan.md", handle);
    const result = reconcilePlanTasks(items("Alpha", "Beta"), "plan.md", handle);
    expect(result).toEqual({ created: 0, updated: 0, removed: 0, completed: 0, kept: 2 });
    expect(store.list()).toHaveLength(2);
  });

  it("retitles changed steps and removes steps no longer in the plan", () => {
    reconcilePlanTasks(items("Alpha", "Beta", "Gamma"), "plan.md", handle);
    const result = reconcilePlanTasks(items("Alpha", "Beta v2"), "plan.md", handle);
    expect(result).toEqual({ created: 0, updated: 1, removed: 1, completed: 0, kept: 2 });
    expect(store.list().map((t) => t.subject)).toEqual(["Alpha", "Beta v2"]);
  });

  it("scopes reconciliation to the planId — other plans and manual tasks are untouched", () => {
    store.create("Manual task", "Not from a plan");
    reconcilePlanTasks(items("Alpha"), "a.md", handle);
    reconcilePlanTasks(items("One", "Two"), "b.md", handle);
    reconcilePlanTasks(items(), "a.md", handle);
    expect(store.list().map((t) => t.subject)).toEqual(["Manual task", "One", "Two"]);
  });

  it("never retitles or removes a task bound to an executor", () => {
    reconcilePlanTasks(items("Alpha", "Beta"), "plan.md", handle);
    const bound = store.list()[0];
    store.claimPending(bound.id, { kind: "agent", attemptId: "att-1", taskAttemptId: "tatt-1" });

    const result = reconcilePlanTasks(items("Renamed"), "plan.md", handle);
    expect(result).toEqual({ created: 0, updated: 0, removed: 1, completed: 0, kept: 1 });
    const tasks = store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe("Alpha");
    expect(tasks[0].execution).toBeDefined();
  });

  it("keeps completed tasks as recorded even when the plan retitles the step", () => {
    reconcilePlanTasks(items("Alpha"), "plan.md", handle);
    const task = store.list()[0];
    store.update(task.id, { status: "completed" });
    const result = reconcilePlanTasks(items("Alpha renamed"), "plan.md", handle);
    expect(result.updated).toBe(0);
    expect(store.list()[0].subject).toBe("Alpha");
  });

  it("marks the mirror complete when the plan checks the step off", () => {
    reconcilePlanTasks(items("Alpha", "Beta"), "plan.md", handle);
    const result = reconcilePlanTasks(
      [{ step: 1, text: "Alpha", completed: true }, { step: 2, text: "Beta", completed: false }],
      "plan.md",
      handle,
    );
    expect(result).toEqual({ created: 0, updated: 0, removed: 0, completed: 1, kept: 2 });
    expect(store.list().map((t) => [t.subject, t.status])).toEqual([
      ["Alpha", "completed"],
      ["Beta", "pending"],
    ]);
  });

  it("creates nothing for a step the plan already shows finished", () => {
    const result = reconcilePlanTasks([{ step: 1, text: "Done already", completed: true }], "plan.md", handle);
    expect(result).toEqual({ created: 0, updated: 0, removed: 0, completed: 0, kept: 0 });
    expect(store.list()).toHaveLength(0);
  });

  it("never completes a task bound to an executor from the plan", () => {
    reconcilePlanTasks(items("Alpha"), "plan.md", handle);
    const bound = store.list()[0];
    store.claimPending(bound.id, { kind: "agent", attemptId: "att-1", taskAttemptId: "tatt-1" });

    const result = reconcilePlanTasks([{ step: 1, text: "Alpha", completed: true }], "plan.md", handle);
    expect(result.completed).toBe(0);
    expect(store.list()[0].status).toBe("in_progress");
  });
});

describe("resolvePlannotatorExecutionMode", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "plannotator-mode-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("defaults to automatic when no config exists", () => {
    expect(resolvePlannotatorExecutionMode(root, join(root, "ws"))).toBe("automatic");
  });

  it("reads the global config, then lets the project config win", () => {
    writeFileSync(join(root, "plannotator.json"), JSON.stringify({ executionMode: "external" }));
    const ws = join(root, "ws");
    mkdirSync(join(ws, ".pi"), { recursive: true });
    expect(resolvePlannotatorExecutionMode(root, ws)).toBe("external");

    writeFileSync(join(ws, ".pi", "plannotator.json"), JSON.stringify({ executionMode: "automatic" }));
    expect(resolvePlannotatorExecutionMode(root, ws)).toBe("automatic");
  });

  it("treats a project-level null as an explicit reset to automatic", () => {
    writeFileSync(join(root, "plannotator.json"), JSON.stringify({ executionMode: "external" }));
    const ws = join(root, "ws");
    mkdirSync(join(ws, ".pi"), { recursive: true });
    writeFileSync(join(ws, ".pi", "plannotator.json"), JSON.stringify({ executionMode: null }));
    expect(resolvePlannotatorExecutionMode(root, ws)).toBe("automatic");
  });
});

describe("registerPlannotatorBridge", () => {
  let store: TaskStore;
  let root: string;

  beforeEach(() => {
    store = new TaskStore();
    root = mkdtempSync(join(tmpdir(), "plannotator-bridge-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function approvedEvent(planContent: string) {
    return { cwd: root, planFilePath: join(root, "plan.md"), planContent };
  }

  it("mirrors an approved plan's remaining checklist items into tasks", async () => {
    const harness = mockPi();
    registerPlannotatorBridge(harness.pi as any, { taskList: handleFromStore(store), agentDir: root });
    const ctx = mockCtx(root);
    await harness.fireLifecycle("turn_start", {}, ctx);

    harness.emitEvent(PLANNOTATOR_PLAN_APPROVED_CHANNEL, approvedEvent("- [ ] Build it\n- [x] Already done\n- [ ] Test it\n"));

    const tasks = store.list();
    expect(tasks.map((t) => [t.subject, t.metadata.plannotator])).toEqual([
      ["Build it", { planId: "plan.md", step: 1 }],
      ["Test it", { planId: "plan.md", step: 3 }],
    ]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("1 already checked off"), "info");
  });

  it("reconciles on re-approval instead of duplicating", async () => {
    const harness = mockPi();
    registerPlannotatorBridge(harness.pi as any, { taskList: handleFromStore(store), agentDir: root });
    await harness.fireLifecycle("turn_start", {}, mockCtx(root));

    harness.emitEvent(PLANNOTATOR_PLAN_APPROVED_CHANNEL, approvedEvent("- [ ] Build it\n- [ ] Test it\n"));
    harness.emitEvent(PLANNOTATOR_PLAN_APPROVED_CHANNEL, approvedEvent("- [ ] Build it\n- [ ] Test it v2\n"));

    expect(store.list().map((t) => t.subject)).toEqual(["Build it", "Test it v2"]);
  });

  it("warns instead of mirroring when the plan has no checklist items", async () => {
    const harness = mockPi();
    registerPlannotatorBridge(harness.pi as any, { taskList: handleFromStore(store), agentDir: root });
    const ctx = mockCtx(root);
    await harness.fireLifecycle("turn_start", {}, ctx);

    harness.emitEvent(PLANNOTATOR_PLAN_APPROVED_CHANNEL, approvedEvent("# Plan without checkboxes\n"));

    expect(store.list()).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no checklist items"), "warning");
  });

  it("ignores malformed events", async () => {
    const harness = mockPi();
    registerPlannotatorBridge(harness.pi as any, { taskList: handleFromStore(store), agentDir: root });
    harness.emitEvent(PLANNOTATOR_PLAN_APPROVED_CHANNEL, { planFilePath: 42 });
    harness.emitEvent(PLANNOTATOR_PLAN_APPROVED_CHANNEL, null);
    expect(store.list()).toHaveLength(0);
  });

  describe("execution-mode warning", () => {
    /** Simulate a loaded plannotator answering the liveness probe. */
    function installPlannotatorResponder(pi: ReturnType<typeof mockPi>["pi"], answer = true) {
      if (!answer) return;
      pi.events.on("plannotator:request", (request: any) => {
        request.respond({ status: "handled", result: undefined });
      });
    }

    it("warns on session start when plannotator is live but not in external mode", async () => {
      const harness = mockPi();
      installPlannotatorResponder(harness.pi);
      registerPlannotatorBridge(harness.pi as any, {
        taskList: handleFromStore(store),
        agentDir: root,
        probeTimeoutMs: 50,
      });
      const ctx = mockCtx(root);
      await harness.fireLifecycle("session_start", {}, ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('"automatic" execution mode'), "warning");
    });

    it("stays silent when plannotator is in external mode", async () => {
      writeFileSync(join(root, "plannotator.json"), JSON.stringify({ executionMode: "external" }));
      const harness = mockPi();
      installPlannotatorResponder(harness.pi);
      registerPlannotatorBridge(harness.pi as any, {
        taskList: handleFromStore(store),
        agentDir: root,
        probeTimeoutMs: 50,
      });
      const ctx = mockCtx(root);
      await harness.fireLifecycle("session_start", {}, ctx);

      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it("stays silent when no plannotator answers the probe", async () => {
      const harness = mockPi();
      registerPlannotatorBridge(harness.pi as any, {
        taskList: handleFromStore(store),
        agentDir: root,
        probeTimeoutMs: 50,
      });
      const ctx = mockCtx(root);
      await harness.fireLifecycle("session_start", {}, ctx);

      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it("probes only once per process", async () => {
      const harness = mockPi();
      installPlannotatorResponder(harness.pi);
      registerPlannotatorBridge(harness.pi as any, {
        taskList: handleFromStore(store),
        agentDir: root,
        probeTimeoutMs: 50,
      });
      const first = mockCtx(root);
      const second = mockCtx(root);
      await harness.fireLifecycle("session_start", {}, first);
      await harness.fireLifecycle("session_start", {}, second);

      expect(first.ui.notify).toHaveBeenCalledTimes(1);
      expect(second.ui.notify).not.toHaveBeenCalled();
    });
  });
});
