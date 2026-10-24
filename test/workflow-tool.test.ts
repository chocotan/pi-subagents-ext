import { TEST_AGENTS } from "./helpers/agents.js";
/**
 * workflow-tool.test.ts — the seams that bind the workflow engine to the rest of
 * the extension.
 *
 * The engine itself is covered by workflow-runtime/-progress/-meta/-render; what
 * is untested until here is everything *around* it: the adapter that turns a
 * `WorkflowSpawnRequest` into a real `AgentManager` spawn, the `SubagentWorkflow` tool's
 * input contract, and the CLI flag's ordering — read from `session_start`, never
 * at activation, because the host applies flag values only after every extension
 * has already loaded.
 *
 * The host tests drive a stub manager rather than the real one. That is not to
 * avoid work: `spawnAndWait` needs a model, a session and a repo, and none of
 * those are what these assertions are about — the mapping is.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { SUBAGENT_TOOL_NAMES } from "../src/agent-runner.js";
import { registerAgents, setDefaultAgent } from "../src/agent-types.js";
import subagentsExtension, { WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG } from "../src/index.js";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "../src/model-scope.js";
import { getOutputTranscriptDefault, sessionTaskDir, setOutputTranscriptDefault } from "../src/output-file.js";
import type { AgentRecord } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import type { WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

/** A settled record, in the shape `toSpawnResult` reads. */
function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    type: "Worker",
    description: "a child",
    status: "completed",
    result: "the answer",
    toolUses: 0,
    startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  } as AgentRecord;
}

interface StubManager {
  manager: AgentManager;
  spawnAndWait: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}

/** A manager that spawns nothing; `settle` decides what each spawn produces. */
function stubManager(
  settle: (type: string, prompt: string, options: any) => Promise<AgentRecord> | AgentRecord = () => record(),
): StubManager {
  const abort = vi.fn();
  const resume = vi.fn(async () => record({ id: "agent-1", result: "resumed" }));
  const spawnAndWait = vi.fn(
    async (_pi: any, _ctx: any, type: string, prompt: string, options: any, onSpawned?: (id: string) => void) => {
      const settled = await settle(type, prompt, options);
      onSpawned?.(settled.id);
      return { id: settled.id, record: settled };
    },
  );
  return { manager: { spawnAndWait, abort, resume } as unknown as AgentManager, spawnAndWait, abort, resume };
}

const request = (overrides: Partial<WorkflowSpawnRequest> = {}): WorkflowSpawnRequest => ({
  agentId: "wf-agent-0",
  index: 0,
  prompt: "do the thing",
  label: "step",
  agentType: "Worker",
  ...overrides,
});

const execResult = (overrides: Partial<{ stdout: string; stderr: string; code: number; killed: boolean }> = {}) => ({
  stdout: "",
  stderr: "",
  code: 0,
  killed: false,
  ...overrides,
});

function callField(call: unknown, index: number): unknown {
  return Array.isArray(call) ? call[index] : undefined;
}

function objectField(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function callMessageField(call: unknown, key: string): unknown {
  return objectField(callField(call, 0), key);
}

/* ------------------------------------------------------------------------- *
 * The host adapter
 * ------------------------------------------------------------------------- */

describe("createWorkflowHost — spawn mapping", () => {
  beforeEach(() => {
    // The host resolves agent types through the process-wide registry, the same
    // one the Agent tool uses. Seed it with the shipped defaults.
    registerAgents(TEST_AGENTS);
  });

  it("spawns through the manager and maps attempt identity, configuration and usage", async () => {
    const stub = stubManager(() =>
      record({
        id: "record-1",
        artifactId: "artifact-1",
        sourceAttemptId: "source-1",
        result: "the answer",
        turnCount: 2,
        toolUses: 3,
        lifetimeUsage: { input: 100, output: 20, cacheWrite: 5, cacheRead: 4, cost: 0.25 },
        invocation: {
          modelName: "Sonnet 4.6",
          modelId: "anthropic/claude-sonnet-4-6",
          thinking: "high",
        } as AgentRecord["invocation"],
      }),
    );
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ label: "review:bugs" }));

    expect(result).toMatchObject({
      ok: true,
      text: "the answer",
      recordId: "record-1",
      artifactId: "artifact-1",
      sourceAttemptId: "source-1",
      model: "Sonnet 4.6",
      modelId: "anthropic/claude-sonnet-4-6",
      thinking: "high",
      tokens: 125,
      toolCalls: 3,
      usage: {
        turns: 2,
        toolCalls: 3,
        tokens: { input: 100, output: 20, cacheWrite: 5, cacheRead: 4, cost: 0.25 },
      },
    });
    // `tokens` is this physical invocation's total (100 + 20 + 5), while
    // `outputTokens` feeds the script's `budget.spent()` and must be output
    // alone. Billing a fan-out's re-sent input would swamp it.
    expect(result.outputTokens).toBe(20);
    const [, , type, prompt, options] = stub.spawnAndWait.mock.calls[0];
    expect(type).toBe("Worker");
    expect(prompt).toBe("do the thing");
    // The label is the child's display description, so the fleet list and the
    // workflow tree name the same agent the same way.
    expect(options.description).toBe("review:bugs");
  });

  it("passes isolation and the run's abort signal down to the spawn", async () => {
    const stub = stubManager();
    const controller = new AbortController();
    const host = createWorkflowHost({
      pi: {} as any,
      ctx: ctx(),
      manager: stub.manager,
      signal: controller.signal,
      rootSessionId: "root-1",
    });

    await host.spawnAgent(request({ isolation: "worktree", sourceAttemptId: "artifact-parent" }));

    const options = stub.spawnAndWait.mock.calls[0][4];
    expect(options.isolation).toBe("worktree");
    expect(options.sourceAttemptId).toBe("artifact-parent");
    expect(options.signal).toBe(controller.signal);
    expect(options.rootSessionId).toBe("root-1");
  });

  it("routes an unknown agent type through the same dispatch the Agent tool uses", async () => {
    // A configured default never substitutes for an explicit unknown type.
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    setDefaultAgent("Worker");
    const failed = await host.spawnAgent(request({ agentType: "no-such-agent" }));
    expect(failed.ok).toBe(false);
    expect(stub.spawnAndWait).not.toHaveBeenCalled();

    // …and fails closed here too when the project configured strict dispatch.
    try {
      const strict = stubManager();
      const strictHost = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: strict.manager });
      const rejected = await strictHost.spawnAgent(request({ agentType: "no-such-agent" }));
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toMatch(/no-such-agent/);
      expect(strict.spawnAndWait).not.toHaveBeenCalled();
    } finally {
      setDefaultAgent(undefined);
    }
  });

  it("rejects a model the script named and cannot be resolved", async () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ model: "not-a-model" }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Model not found/);
    expect(stub.spawnAndWait).not.toHaveBeenCalled();
  });

  it("resolves a model the script named through the session's registry", async () => {
    const stub = stubManager();
    const model = { id: "claude-haiku-4-5", name: "Haiku", provider: "anthropic" };
    const host = createWorkflowHost({
      pi: {} as any,
      ctx: ctx({
        modelRegistry: {
          find: vi.fn(() => model),
          getAvailable: vi.fn(() => [model]),
        },
      }),
      manager: stub.manager,
    });

    await host.spawnAgent(request({ model: "haiku" }));

    expect(stub.spawnAndWait.mock.calls[0][4].model).toBe(model);
  });

  it("stamps its children with the run id and keeps them out of the pool", async () => {
    // Ownership, not decoration: the stamp is what removes a workflow's agents
    // from the fleet list, the widget and the `/agents` menus, and what keeps
    // one fan-out from filling the session's concurrency pool.
    const stub = stubManager();
    const host = createWorkflowHost({
      pi: {} as any,
      ctx: ctx(),
      manager: stub.manager,
      workflowId: "wf_run1",
    });

    await host.spawnAgent(request({}));

    // The stamp alone: `AgentManager` reads it to keep the child out of the
    // pool (covered in agent-manager.test.ts), so no second opt-out is passed.
    const options = stub.spawnAndWait.mock.calls[0][4];
    expect(options.workflowId).toBe("wf_run1");
    expect(options.bypassQueue).toBeUndefined();
  });

  it("returns the agent text result", async () => {
    const stub = stubManager(() => record({ result: "here you go" }));
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({}));

    expect(result).toMatchObject({ ok: true, text: "here you go" });
  });

  it("leaves the stamp off when no run id was injected", async () => {
    // The runtime tests drive the host without one; an undefined stamp must not
    // become the string "undefined" and quietly group unrelated agents.
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({}));

    expect(stub.spawnAndWait.mock.calls[0][4].workflowId).toBeUndefined();
  });

  it("maps opts.effort onto the spawn's thinking level", async () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({ effort: "high" }));

    expect(stub.spawnAndWait.mock.calls[0][4].thinkingLevel).toBe("high");
  });

  it("leaves thinkingLevel unset when no effort was asked for", async () => {
    // The agent definition's `thinking` resolves it downstream; sending
    // `undefined` explicitly would be the same, but sending a default would not.
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({}));

    expect(stub.spawnAndWait.mock.calls[0][4].thinkingLevel).toBeUndefined();
  });

  it("surfaces a strict worktree-isolation failure as a failed agent, not a rejection", async () => {
    const stub = stubManager(() => {
      throw new Error('Cannot run with isolation: "worktree" — not a git repo');
    });
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    // `await` rather than `rejects`: a startup failure must land in the script
    // as a null, so the rest of a fan-out keeps going.
    const result = await host.spawnAgent(request({ isolation: "worktree" }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/isolation: "worktree"/);
  });

  it("maps an errored record onto an error, and a stopped one onto skipped", async () => {
    const failing = stubManager(() => record({ status: "error", error: "boom" }));
    const stopped = stubManager(() => record({ status: "stopped" }));

    const failed = await createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: failing.manager })
      .spawnAgent(request());
    const skipped = await createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stopped.manager })
      .spawnAgent(request());

    expect(failed).toMatchObject({ ok: false, error: "boom" });
    expect(failed.skipped).toBeUndefined();
    expect(skipped).toMatchObject({ ok: false, skipped: true });
  });
});

/* ------------------------------------------------------------------------- *
 * scopeModels on the workflow spawn path
 * ------------------------------------------------------------------------- */

/**
 * A workflow script is written by the model, so `agent({ model })` is a runtime
 * LLM choice — exactly what `scopeModels` guards. These pin the split the policy
 * turns on: what the SCRIPT named is refused, what the user authored (an agent
 * file's `model:`, the parent's own model) warns and proceeds.
 */
describe("createWorkflowHost — scopeModels", () => {
  const ALLOWED = { id: "allowed-model", name: "Allowed", provider: "anthropic" };
  const BLOCKED = { id: "blocked-model", name: "Blocked", provider: "anthropic" };
  const MODELS = [ALLOWED, BLOCKED];
  const modelRegistry = {
    find: (provider: string, id: string) => MODELS.find(m => m.provider === provider && m.id === id) ?? null,
    getAll: () => MODELS,
    getAvailable: () => MODELS,
  };

  let projectDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;
  let prevEnabled: boolean;
  let notify: ReturnType<typeof vi.fn>;

  /** A session ctx whose cwd is where the allowlist was written. */
  const scopedCtx = (overrides: Record<string, unknown> = {}) =>
    ctx({
      cwd: projectDir,
      modelRegistry,
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify, addAutocompleteProvider: vi.fn() },
      ...overrides,
    });

  beforeEach(() => {
    // `resolveEnabledModels` memoizes on the patterns plus the mtime/size of
    // both settings files, so one case's allowlist would otherwise be served to
    // the next — a fresh project dir per test is what invalidates it. Same
    // harness as test/cross-extension-rpc.test.ts.
    projectDir = mkdtempSync(join(tmpdir(), "wf-scope-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "wf-scope-global-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    prevEnabled = isScopeModelsEnabled();
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ enabledModels: ["anthropic/allowed-model"] }),
    );
    notify = vi.fn();
    // "pinned" stands in for a user-authored agent file with `model:` in its
    // frontmatter; the defaults come along, so "Worker" still resolves.
    registerAgents(new Map([...TEST_AGENTS, ["pinned", {
      name: "pinned",
      displayName: "Pinned",
      description: "an agent whose file pins a model",
      extensions: false,
      skills: false,
      model: "anthropic/blocked-model",
      systemPrompt: "pinned",
      promptMode: "replace",
    } as any]]));
  });

  afterEach(() => {
    setScopeModelsEnabled(prevEnabled); // module-global — restore for other suites
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    registerAgents(TEST_AGENTS);
  });

  it("refuses a model the script named that is out of scope, and fails only that agent", async () => {
    setScopeModelsEnabled(true);
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: scopedCtx(), manager: stub.manager });

    const blocked = await host.spawnAgent(request({ model: "anthropic/blocked-model" }));

    // `{ok: false}` rather than a throw: the runtime turns this into `null` for
    // the script, so one refused model does not take the run's siblings down.
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/Model not in scope/);
    expect(blocked.error).toContain("  anthropic/allowed-model");
    expect(stub.spawnAndWait).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    const inScope = await host.spawnAgent(request({ model: "anthropic/allowed-model" }));
    expect(inScope.ok).toBe(true);
    expect(stub.spawnAndWait.mock.calls[0][4].model).toBe(ALLOWED);
  });

  it("warns but still spawns when the agent file pinned the out-of-scope model", async () => {
    // User-authored config, not a choice the script made — the model folds into
    // `modelInput`, so keying `callerSupplied` off it would wrongly hard-error.
    setScopeModelsEnabled(true);
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: scopedCtx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ agentType: "pinned" }));

    expect(result.ok).toBe(true);
    expect(stub.spawnAndWait).toHaveBeenCalledTimes(1);
    expect(stub.spawnAndWait.mock.calls[0][4].model).toBe(BLOCKED);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("out-of-scope model"), "warning");
  });

  it("warns but still spawns on an inherited parent model", async () => {
    setScopeModelsEnabled(true);
    const stub = stubManager();
    const host = createWorkflowHost({
      pi: {} as any,
      ctx: scopedCtx({ model: BLOCKED }),
      manager: stub.manager,
    });

    const result = await host.spawnAgent(request());

    expect(result.ok).toBe(true);
    expect(stub.spawnAndWait.mock.calls[0][4].model).toBe(BLOCKED);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("anthropic/blocked-model"),
      "warning",
    );
  });

  it("toasts a repeated warning once, not once per child of a fan-out", async () => {
    setScopeModelsEnabled(true);
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: scopedCtx(), manager: stub.manager });

    for (let i = 0; i < 3; i++) {
      const spawned = await host.spawnAgent(request({ agentId: `wf-agent-${i}`, agentType: "pinned" }));
      expect(spawned.ok).toBe(true);
    }

    expect(stub.spawnAndWait).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("leaves every spawn alone when scopeModels is off — the default", async () => {
    setScopeModelsEnabled(false);
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: scopedCtx(), manager: stub.manager });

    const named = await host.spawnAgent(request({ model: "anthropic/blocked-model" }));
    const pinnedAgent = await host.spawnAgent(request({ agentId: "wf-agent-1", agentType: "pinned" }));

    expect(named.ok).toBe(true);
    expect(pinnedAgent.ok).toBe(true);
    expect(stub.spawnAndWait).toHaveBeenCalledTimes(2);
    expect(stub.spawnAndWait.mock.calls[0][4].model).toBe(BLOCKED);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("createWorkflowHost — worktree cwd propagation", () => {
  let worktree: string;

  beforeEach(() => {
    registerAgents(TEST_AGENTS);
    worktree = mkdtempSync(join(tmpdir(), "wf-worktree-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it("reports the directory the child ran in, so a gate verifies that tree", async () => {
    const stub = stubManager(() =>
      record({ worktree: { path: worktree, branch: "b", baseSha: "sha", workPath: worktree } }),
    );
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ isolation: "worktree" }));

    expect(result.cwd).toBe(worktree);
  });

  it("reports no cwd once the worktree has been torn down", async () => {
    // The manager commits the child's changes to a branch and REMOVES the copy
    // before spawnAndWait resolves. Handing that path to a gate would fail every
    // gated worktree agent with a spawn error instead of a test result.
    const gone = join(worktree, "already-removed");
    expect(existsSync(gone)).toBe(false);
    const stub = stubManager(() =>
      record({ worktree: { path: gone, branch: "b", baseSha: "sha", workPath: gone } }),
    );
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ isolation: "worktree" }));

    expect(result.cwd).toBeUndefined();
  });

  it("reports no cwd for a child that never had a worktree", async () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    expect((await host.spawnAgent(request())).cwd).toBeUndefined();
  });
});

describe("createWorkflowHost — abort, resume and gate", () => {
  beforeEach(() => {
    registerAgents(TEST_AGENTS);
  });

  it("aborts the manager record the runtime's agent id stands for", async () => {
    const stub = stubManager(() => record({ id: "manager-id-7" }));
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({ agentId: "wf-agent-3" }));
    host.abortAgent("wf-agent-3");

    expect(stub.abort).toHaveBeenCalledWith("manager-id-7");
  });

  it("does not abort anything for an agent that never started", () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    host.abortAgent("wf-agent-0");

    expect(stub.abort).not.toHaveBeenCalled();
  });

  it("resumes the same manager record, long after that agent settled", async () => {
    const stub = stubManager(() => record({ id: "manager-id-7" }));
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({ agentId: "wf-agent-0" }));
    const resumed = await host.resumeAgent?.("wf-agent-0", "and now this");

    expect(stub.resume).toHaveBeenCalledWith("manager-id-7", "and now this", undefined, {
      cwd: process.cwd(),
      modelRegistry: expect.anything(),
      onTurnEnd: undefined,
      onToolActivity: undefined,
      onTextDelta: undefined,
    });
    expect(resumed).toMatchObject({ ok: true, text: "resumed" });
  });

  it("subtracts a non-zero resume baseline and preserves attempt lineage", async () => {
    const stub = stubManager(() => record({
      id: "manager-id-7",
      artifactId: "artifact-1",
      turnCount: 4,
      toolUses: 5,
      lifetimeUsage: { input: 100, output: 40, cacheWrite: 10, cacheRead: 8, cost: 0.5 },
    }));
    stub.resume.mockResolvedValue(record({
      id: "manager-id-7",
      artifactId: "artifact-2",
      sourceAttemptId: "artifact-1",
      result: "resumed",
      turnCount: 2,
      toolUses: 8,
      lifetimeUsage: { input: 130, output: 52, cacheWrite: 14, cacheRead: 11, cost: 0.65 },
    }));
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({ agentId: "wf-agent-0" }));
    const resumed = await host.resumeAgent?.("wf-agent-0", "continue");

    expect(resumed).toMatchObject({
      ok: true,
      recordId: "manager-id-7",
      artifactId: "artifact-2",
      sourceAttemptId: "artifact-1",
      tokens: 46,
      outputTokens: 12,
      toolCalls: 3,
      turnCount: 2,
      usage: {
        turns: 2,
        toolCalls: 3,
        tokens: { input: 30, output: 12, cacheWrite: 4, cacheRead: 3 },
      },
    });
    expect(resumed?.usage?.tokens.cost).toBeCloseTo(0.15);
  });

  it("bridges live resume callbacks before settlement", async () => {
    const stub = stubManager(() => record({ id: "manager-id-8", session: { dispose: vi.fn() } as never }));
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    stub.resume.mockImplementation(async (_id: string, _prompt: string, _signal: unknown, options: any) => {
      options.onToolActivity?.({ type: "start", toolName: "read" });
      options.onTextDelta?.("partial", "partial response");
      options.onTurnEnd?.(1);
      await held;
      return record({ id: "manager-id-8", result: "resumed", session: { dispose: vi.fn() } as never });
    });
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });
    await host.spawnAgent(request({ agentId: "wf-agent-0" }));

    const resumedPromise = host.resumeAgent?.(
      "wf-agent-0",
      "continue",
      info => { if (info.recordId) order.push("resolved"); },
      () => order.push("session"),
      count => order.push(`turn:${count}`),
      activity => order.push(`tool:${activity.toolName}`),
      (_delta, full) => order.push(`text:${full}`),
    );
    await vi.waitFor(() => expect(order).toEqual([
      "resolved",
      "session",
      "tool:read",
      "text:partial response",
      "turn:1",
    ]));
    release();
    await resumedPromise;
  });

  it("refuses to resume an agent the run never spawned", async () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const resumed = await host.resumeAgent?.("wf-agent-9", "continue");

    expect(resumed?.ok).toBe(false);
    expect(stub.resume).not.toHaveBeenCalled();
  });

  it("asks the manager for a pre-cleanup hook only when the agent is gated", async () => {
    // The hook is how a gate reaches the child's worktree before it is deleted
    // (see workflow-gate-worktree.test.ts). An ungated agent must not acquire
    // one: nothing would run in it, and the manager's settle path is shared
    // with every other spawn.
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({ isolation: "worktree" }));
    expect(stub.spawnAndWait.mock.calls[0][4].onBeforeWorktreeCleanup).toBeUndefined();

    await host.spawnAgent(request({ isolation: "worktree", gate: "npm test" }));
    expect(stub.spawnAndWait.mock.calls[1][4].onBeforeWorktreeCleanup).toBeInstanceOf(Function);
  });

  it("runs a gate through pi.exec in the child's own tree", async () => {
    const exec = vi.fn(async () => execResult({ stdout: "3 passing" }));
    const host = createWorkflowHost({
      pi: { exec } as any,
      ctx: ctx({ cwd: "/session" }),
      manager: stubManager().manager,
    });

    const gate = await host.runGate?.("npm test", { agentId: "wf-agent-0", cwd: "/worktree" });

    expect(gate).toEqual({ ok: true, output: "3 passing" });
    expect(exec.mock.calls[0][2]).toMatchObject({ cwd: "/worktree" });
  });

  it("falls back to the session's cwd when the child had no tree of its own", async () => {
    const exec = vi.fn(async () => execResult());
    const host = createWorkflowHost({
      pi: { exec } as any,
      ctx: ctx({ cwd: "/session" }),
      manager: stubManager().manager,
    });

    await host.runGate?.("npm test", { agentId: "wf-agent-0" });

    expect(exec.mock.calls[0][2]).toMatchObject({ cwd: "/session" });
  });

  it("fails a gate on a non-zero exit and surfaces its output", async () => {
    const exec = vi.fn(async () => execResult({ code: 1, stderr: "1 failing" }));
    const host = createWorkflowHost({ pi: { exec } as any, ctx: ctx(), manager: stubManager().manager });

    expect(await host.runGate?.("npm test", { agentId: "wf-agent-0" })).toEqual({ ok: false, output: "1 failing" });
  });

  it("fails a gate that was killed, which pi.exec reports with exit code 0", async () => {
    const exec = vi.fn(async () => execResult({ killed: true, code: 0 }));
    const host = createWorkflowHost({ pi: { exec } as any, ctx: ctx(), manager: stubManager().manager });

    const gate = await host.runGate?.("sleep 999", { agentId: "wf-agent-0" });

    expect(gate?.ok).toBe(false);
    expect(gate?.output).toMatch(/timed out/);
  });
});

/* ------------------------------------------------------------------------- *
 * Tool registration
 * ------------------------------------------------------------------------- */

describe("Workflow tool registration", () => {
  it("excludes every registered workflow feature from subagents", () => {
    // The exclusion list is derived from this object; a workflow tool missing
    // here is a workflow tool every spawned child inherits.
    expect(Object.values(SUBAGENT_TOOL_NAMES)).toContain("SubagentWorkflow");
    expect(Object.values(SUBAGENT_TOOL_NAMES)).toContain("WorkflowPlaybook");
    expect(Object.values(SUBAGENT_TOOL_NAMES)).toContain("WorkflowPlaybookSave");
    expect(Object.values(SUBAGENT_TOOL_NAMES)).not.toContain("WorkflowPlan");
    expect(SUBAGENT_TOOL_NAMES).not.toHaveProperty("PLAN");
    expect(SUBAGENT_TOOL_NAMES.WORKFLOW).toBe("SubagentWorkflow");
  });
});

/* ------------------------------------------------------------------------- *
 * The tool's input contract
 * ------------------------------------------------------------------------- */

const inlineScript = 'export const meta = { name: "from-inline", description: "inline source" };\n';
const fileScript = 'export const meta = { name: "from-file", description: "file source" };\n';

/** Plain theme, so a rendered component can be asserted as text. */
const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

describe("SubagentWorkflow tool — script vs scriptPath vs name", () => {
  let hermetic: Hermetic;
  let booted: ReturnType<typeof makePi>;
  let tools: Map<string, any>;
  let workflowConfirm: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Hermetic dir first — settings and agent files are read at boot.
    hermetic = hermeticDir({ testAgents: true, settings: { schedulingEnabled: false, workflowsEnabled: true } });
    booted = makePi();
    subagentsExtension(booted.pi);
    tools = booted.tools;
    workflowConfirm = vi.fn(async () => true);
  });

  afterEach(async () => {
    // Let any detached run settle before the temp dir disappears under it.
    await flush();
    hermetic.restore();
    vi.restoreAllMocks();
  });

  const workflowCtx = () => {
    const context = ctx({ cwd: hermetic.dir });
    return {
      ...context,
      hasUI: true,
      ui: { ...context.ui, confirm: workflowConfirm },
    };
  };

  const headlessCtx = () => {
    const context = ctx({ cwd: hermetic.dir });
    return {
      ...context,
      hasUI: false,
      ui: { ...context.ui, confirm: workflowConfirm },
    };
  };

  it("exposes only direct workflow sources and no Plan entry renderer", () => {
    expect(JSON.stringify(tools.get("SubagentWorkflow").parameters)).not.toContain("planRef");
    expect(tools.has("WorkflowPlan")).toBe(false);
    expect(booted.entryRenderers.has("workflow-plan")).toBe(false);
  });

  it("routes every direct UI source through confirmation and labels the selected source", async () => {
    const path = join(hermetic.dir, "direct.js");
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(path, fileScript);
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "saved.js"), fileScript);
    workflowConfirm.mockResolvedValue(false);

    const cases = [
      { id: "inline", params: { script: inlineScript }, source: "Source: inline script" },
      { id: "path", params: { scriptPath: path }, source: `Source: script path: ${path}` },
      { id: "name", params: { name: "saved" }, source: "Source: saved workflow: saved" },
    ];
    for (const testCase of cases) {
      workflowConfirm.mockClear();
      const result = await tools.get("SubagentWorkflow").execute(
        `tc-ui-${testCase.id}`,
        testCase.params,
        undefined,
        undefined,
        workflowCtx(),
      );
      expect(textOf(result)).toContain("not approved");
      expect(workflowConfirm).toHaveBeenCalledWith("Run workflow?", expect.stringContaining(testCase.source));
      const approval = workflowConfirm.mock.calls[0]?.[1] ?? "";
      const approvalMarker = "Approval summary\n";
      const approvalIndex = approval.indexOf(approvalMarker);
      expect(approval).toMatch(/^Technical details\n/);
      expect(approval.slice(0, approvalIndex)).toContain("Omitted capabilities:\n- not declared by a direct script\n");
      expect(approval.indexOf(approvalMarker)).toBe(approval.lastIndexOf(approvalMarker));
      expect(approval.slice(approvalIndex)).toContain("Flow\n");
    }
  });

  it("rejects an oversized direct approval before confirmation", async () => {
    const calls = Array.from({ length: 180 }, (_, index) =>
      `agent(${JSON.stringify(`Inspect ${"x".repeat(120)}`)}, { label: ${JSON.stringify(`agent-${index}`)} });`
    ).join("\n");
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-ui-oversized",
      { script: `${inlineScript}${calls}` },
      undefined,
      undefined,
      workflowCtx(),
    );

    expect(textOf(result)).toContain("behavior summary exceeds 48000 characters");
    expect(workflowConfirm).not.toHaveBeenCalled();
  });

  it("allows every direct source headlessly without inspecting user prose or risk keywords", async () => {
    const path = join(hermetic.dir, "direct.js");
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(path, fileScript);
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "prod.js"), fileScript);

    const results = await Promise.all([
      tools.get("SubagentWorkflow").execute(
        "tc-headless-inline",
        { script: `${inlineScript}// Deploy production` },
        undefined,
        undefined,
        headlessCtx(),
      ),
      tools.get("SubagentWorkflow").execute(
        "tc-headless-path",
        { scriptPath: path },
        undefined,
        undefined,
        headlessCtx(),
      ),
      tools.get("SubagentWorkflow").execute(
        "tc-headless-name",
        { name: "prod" },
        undefined,
        undefined,
        headlessCtx(),
      ),
    ]);

    for (const result of results) expect(textOf(result)).toContain("started in the background");
    expect(workflowConfirm).not.toHaveBeenCalled();
  });

  it("skips approval-completeness preflight for trusted headless direct scripts", async () => {
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-headless-indirection",
      { script: `${inlineScript}const launch = agent; return typeof launch;` },
      undefined,
      undefined,
      headlessCtx(),
    );

    expect(textOf(result)).toContain("started in the background");
    expect(workflowConfirm).not.toHaveBeenCalled();
  });

  it("rejects unsupported injected-global indirection before direct UI approval", async () => {
    const cases = [
      ["alias", "const launch = agent; return launch('inspect');"],
      ["call", "return agent.call(null, 'inspect');"],
      ["sequence", "return (0, agent)('inspect');"],
      ["globalThis.agent", "return globalThis.agent('inspect');"],
      ["globalThis computed agent", "return globalThis['agent']('inspect');"],
      ["Reflect.get agent", "return Reflect.get(globalThis, 'agent')('inspect');"],
      ["this.agent", "return this.agent('inspect');"],
      ["local-shadow", "function agent() { return 'local'; } return agent();"],
    ] as const;

    for (const [label, body] of cases) {
      workflowConfirm.mockClear();
      const result = await tools.get("SubagentWorkflow").execute(
        `tc-indirect-${label}`,
        { script: `${inlineScript}${body}` },
        undefined,
        undefined,
        workflowCtx(),
      );
      expect(textOf(result)).toContain("unsupported indirection");
      expect(textOf(result)).toContain("direct calls");
      expect(textOf(result)).not.toContain("started in the background");
      expect(workflowConfirm).not.toHaveBeenCalled();
    }
  });

  it("rejects an aliased nested workflow call in a saved workflow before approval", async () => {
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      join(hermetic.dir, ".pi", "workflows", "aliased-parent.js"),
      `${fileScript}const nested = workflow; return nested('child');`,
    );

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-saved-workflow-alias",
      { name: "aliased-parent" },
      undefined,
      undefined,
      workflowCtx(),
    );

    expect(textOf(result)).toContain("cannot be approved from a top-level preview");
    expect(textOf(result)).not.toContain("started in the background");
    expect(workflowConfirm).not.toHaveBeenCalled();
  });

  it.each([
    ["spread options", "agent('inspect', { ...hidden, gate: 'npm test' });"],
    ["dynamic gate", "agent('inspect', { gate: command });"],
    ["argument spread", "agent(...args);"],
    ["computed key", "agent('inspect', { [optionName]: 'worktree' });"],
    ["literal prototype property", "agent('inspect', { __proto__: { gate: 'npm test' } });"],
  ])("rejects agent behavior hidden by %s before direct UI approval", async (_label, body) => {
    workflowConfirm.mockClear();
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-unresolved-options",
      { script: `${inlineScript}${body}` },
      undefined,
      undefined,
      workflowCtx(),
    );

    expect(textOf(result)).toContain("cannot faithfully preview agent options");
    expect(textOf(result)).not.toContain("started in the background");
    expect(workflowConfirm).not.toHaveBeenCalled();
  });

  it("detects nested workflow behavior through executable references and fails closed on parse errors", async () => {
    const mentions = [
      inlineScript,
      '// workflow("comment")',
      'const ordinary = "workflow(\\\'string\\\')";',
      "const template = `workflow(\\\"template\\\")`;",
      "const property = { workflow: true };",
      "return ordinary + template + property.workflow;",
    ].join("\n");
    const allowed = await tools.get("SubagentWorkflow").execute(
      "tc-nested-mentions",
      { script: mentions },
      undefined,
      undefined,
      headlessCtx(),
    );
    expect(textOf(allowed)).toContain("started in the background");

    const bypasses = [
      'return await workflow?.("child");',
      'return await workflow.call(null, "child");',
      'return await workflow.apply(null, ["child"]);',
      'return await (0, workflow)("child");',
      'const nested = workflow; return await nested("child");',
      'const refs = [workflow]; return await refs[0]("child");',
      'return await globalThis.workflow("child");',
      'return await this.workflow("child");',
      "const broken = ;",
    ];
    for (const [index, body] of bypasses.entries()) {
      const result = await tools.get("SubagentWorkflow").execute(
        `tc-nested-bypass-${index}`,
        { script: `${inlineScript}${body}` },
        undefined,
        undefined,
        headlessCtx(),
      );
      expect(textOf(result)).toContain("nested workflow() behavior are not supported");
      expect(textOf(result)).not.toContain("started in the background");
    }
  });

  it("rejects direct schema calls before confirmation", async () => {
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-schema-preflight",
      {
        script: `${inlineScript}return await agent("inspect", { schema: { type: "object" } });`,
      },
      undefined,
      undefined,
      workflowCtx(),
    );

    expect(textOf(result)).toContain(
      "agent() opts.schema is no longer supported; workflow children return text/Markdown.",
    );
    expect(workflowConfirm).not.toHaveBeenCalled();
  });

  it("summarizes actual prompts, options, phases, and relationships", async () => {
    workflowConfirm.mockResolvedValue(false);
    const script = [
      'export const meta = { name: "parent", description: "review orchestration", phases: [{ title: "Discover" }, { title: "Verify" }] };',
      'phase("Discover");',
      'await parallel([',
      '  () => agent("Deploy the auth diff", { label: "auth scan", agentType: "Explorer", model: "haiku", effort: "high" }),',
      '  () => agent("Inspect the tests", { label: "test scan", isolation: "worktree" }),',
      ']);',
      'await pipeline(["finding"], item => agent("Verify " + item, { label: "verify finding", phase: "Verify" }));',
      'return "done";',
    ].join("\n");
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "parent.js"), script);
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-approval-summary",
      { name: "parent" },
      undefined,
      undefined,
      workflowCtx(),
    );

    expect(textOf(result)).toContain("not approved");
    const approval = String(workflowConfirm.mock.calls[0]?.[1]);
    expect(approval).toContain("Deploy the auth diff");
    expect(approval).toContain("agentType: Explorer");
    expect(approval).toContain("model: haiku");
    expect(approval).toContain("effort: high");
    expect(approval).toContain("phase: Discover");
    expect(approval).toContain("parallel barrier");
    expect(approval).toContain("pipeline stage");
    expect(approval).toContain("verify finding");
    expect(approval).toContain("Discover -> Verify");
  });

  it("rejects nested behavior in a named interactive workflow before approval", async () => {
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      join(hermetic.dir, ".pi", "workflows", "nested-parent.js"),
      `${fileScript}return await workflow("payload");`,
    );

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-named-nested-approval",
      { name: "nested-parent" },
      undefined,
      undefined,
      workflowCtx(),
    );

    expect(textOf(result)).toContain("cannot be approved from a top-level preview");
    expect(textOf(result)).toContain("saved named parents");
    expect(workflowConfirm).not.toHaveBeenCalled();
    expect(textOf(result)).not.toContain("Task ID:");
  });

  it("requires direct approval for every interactive script", async () => {
    workflowConfirm.mockResolvedValue(false);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-unplanned-denied",
      { script: `${inlineScript}// \u202ehidden`, args: { target: "src\rhidden" } },
      undefined,
      undefined,
      workflowCtx(),
    );

    expect(textOf(result)).toContain("not approved");
    expect(workflowConfirm).toHaveBeenCalledWith(
      "Run workflow?",
      expect.stringContaining("Agent call sites:"),
    );
    const approval = String(workflowConfirm.mock.calls[0]?.[1]);
    expect(approval).toContain('Parameters:\n{\n  "target": "src\\rhidden"\n}');
    expect(approval).not.toContain("export const meta");
    expect(approval).not.toContain("\u202e");
    expect(textOf(result)).not.toContain("Task ID:");
  });

  it("rejects legacy planRef before source resolution, confirmation, or execution", async () => {
    const context = workflowCtx();
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-legacy-plan-ref",
      {
        planRef: "wfp_0123456789abcdef01234567",
        scriptPath: join(hermetic.dir, "missing.js"),
        resumeFromRunId: "wf_missing",
        args: { hostile: "\u001b[2J" },
      },
      undefined,
      undefined,
      context,
    );

    expect(textOf(result)).toContain("`planRef` is no longer supported");
    expect(textOf(result)).toContain("No run was started");
    expect(textOf(result)).not.toContain("Task ID:");
    expect(workflowConfirm).not.toHaveBeenCalled();
    expect(context.sessionManager.getSessionId).not.toHaveBeenCalled();
    expect(booted.pi.appendEntry).not.toHaveBeenCalled();
    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("runs the inline script when only `script` is given, and persists it", async () => {
    const result = await tools.get("SubagentWorkflow").execute("tc-1", { script: inlineScript }, undefined, undefined, workflowCtx());

    const text = textOf(result);
    expect(text).toMatch(/Workflow "from-inline" started/);
    const scriptLine = text.split("\n").find((line: string) => line.startsWith("Script: "));
    expect(scriptLine, "the persisted script path is what makes iteration edit-then-rerun").toBeTruthy();
    expect(existsSync(scriptLine!.slice("Script: ".length))).toBe(true);
  });

  it.each([
    { label: "script and scriptPath", params: { script: inlineScript, scriptPath: "wf.js" } },
    { label: "script and name", params: { script: inlineScript, name: "saved" } },
    { label: "scriptPath and name", params: { scriptPath: "wf.js", name: "saved" } },
    { label: "all direct sources", params: { script: inlineScript, scriptPath: "wf.js", name: "saved" } },
  ])("rejects $label instead of choosing a precedence winner", async ({ params }) => {
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-source-conflict",
      params,
      undefined,
      undefined,
      workflowCtx(),
    );

    expect(textOf(result)).toContain("Provide only one workflow source");
    expect(textOf(result)).not.toContain("started");
    expect(workflowConfirm).not.toHaveBeenCalled();
  });

  it("resolves a relative scriptPath against the project directory", async () => {
    mkdirSync(join(hermetic.dir, "flows"), { recursive: true });
    writeFileSync(join(hermetic.dir, "flows", "wf.js"), fileScript);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-3",
      { scriptPath: join("flows", "wf.js") },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/Workflow "from-file" started/);
  });

  it("reports a missing scriptPath when it is the selected source", async () => {
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-4",
      { scriptPath: join(hermetic.dir, "nope.js") },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/Could not read workflow script/);
    expect(textOf(result)).not.toMatch(/started/);
  });

  it("asks for one of the three when none is given", async () => {
    const result = await tools.get("SubagentWorkflow").execute("tc-5", {}, undefined, undefined, workflowCtx());

    expect(textOf(result)).toMatch(/Provide `script`.*`scriptPath`.*or `name`/s);
  });

  it("runs a saved workflow by name from .pi/workflows", async () => {
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "nightly.js"), fileScript);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-name-1",
      { name: "nightly" },
      undefined, undefined, workflowCtx(),
    );

    const text = textOf(result);
    expect(text).toMatch(/Workflow "from-file" started/);
    // Reported as its own file, so editing and re-running works on a saved one.
    expect(text).toContain(join(".pi", "workflows", "nightly.js"));
  });



  it("names the saved workflows it does have when the name is unknown", async () => {
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "nightly.js"), fileScript);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-name-3",
      { name: "nightlyy" },
      undefined, undefined, workflowCtx(),
    );

    const text = textOf(result);
    expect(text).toMatch(/No saved workflow named "nightlyy"/);
    expect(text).toMatch(/Available: nightly\./);
    expect(text).not.toMatch(/started/);
  });

  it("falls back to the user's agent dir, and lets the project shadow it", async () => {
    const globalDir = join(process.env.PI_CODING_AGENT_DIR!, "workflows");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "shared.js"), fileScript);

    const fromGlobal = await tools.get("SubagentWorkflow").execute(
      "tc-name-6",
      { name: "shared" },
      undefined, undefined, workflowCtx(),
    );
    expect(textOf(fromGlobal)).toMatch(/Workflow "from-file" started/);

    // Same name in the project wins — .pi stays the project authority.
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "shared.js"), inlineScript);

    const fromProject = await tools.get("SubagentWorkflow").execute(
      "tc-name-7",
      { name: "shared" },
      undefined, undefined, workflowCtx(),
    );
    expect(textOf(fromProject)).toMatch(/Workflow "from-inline" started/);
  });

  it("refuses a file in the folder that is not a workflow", async () => {
    // These are ordinary directories — a build artifact or a scratch script can
    // sit next to the workflows, and naming one must not run it.
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "utils.js"), "module.exports = { helper: 1 };\n");

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-shape-1",
      { name: "utils" },
      undefined, undefined, workflowCtx(),
    );

    const text = textOf(result);
    expect(text).toMatch(/is not a workflow script/);
    expect(text).toMatch(/Nothing was run/);
    expect(text).not.toMatch(/started/);
  });

  it("leaves non-workflow files out of the listing entirely", async () => {
    // Offering `utils.js` as a runnable workflow is what invites trying it.
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "utils.js"), "const x = 1;\n");
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "nightly.js"), fileScript);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-shape-2",
      { name: "nope" },
      undefined, undefined, workflowCtx(),
    );

    const text = textOf(result);
    expect(text).toMatch(/Available: nightly\./);
    expect(text).not.toMatch(/utils/);
  });

  it("does not shadow a real workflow with a same-named non-workflow deeper down", async () => {
    // The project file wins the lookup, so the report is about the file that
    // was actually found — reaching past it to a lower root would run a
    // different script than the one the name resolves to.
    const globalDir = join(process.env.PI_CODING_AGENT_DIR!, "workflows");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "shared.js"), fileScript);
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "shared.js"), "// not a workflow\n");

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-shape-3",
      { name: "shared" },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/is not a workflow script/);
    expect(textOf(result)).not.toMatch(/started/);
  });

  it("refuses to read a name out of its directories", async () => {
    writeFileSync(join(hermetic.dir, "escaped.js"), fileScript);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-name-4",
      { name: "../escaped" },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/is not a usable workflow name/);
    expect(textOf(result)).not.toMatch(/started/);
  });

  it("refuses a run id this session never issued", async () => {
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-resume-1",
      { script: inlineScript, resumeFromRunId: "wf_deadbeef1234" },
      undefined, undefined, workflowCtx(),
    );

    // An unknown id is an error, not a cold start: a caller that asked to
    // resume is expecting not to pay, and silently paying hides that.
    expect(textOf(result)).toMatch(/No workflow run "wf_deadbeef1234" in this session/);
    expect(textOf(result)).not.toMatch(/started/);
  });

  it("refuses to resume a run that is still going", async () => {
    const started = await tools.get("SubagentWorkflow").execute(
      "tc-resume-2",
      { script: inlineScript },
      undefined, undefined, workflowCtx(),
    );
    const runId = (started.details as { taskId: string }).taskId;

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-resume-3",
      { script: inlineScript, resumeFromRunId: runId },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/is still running/);
  });

  it("accepts a settled run and says plainly that there was nothing to replay", async () => {
    const started = await tools.get("SubagentWorkflow").execute(
      "tc-resume-4",
      { script: inlineScript },
      undefined, undefined, workflowCtx(),
    );
    const runId = (started.details as { taskId: string }).taskId;
    workflowConfirm.mockClear();

    // The run is detached: it has to actually settle before it can be resumed,
    // and the worker thread takes a moment to start, compile and finish.
    let result: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      await flush();
      result = await tools.get("SubagentWorkflow").execute(
        `tc-resume-5-${attempt}`,
        { resumeFromRunId: runId },
        undefined, undefined, workflowCtx(),
      );
      if (!/is still running/.test(textOf(result))) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    // That script spawns no agents, so its journal is empty. Saying so beats
    // reporting a resume that silently replayed nothing.
    expect(textOf(result)).toMatch(new RegExp(`Nothing to replay from ${runId}`));
    expect(textOf(result)).toMatch(/started in the background/);
    expect(workflowConfirm).toHaveBeenCalledWith(
      "Run workflow?",
      expect.stringContaining("Source: resumed script path:"),
    );
  });

  it("allows an exact resume headlessly without confirmation", async () => {
    const started = await tools.get("SubagentWorkflow").execute(
      "tc-headless-resume-start",
      { script: inlineScript },
      undefined,
      undefined,
      headlessCtx(),
    );
    const runId = (started.details as { taskId: string }).taskId;
    workflowConfirm.mockClear();

    let result: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      await flush();
      result = await tools.get("SubagentWorkflow").execute(
        `tc-headless-resume-${attempt}`,
        { resumeFromRunId: runId },
        undefined,
        undefined,
        headlessCtx(),
      );
      if (!/is still running/.test(textOf(result))) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    expect(textOf(result)).toContain("started in the background");
    expect(workflowConfirm).not.toHaveBeenCalled();
  });

  it("rejects resume ids issued by another session", async () => {
    const started = await tools.get("SubagentWorkflow").execute(
      "tc-cross-session-start",
      { script: inlineScript },
      undefined,
      undefined,
      workflowCtx(),
    );
    const runId = (started.details as { taskId: string }).taskId;
    let settled = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      await flush();
      const probe = await tools.get("SubagentWorkflow").execute(
        `tc-cross-session-probe-${attempt}`,
        { script: inlineScript, resumeFromRunId: runId },
        undefined,
        undefined,
        workflowCtx(),
      );
      if (!/is still running/.test(textOf(probe))) {
        settled = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(settled).toBe(true);
    const nextSession = workflowCtx();
    nextSession.sessionManager.getSessionId = vi.fn(() => "s2");

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-cross-session-resume",
      { script: inlineScript, resumeFromRunId: runId },
      undefined,
      undefined,
      nextSession,
    );

    expect(textOf(result)).toContain("belongs to a different session");
    expect(textOf(result)).not.toContain("started in the background");
  });

  it("ignores title and description rather than rejecting them", async () => {
    // Claude Code accepts both and ignores them; a schema rejection here would
    // cost a turn to re-emit a script that was already correct.
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-name-5",
      { script: inlineScript, title: "Nightly Audit", description: "does the thing" },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/Workflow "from-inline" started/);
  });

  it("reports a bad `meta` up front rather than as a background run that failed", async () => {
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-6",
      { script: "const x = 1;\n" },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/must begin with .export const meta/);
    expect(textOf(result)).not.toMatch(/started/);
  });

  it("names the workflow on the call line", () => {
    const line = tools.get("SubagentWorkflow").renderCall({ script: inlineScript }, plainTheme, { isPartial: false }).text ?? "";
    expect(String(line)).toContain("SubagentWorkflow");
    expect(String(line)).toContain("from-inline");
  });

  it("actually runs the script in the background and notifies through the agent channel", async () => {
    const script = `${inlineScript}log("scanned 3 files");\nreturn "done here";\n`;
    const result = await tools.get("SubagentWorkflow").execute("tc-run", { script }, undefined, undefined, workflowCtx());
    const taskId = /Task ID: (\S+)/.exec(textOf(result))?.[1];
    expect(taskId).toBeTruthy();

    // The tool returned before the run finished — the completion has to arrive
    // on its own, through the same channel a background agent uses.
    await vi.waitFor(
      () =>
        expect(
          booted.pi.sendMessage.mock.calls.some((c: any[]) => String(c[0]?.content).includes(taskId!)),
        ).toBe(true),
      { timeout: 10_000 },
    );

    const sent = booted.pi.sendMessage.mock.calls.find((c: any[]) => String(c[0]?.content).includes(taskId!))!;
    expect(sent[0].customType).toBe("subagent-notification");
    expect(sent[1]).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
    expect(String(sent[0].content)).toContain("<result>done here</result>");

    // …and the inline card follows the background run rather than freezing at
    // whatever `execute` returned.
    const card = String(
      tools.get("SubagentWorkflow")
        .renderResult(result, { expanded: false, isPartial: false }, plainTheme, { isError: false })
        .text ?? "",
    );
    expect(card).toContain("from-inline");
    expect(card).toContain("scanned 3 files");
    expect(card).toContain("done");
  });

  it("omits a private tool-started workflow result from its notification", async () => {
    const previous = getOutputTranscriptDefault();
    setOutputTranscriptDefault(false);
    try {
      const privateResult = "private tool workflow result";
      const result = await tools.get("SubagentWorkflow").execute(
        "tc-private-tool-notification",
        { script: `${inlineScript}return ${JSON.stringify(privateResult)};` },
        undefined,
        undefined,
        headlessCtx(),
      );
      const taskId = startedTaskId(result);
      const sent = await awaitNotification(taskId);
      const content = String(sent[0].content);

      expect(content).not.toContain(privateResult);
      expect(content).toContain("<status>Done</status>");
      expect(content).toContain("<coverage>logical=0/0 physical=0/0 failed=0 pending=0 status=unknown</coverage>");
      expect(content).toContain("<artifact>unavailable</artifact>");
      expect(content).toContain("<result>Output persistence disabled.</result>");
      expect(sent[0].details.resultPreview).toBe("Output persistence disabled.");
      expect(sent[0].details.error).toBeUndefined();
    } finally {
      setOutputTranscriptDefault(previous);
    }
  });

  it("holds a workflow completion while the parent is active and flushes it after agent_settled", async () => {
    let idle = false;
    const context = workflowCtx();
    context.isIdle = vi.fn(() => idle);
    context.ui.onTerminalInput = vi.fn(() => vi.fn());
    await booted.lifecycle.get("session_start")?.({}, context);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-active-parent",
      { script: `${inlineScript}return "held until settled";` },
      undefined,
      undefined,
      context,
    );
    const taskId = startedTaskId(result);

    await vi.waitFor(() => {
      const card = String(
        tools.get("SubagentWorkflow")
          .renderResult(result, { expanded: false, isPartial: false }, plainTheme, { isError: false })
          .text ?? "",
      );
      expect(card).toContain("done");
    }, { timeout: 4_000, interval: 5 });
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(booted.pi.sendMessage.mock.calls.filter(
      call => notificationIncludesTaskId(call, taskId),
    )).toHaveLength(0);

    idle = true;
    await booted.lifecycle.get("agent_settled")?.({}, context);
    await booted.lifecycle.get("agent_settled")?.({}, context);
    const sent = await awaitNotification(taskId);
    expect(booted.pi.sendMessage.mock.calls.filter(
      call => notificationIncludesTaskId(call, taskId),
    )).toHaveLength(1);
    expect(String(sent[0].content)).toContain("<result>held until settled</result>");
  });

  it("re-checks idle after the notification hold and retries on a later settle", async () => {
    let idle = true;
    const context = workflowCtx();
    context.isIdle = vi.fn(() => idle);
    context.ui.onTerminalInput = vi.fn(() => vi.fn());
    await booted.lifecycle.get("session_start")?.({}, context);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-idle-race",
      { script: `${inlineScript}return "race result";` },
      undefined,
      undefined,
      context,
    );
    const taskId = startedTaskId(result);

    await vi.waitFor(() => {
      const card = String(
        tools.get("SubagentWorkflow")
          .renderResult(result, { expanded: false, isPartial: false }, plainTheme, { isError: false })
          .text ?? "",
      );
      expect(card).toContain("done");
    }, { timeout: 4_000, interval: 5 });
    idle = false;
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(booted.pi.sendMessage.mock.calls.filter(
      call => notificationIncludesTaskId(call, taskId),
    )).toHaveLength(0);

    idle = true;
    await booted.lifecycle.get("agent_settled")?.({}, context);
    await booted.lifecycle.get("agent_settled")?.({}, context);
    const sent = await awaitNotification(taskId);
    expect(booted.pi.sendMessage.mock.calls.filter(
      call => notificationIncludesTaskId(call, taskId),
    )).toHaveLength(1);
    expect(String(sent[0].content)).toContain("<result>race result</result>");
  });

  it("lets TaskOutput join and consume a held workflow completion", async () => {
    const context = workflowCtx();
    context.isIdle = vi.fn(() => false);
    context.ui.onTerminalInput = vi.fn(() => vi.fn());
    await booted.lifecycle.get("session_start")?.({}, context);

    const started = await tools.get("SubagentWorkflow").execute(
      "tc-task-output-consume",
      { script: `${inlineScript}return "joined workflow result";` },
      undefined,
      undefined,
      context,
    );
    const taskId = startedTaskId(started);
    const firstOutput = await tools.get("TaskOutput").execute(
      "tc-task-output-join",
      { task_id: taskId, block: true, timeout: 5000 },
      undefined,
      undefined,
      context,
    );
    const secondOutput = await tools.get("TaskOutput").execute(
      "tc-task-output-settled-read",
      { task_id: taskId, block: true, timeout: 5000 },
      undefined,
      undefined,
      context,
    );

    for (const output of [firstOutput, secondOutput]) {
      expect(textOf(output)).toContain(`Workflow ${taskId} [completed]`);
      expect(textOf(output)).toContain("joined workflow result");
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(booted.pi.sendMessage.mock.calls.some(
      call => notificationIncludesTaskId(call, taskId),
    )).toBe(false);
  });

  it("invalidates a blocking workflow TaskOutput when the session changes", async () => {
    const context = workflowCtx();
    context.isIdle = vi.fn(() => false);
    context.ui.onTerminalInput = vi.fn(() => vi.fn());
    await booted.lifecycle.get("session_start")?.({}, context);

    const started = await tools.get("SubagentWorkflow").execute(
      "tc-task-output-switch",
      { script: `${inlineScript}await new Promise(() => {});` },
      undefined,
      undefined,
      context,
    );
    const taskId = startedTaskId(started);
    const waiting = tools.get("TaskOutput").execute(
      "tc-task-output-switch-wait",
      { task_id: taskId, block: true, timeout: 5000 },
      undefined,
      undefined,
      context,
    );
    void waiting.catch(() => {});
    await flush();

    await booted.lifecycle.get("session_before_switch")?.({}, context);

    await expect(waiting).rejects.toThrow("Workflow context changed while waiting for output");
    await expect(tools.get("TaskOutput").execute(
      "tc-task-output-after-switch",
      { task_id: taskId, block: false },
      undefined,
      undefined,
      context,
    )).rejects.toThrow(`No workflow run with ID ${taskId}`);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(booted.pi.sendMessage.mock.calls.some(
      call => notificationIncludesTaskId(call, taskId),
    )).toBe(false);
  });

  function notificationIncludesTaskId(call: unknown, taskId: string): boolean {
    if (!Array.isArray(call)) return false;
    const message: unknown = call[0];
    return message !== null && typeof message === "object" && "content" in message
      && String(message.content).includes(taskId);
  }

  /** Wait for the completion notification a background run sends for `taskId`. */
  async function awaitNotification(taskId: string) {
    await vi.waitFor(
      () =>
        expect(
          booted.pi.sendMessage.mock.calls.some((c: any[]) => String(c[0]?.content).includes(taskId)),
        ).toBe(true),
      { timeout: 10_000 },
    );
    return booted.pi.sendMessage.mock.calls.find((c: any[]) => String(c[0]?.content).includes(taskId))!;
  }

  const startedTaskId = (result: unknown) => /Task ID: (\S+)/.exec(textOf(result))![1];

  it("cancels a tool-started completion nudge after switching sessions", async () => {
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-switch-tool",
      { script: `${inlineScript}return "done before switch";` },
      undefined,
      undefined,
      workflowCtx(),
    );

    await vi.waitFor(
      () => {
        const card = String(
          tools.get("SubagentWorkflow")
            .renderResult(result, { expanded: false, isPartial: false }, plainTheme, { isError: false })
            .text ?? "",
        );
        expect(card).toContain("done");
      },
      { timeout: 4_000, interval: 5 },
    );
    await booted.lifecycle.get("session_before_switch")?.({}, workflowCtx());
    await new Promise(resolve => setTimeout(resolve, 300));
    await flush();

    expect(booted.pi.sendMessage.mock.calls.some((call: any[]) => call[0]?.customType === "subagent-notification")).toBe(false);
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

  it("kills a still-running workflow without delivering after session shutdown", async () => {
    // A never-returning script: only the run's own abort signal can stop it, so
    // abortAll() over the agent records would leave the worker spinning. The
    // task card still reaches its terminal state, but shutdown invalidates the
    // detached completion before it can enqueue a message into the dead session.
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-shutdown",
      { script: `${inlineScript}await new Promise(() => {});\n` },
      undefined, undefined, workflowCtx(),
    );
    const taskId = startedTaskId(result);

    await booted.lifecycle.get("session_shutdown")?.({}, workflowCtx());

    await vi.waitFor(() => {
      const card = String(
        tools.get("SubagentWorkflow")
          .renderResult(result, { expanded: false, isPartial: false }, plainTheme, { isError: false })
          .text ?? "",
      );
      expect(card).toContain("stopped");
    }, { timeout: 4_000, interval: 5 });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(booted.pi.sendMessage.mock.calls.some(
      call => notificationIncludesTaskId(call, taskId),
    )).toBe(false);
  });

  it("reports a script that threw, rather than a run that quietly ended", async () => {
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-throw",
      { script: `${inlineScript}throw new Error("script blew up");\n` },
      undefined, undefined, workflowCtx(),
    );

    const sent = await awaitNotification(startedTaskId(result));
    expect(String(sent[0].content)).toContain("<status>Error:");
    expect(sent[0].details).toMatchObject({ status: "error" });
    // The reason has to be the *result* too, not only the status line — that is
    // what the collapsed notification row shows.
    expect(String(sent[0].details.resultPreview)).toContain("script blew up");
  });

  it("reports a run that could not start at all", async () => {
    // A control character is rejected before the worker is created, so this
    // never reaches the run's own error path.
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-bad",
      { script: `${inlineScript}const x = "\u0007";\n` },
      undefined, undefined, workflowCtx(),
    );

    const sent = await awaitNotification(startedTaskId(result));
    expect(String(sent[0].content)).toContain("control characters");
    expect(sent[0].details).toMatchObject({ status: "error" });
  });
});

/* ------------------------------------------------------------------------- *
 * The CLI flag
 * ------------------------------------------------------------------------- */

describe("--subagents-workflow-file", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    hermetic = hermeticDir({ testAgents: true, settings: { schedulingEnabled: false, workflowsEnabled: true } });
  });

  afterEach(async () => {
    await flush();
    hermetic.restore();
    vi.restoreAllMocks();
  });

  const uiCtx = (overrides: Record<string, unknown> = {}) =>
    ctx({
      hasUI: true,
      cwd: hermetic.dir,
      ui: {
        setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), confirm: vi.fn(async () => true),
        addAutocompleteProvider: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()),
      },
      ...overrides,
    });

  function mockFlagWorkflowChild(result: string, stream: string, failure?: string): void {
    vi.spyOn(AgentManager.prototype, "spawnAndWait").mockImplementation(async (
      _pi,
      _context,
      _type,
      _prompt,
      options,
      onSpawned,
    ) => {
      const child = record({
        id: "private-child-record",
        artifactId: "private-child-artifact",
        result,
        ...(failure !== undefined ? { status: "error" as const, error: failure } : {}),
      });
      onSpawned?.(child.id);
      options.onTextDelta?.(stream, stream);
      return { id: child.id, record: child };
    });
  }

  it("registers the fleet row as soon as a run starts, not when it settles", async () => {
    // The regression this guards: a run's agents are owned by it, so their
    // lifecycle callbacks no longer refresh the fleet — and nothing else did,
    // which left a running workflow invisible in FleetView.
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = uiCtx();
    await booted.lifecycle.get("session_start")?.({}, context);
    context.ui.setWidget.mockClear();

    await booted.tools.get("SubagentWorkflow").execute(
      "tc-fleet",
      { script: inlineScript },
      undefined, undefined, uiCtx(),
    );

    const keys = context.ui.setWidget.mock.calls.map((call: any[]) => call[0]);
    expect(keys, "the run has to claim its row before its first agent starts").toContain("fleet");
  });

  it("registers a renderable Agents root and declared phase before any child starts", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = uiCtx();
    await booted.lifecycle.get("session_start")?.({}, context);
    context.ui.setWidget.mockClear();

    const script = 'export const meta = { name: "cached-root", description: "root", phases: [{ title: "Inspect" }] };\n';
    await booted.tools.get("SubagentWorkflow").execute(
      "tc-agents-root",
      { script },
      undefined,
      undefined,
      context,
    );

    const calls: unknown[] = context.ui.setWidget.mock.calls;
    expect(calls.map(call => callField(call, 0))).toEqual(expect.arrayContaining(["agents", "fleet"]));
    const agentsCall = calls.find(call => callField(call, 0) === "agents");
    const content = callField(agentsCall, 1);
    expect(content).toBeTypeOf("function");
    if (typeof content !== "function") throw new Error("Agents widget factory was not registered");
    const rendered = content(
      { terminal: { columns: 120 }, requestRender: () => {} },
      plainTheme,
    ).render().join("\n");
    expect(rendered).toContain("cached-root");
    expect(rendered).toContain("Inspect");
    expect(rendered).toContain("not-started");
  });

  it("captures the UI at session_start, before any tool has executed", () => {
    // A flag-launched workflow runs from session_start, so a UI captured only
    // from tool_execution_start would leave it with no widget and no fleet row.
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = uiCtx();

    booted.lifecycle.get("session_start")?.({}, context);

    expect(context.ui.onTerminalInput, "the fleet list only hooks input once it has a UI").toHaveBeenCalled();
  });

  it("registers the flag at activation but does not read it there", () => {
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: "ignored-at-activation.js" });
    subagentsExtension(booted.pi);

    expect(booted.registeredFlags.get(WORKFLOW_FILE_FLAG)).toMatchObject({ type: "string" });
    // The host applies CLI values only AFTER every extension factory has run, so
    // reading here would see the registered default and never the real value.
    expect(booted.pi.getFlag).not.toHaveBeenCalled();
  });

  it("reads the flag from session_start", async () => {
    const path = join(hermetic.dir, "flow.js");
    writeFileSync(path, fileScript);
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
    subagentsExtension(booted.pi);

    await booted.lifecycle.get("session_start")?.({}, uiCtx());

    expect(booted.pi.getFlag).toHaveBeenCalledWith(WORKFLOW_FILE_FLAG);
  });

  it("lets TaskOutput consume a joined startup-file completion without duplicate model delivery", async () => {
    const path = join(hermetic.dir, "joined-flow.js");
    writeFileSync(path, `${fileScript}return "joined startup result";\n`);
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
    subagentsExtension(booted.pi);
    const context = uiCtx();

    await booted.lifecycle.get("session_start")?.({}, context);
    let lookupError: unknown;
    try {
      await booted.tools.get("TaskOutput").execute(
        "tc-startup-output-lookup",
        { task_id: "wf_missing", block: false },
        undefined,
        undefined,
        context,
      );
    } catch (error) {
      lookupError = error;
    }
    const taskId = /Known workflow runs: (wf_[a-z0-9]+)/.exec(String(lookupError))?.[1];
    expect(taskId).toBeTruthy();

    const output = await booted.tools.get("TaskOutput").execute(
      "tc-startup-output-join",
      { task_id: taskId, block: true, timeout: 5000 },
      undefined,
      undefined,
      context,
    );

    expect(textOf(output)).toContain(`Workflow ${taskId} [completed]`);
    expect(textOf(output)).toContain("joined startup result");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(booted.pi.appendEntry).toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
    expect(booted.pi.sendMessage.mock.calls.filter((call: unknown) =>
      ["workflow-result", "subagent-notification"].includes(String(callMessageField(call, "customType")))
      && String(callMessageField(call, "content")).includes(taskId),
    )).toHaveLength(0);
  });

  it("explains the `=` form when the flag arrives bare as boolean true", async () => {
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: true });
    subagentsExtension(booted.pi);
    const context = uiCtx();

    await booted.lifecycle.get("session_start")?.({}, context);

    const notices = context.ui.notify.mock.calls.map((c: any[]) => String(c[0]));
    expect(notices.some((m: string) => m.includes(`--${WORKFLOW_FILE_FLAG}=<path>`))).toBe(true);
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

  it("does nothing at all when the flag was not passed", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = uiCtx();

    await booted.lifecycle.get("session_start")?.({}, context);
    await flush();

    expect(context.ui.notify).not.toHaveBeenCalled();
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

  it("reports a script it cannot read without starting a run", async () => {
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: join(hermetic.dir, "absent.js") });
    subagentsExtension(booted.pi);
    const context = uiCtx();

    await booted.lifecycle.get("session_start")?.({}, context);
    await flush();

    expect(context.ui.notify.mock.calls.some((c: any[]) => /Could not read/.test(String(c[0])))).toBe(true);
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

  it("suppresses a startup-file completion after switching sessions", async () => {
    const path = join(hermetic.dir, "switch-flow.js");
    writeFileSync(path, `${fileScript}await new Promise(() => {});`);
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
    subagentsExtension(booted.pi);
    const context = uiCtx();

    await booted.lifecycle.get("session_start")?.({}, context);
    await booted.lifecycle.get("session_before_switch")?.({}, context);
    await new Promise(resolve => setTimeout(resolve, 300));
    await flush();

    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
    expect(booted.pi.sendMessage.mock.calls.some((call: any[]) => call[0]?.customType === "workflow-result")).toBe(false);
  });

  it("omits private child content from a privacy-off flag entry and notification", async () => {
    const previous = getOutputTranscriptDefault();
    setOutputTranscriptDefault(false);
    try {
      const privatePrompt = "private child prompt for startup workflow";
      const privateResult = "private child result from startup workflow";
      const privateStream = "private streaming child output";
      mockFlagWorkflowChild(privateResult, privateStream);
      const path = join(hermetic.dir, "private-flow.js");
      writeFileSync(path, [
        fileScript,
        `const childText = await agent(${JSON.stringify(privatePrompt)});`,
        "phase(childText);",
        "log(childText);",
        'return "workflow finished";',
        "",
      ].join("\n"));
      const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
      subagentsExtension(booted.pi);
      const context = uiCtx({
        sessionManager: {
          getSessionId: vi.fn(() => "private-flag-session"),
          getSessionFile: vi.fn(() => join(hermetic.dir, "parent.jsonl")),
          getBranch: vi.fn(() => []),
        },
      });

      await booted.lifecycle.get("session_start")?.({}, context);
      await vi.waitFor(
        () => expect(booted.pi.appendEntry).toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything()),
        { timeout: 10_000 },
      );
      const [, entry] = booted.pi.appendEntry.mock.calls.find((c: any[]) => c[0] === WORKFLOW_ENTRY_TYPE)!;
      const persisted = JSON.stringify(entry);
      expect(persisted).not.toContain(privatePrompt);
      expect(persisted).not.toContain(privateResult);
      expect(persisted).not.toContain(privateStream);
      expect(persisted).not.toContain("promptPreview");
      expect(persisted).not.toContain("resultPreview");
      expect(persisted).not.toContain("outputPreview");
      expect(entry).toMatchObject({
        status: "completed",
        agentCount: 1,
        resultSummary: "Output persistence disabled.",
        aggregateArtifactStatus: "metadata-only",
        aggregateArtifactPath: expect.stringContaining("workflow-"),
      });
      expect(entry.progress).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "workflow_agent", index: 0, label: "Agent 1", state: "done" }),
        { type: "workflow_log", message: "Output persistence disabled." },
      ]));

      await vi.waitFor(
        () => expect(booted.pi.sendMessage.mock.calls.some(
          (call: unknown) => callMessageField(call, "customType") === "workflow-result",
        )).toBe(true),
        { timeout: 1_000 },
      );
      const sent = booted.pi.sendMessage.mock.calls.find(
        (call: unknown) => callMessageField(call, "customType") === "workflow-result",
      );
      expect(sent).toBeTruthy();
      expect(String(sent![0].content)).not.toContain(privateResult);
      expect(String(sent![0].content)).toContain("<result>Output persistence disabled.</result>");
    } finally {
      rmSync(sessionTaskDir(hermetic.dir, "private-flag-session"), { recursive: true, force: true });
      setOutputTranscriptDefault(previous);
    }
  });

  it("uses a fixed error marker when a private workflow throws child text", async () => {
    const previous = getOutputTranscriptDefault();
    setOutputTranscriptDefault(false);
    const privateResult = "private child result from failed startup workflow";
    try {
      mockFlagWorkflowChild(privateResult, "private child stream", privateResult);
      const path = join(hermetic.dir, "private-failing-flow.js");
      writeFileSync(path, [
        fileScript,
        `const childText = await agent("private child prompt");`,
        "throw new Error(childText);",
        "",
      ].join("\n"));
      const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
      subagentsExtension(booted.pi);
      const sessionId = "private-failing-flag-session";
      const context = uiCtx({
        sessionManager: {
          getSessionId: vi.fn(() => sessionId),
          getSessionFile: vi.fn(() => join(hermetic.dir, "parent.jsonl")),
          getBranch: vi.fn(() => []),
        },
      });

      await booted.lifecycle.get("session_start")?.({}, context);
      await vi.waitFor(
        () => expect(booted.pi.appendEntry).toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything()),
        { timeout: 10_000 },
      );
      const [, entry] = booted.pi.appendEntry.mock.calls.find((c: any[]) => c[0] === WORKFLOW_ENTRY_TYPE)!;
      expect(JSON.stringify(entry)).not.toContain(privateResult);
      expect(entry).toMatchObject({
        status: "failed",
        resultSummary: "Output persistence disabled.",
        aggregateArtifactStatus: "metadata-only",
      });

      const aggregateArtifactPath = entry.aggregateArtifactPath;
      expect(aggregateArtifactPath).toBeTypeOf("string");
      if (typeof aggregateArtifactPath !== "string") throw new Error("missing aggregate artifact path");
      const manifest = JSON.parse(readFileSync(aggregateArtifactPath, "utf-8")) as {
        error?: string;
        childAttempts?: Array<{ status?: string; error?: string }>;
      };
      expect(manifest.error).toBe("Workflow failed; output persistence disabled.");
      expect(manifest.childAttempts).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "failed" }),
      ]));
      expect(manifest.childAttempts?.some(attempt => "error" in attempt)).toBe(false);
      expect(JSON.stringify(manifest)).not.toContain(privateResult);

      await vi.waitFor(
        () => expect(booted.pi.sendMessage.mock.calls.some(
          (call: unknown) => callMessageField(call, "customType") === "workflow-result",
        )).toBe(true),
        { timeout: 1_000 },
      );
      const sent = booted.pi.sendMessage.mock.calls.find(
        (call: unknown) => callMessageField(call, "customType") === "workflow-result",
      );
      expect(sent).toBeTruthy();
      expect(String(sent![0].content)).not.toContain(privateResult);
      expect(String(sent![0].content)).toContain("<result>Output persistence disabled.</result>");
    } finally {
      rmSync(sessionTaskDir(hermetic.dir, "private-failing-flag-session"), { recursive: true, force: true });
      setOutputTranscriptDefault(previous);
    }
  });

  it("retains child previews and logs in a privacy-on flag entry", async () => {
    const privatePrompt = "persisted child prompt";
    const privateResult = "persisted child result";
    const privateStream = "persisted streaming output";
    mockFlagWorkflowChild(privateResult, privateStream);
    const path = join(hermetic.dir, "persisted-flow.js");
    writeFileSync(path, [
      fileScript,
      `const childText = await agent(${JSON.stringify(privatePrompt)});`,
      "log(childText);",
      'return "workflow finished";',
      "",
    ].join("\n"));
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
    subagentsExtension(booted.pi);

    await booted.lifecycle.get("session_start")?.({}, uiCtx());
    await vi.waitFor(
      () => expect(booted.pi.appendEntry).toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything()),
      { timeout: 10_000 },
    );

    const [, entry] = booted.pi.appendEntry.mock.calls.find((c: any[]) => c[0] === WORKFLOW_ENTRY_TYPE)!;
    const persisted = JSON.stringify(entry);
    expect(persisted).toContain(privatePrompt);
    expect(persisted).toContain(privateResult);
    expect(persisted).toContain(privateStream);
    expect(entry.progress).toContainEqual({ type: "workflow_log", message: privateResult });
  });

  it("renders the finished run as a session entry and hands it to the model as next-turn context", async () => {
    const path = join(hermetic.dir, "flow.js");
    writeFileSync(path, `${fileScript}log("scanned");\nreturn "all clear";\n`);
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
    subagentsExtension(booted.pi);

    await booted.lifecycle.get("session_start")?.({}, uiCtx());
    await vi.waitFor(
      () => expect(booted.pi.appendEntry).toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything()),
      { timeout: 10_000 },
    );

    const [, data] = booted.pi.appendEntry.mock.calls.find((c: any[]) => c[0] === WORKFLOW_ENTRY_TYPE)!;
    expect(data).toMatchObject({ name: "from-file", status: "completed" });
    // The card is rebuilt from this log, so the entry has to carry it.
    expect(data.progress).toContainEqual({ type: "workflow_log", message: "scanned" });

    // nextTurn, not followUp: a flag-launched run puts its result in context
    // without forcing a turn the user never asked for. Delivery is held briefly
    // so TaskOutput can consume the same result without a duplicate.
    await vi.waitFor(
      () => expect(booted.pi.sendMessage.mock.calls.some(
        (call: unknown) => callMessageField(call, "customType") === "workflow-result",
      )).toBe(true),
      { timeout: 1000 },
    );
    const sent = booted.pi.sendMessage.mock.calls.find(
      (call: unknown) => callMessageField(call, "customType") === "workflow-result",
    );
    expect(sent, "the run's outcome must reach the model").toBeTruthy();
    expect(sent![1]).toMatchObject({ deliverAs: "nextTurn" });
    expect(String(sent![0].content)).toContain("<result>all clear</result>");
  });

  it("renders the persisted entry through the shared workflow card layout", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const renderer = booted.entryRenderers.get(WORKFLOW_ENTRY_TYPE);
    expect(renderer, "a custom entry with no renderer is silently dropped by the host").toBeTruthy();

    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const rendered = renderer(
      {
        data: {
          name: "from-file",
          status: "completed",
          startTime: 0,
          endTime: 1000,
          agentCount: 1,
          totalTokens: 0,
          progress: [
            { type: "workflow_agent", index: 0, label: "step", state: "done", agentType: "Explorer" },
          ],
        },
      },
      { expanded: false },
      theme,
    );

    const text = String(rendered.text ?? "");
    expect(text).toContain("from-file");
    expect(text).toContain("step");
    expect(text).toContain("1/1 agent");
  });
});

/* ------------------------------------------------------------------------- *
 * The master switch
 * ------------------------------------------------------------------------- */

describe("workflowsEnabled — the master switch", () => {
  let hermetic: Hermetic;

  afterEach(async () => {
    await flush();
    hermetic.restore();
    vi.restoreAllMocks();
  });

  /** A context with the UI surface `session_start` touches on the way through. */
  const switchCtx = () =>
    ctx({
      hasUI: true,
      cwd: hermetic.dir,
      ui: {
        setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(),
        addAutocompleteProvider: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()),
      },
    });

  /** Boot the extension against a project whose settings say `settings`. */
  const boot = (settings: Record<string, unknown>, flags: Record<string, string | boolean> = {}) => {
    hermetic = hermeticDir({ testAgents: true, settings });
    const booted = makePi(flags);
    subagentsExtension(booted.pi);
    return booted;
  };

  it("leaves all workflow tools unregistered with no setting at all", () => {
    const booted = boot({});

    expect(booted.tools.has("SubagentWorkflow")).toBe(false);
    expect(booted.tools.has("WorkflowPlaybook")).toBe(false);
    expect(booted.tools.has("WorkflowPlaybookSave")).toBe(false);
    // Nothing else is affected.
    expect(booted.tools.has("Agent")).toBe(true);
  });

  it("disables all workflow tools when the setting is false", () => {
    const booted = boot({ workflowsEnabled: false });
    expect(booted.tools.has("SubagentWorkflow")).toBe(false);
    expect(booted.tools.has("WorkflowPlaybook")).toBe(false);
    expect(booted.tools.has("WorkflowPlaybookSave")).toBe(false);
  });

  it("registers exactly the three supported workflow features once enabled", () => {
    const booted = boot({ workflowsEnabled: true });
    const workflowFeatures = [...booted.tools.keys()].filter(name =>
      ["SubagentWorkflow", "WorkflowPlaybook", "WorkflowPlaybookSave", "WorkflowPlan"].includes(name)
    );
    expect(workflowFeatures.sort()).toEqual(
      ["SubagentWorkflow", "WorkflowPlaybook", "WorkflowPlaybookSave"].sort(),
    );
    expect(booted.entryRenderers.has("workflow-plan")).toBe(false);
  });

  it("refuses the startup flag while off, instead of running the script anyway", async () => {
    // The flag is the same machinery by another door, so the switch has to
    // close it too — and say why, rather than appearing to do nothing.
    const booted = boot({ workflowsEnabled: false });
    const path = join(hermetic.dir, "flow.js");
    writeFileSync(path, fileScript);
    booted.pi.getFlag.mockReturnValue(path);
    const context = switchCtx();

    await booted.lifecycle.get("session_start")?.({}, context);

    const notices = context.ui.notify.mock.calls.map((c: any[]) => String(c[0]));
    expect(notices.some((m: string) => /workflows are off/i.test(m))).toBe(true);
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

});

/* ------------------------------------------------------------------------- *
 * Name collisions with other extensions
 * ------------------------------------------------------------------------- */

describe("collisions with another extension", () => {
  let hermetic: Hermetic;

  afterEach(async () => {
    await flush();
    hermetic.restore();
    vi.restoreAllMocks();
  });

  const boot = (settings: Record<string, unknown> = { workflowsEnabled: true }) => {
    hermetic = hermeticDir({ testAgents: true, settings });
    const booted = makePi();
    subagentsExtension(booted.pi);
    return booted;
  };

  const uiContext = () =>
    ctx({
      hasUI: true,
      cwd: hermetic.dir,
      ui: {
        setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(),
        addAutocompleteProvider: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()),
      },
    });

  const warnings = (context: any) =>
    context.ui.notify.mock.calls.filter((c: any[]) => c[1] === "warning").map((c: any[]) => String(c[0]));

  it("warns while keeping Markdown Playbooks when another extension owns the runtime name", async () => {
    // Pi keeps the FIRST registration per tool name, across extensions. Ours
    // never reaches the registry, and nothing in pi says so.
    const booted = boot();
    booted.pi.getAllTools.mockReturnValue([
      {
        name: "SubagentWorkflow",
        description: "some other extension's workflow tool",
        sourceInfo: { source: "other-ext", path: "/x/other.ts" },
      },
    ]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    expect(warnings(context).some(m => /already registers a "SubagentWorkflow" tool/.test(m))).toBe(true);
    expect(warnings(context).some(m => /other-ext/.test(m))).toBe(true);
    expect(booted.pi.getActiveTools()).toContain("SubagentWorkflow");
    expect(booted.pi.getActiveTools()).toContain("WorkflowPlaybook");
    expect(booted.pi.getActiveTools()).toContain("WorkflowPlaybookSave");
  });

  it("stays quiet when the registered tool is our own", async () => {
    const booted = boot();
    const ours = booted.tools.get("SubagentWorkflow");
    booted.pi.getAllTools.mockReturnValue([
      { name: "SubagentWorkflow", description: ours.description, sourceInfo: { source: "pi-subagents" } },
    ]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    expect(warnings(context).filter(m => /SubagentWorkflow/.test(m))).toEqual([]);
  });

  it("does not check the tool name while workflows are off", async () => {
    // Nothing of ours is registered, so another extension owning the name is
    // simply not our business to complain about.
    const booted = boot({ workflowsEnabled: false });
    booted.pi.getAllTools.mockReturnValue([
      { name: "SubagentWorkflow", description: "someone else's", sourceInfo: { source: "other-ext" } },
    ]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    expect(warnings(context).filter(m => /SubagentWorkflow/.test(m))).toEqual([]);
  });

  it("survives a host where the listing methods are unavailable", async () => {
    // print mode and RPC mode do not bind them; a diagnostic must not be the
    // thing that takes the session down.
    const booted = boot();
    booted.pi.getAllTools.mockImplementation(() => {
      throw new Error("Extension runtime not initialized.");
    });
    const context = uiContext();

    await expect(booted.lifecycle.get("session_start")?.({}, context)).resolves.not.toThrow();
    expect(warnings(context)).toEqual([]);
  });

  /** Boot with no `workflowsEnabled` at all — off by default. */
  const bootDefault = () => boot({});

  const foreign = (name: string, source = "other-ext") => ({
    name,
    description: "some other extension's workflow tool",
    sourceInfo: { source, path: `/x/${source}.ts` },
  });

  it.each(["Workflow", "workflow", "SubagentWorkflow"])("stays disabled by default alongside a foreign %s tool", async name => {
    const booted = bootDefault();
    booted.pi.getAllTools.mockReturnValue([foreign(name)]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    expect(booted.tools.has("SubagentWorkflow")).toBe(false);
    expect(booted.pi.setActiveTools).not.toHaveBeenCalled();
    expect(booted.pi.getActiveTools()).not.toContain("SubagentWorkflow");
    expect(booted.pi.getActiveTools()).not.toContain("WorkflowPlaybook");
    expect(booted.pi.getActiveTools()).not.toContain("WorkflowPlaybookSave");
    expect(booted.pi.getActiveTools()).toContain("Agent");
    expect(warnings(context)).toEqual([]);
  });

  it("refuses the startup flag by default alongside another workflow tool", async () => {
    hermetic = hermeticDir({ testAgents: true, settings: {} });
    const path = join(hermetic.dir, "flow.js");
    writeFileSync(path, fileScript);
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
    subagentsExtension(booted.pi);
    booted.pi.getAllTools.mockReturnValue([foreign("Workflow")]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    const notices = context.ui.notify.mock.calls.map((c: any[]) => String(c[0]));
    expect(notices.some((m: string) => /workflows are off/i.test(m))).toBe(true);
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

  it("keeps ours when the setting pins workflows on", async () => {
    // A default yields to what else is loaded. A choice does not.
    const booted = boot({ workflowsEnabled: true });
    booted.pi.getAllTools.mockReturnValue([foreign("Workflow")]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    expect(booted.pi.setActiveTools).not.toHaveBeenCalled();
    expect(booted.pi.getActiveTools()).toContain("SubagentWorkflow");
    expect(warnings(context).filter(m => /disabled for this session/.test(m))).toEqual([]);
  });

  /**
   * Drive `/agents → Settings` far enough to write the settings file.
   *
   * Any change writes the WHOLE snapshot, so which row is toggled does not
   * matter — row 0 is `Max concurrency`, whose single-value list re-applies the
   * value it already had. What matters is that the file gets written at all.
   */
  async function changeAnUnrelatedSetting(booted: ReturnType<typeof boot>) {
    // The settings list asks for a real theme, which only the TUI normally sets up.
    initTheme(undefined, false);
    let built: any;
    // Take the Settings entry exactly once: the agents menu re-opens after a
    // submenu closes, so answering it every time never terminates.
    let taken = false;
    const context = ctx({
      cwd: hermetic.dir,
      ui: {
        notify: vi.fn(),
        select: vi.fn(async (title: string, options: string[]) => {
          if (title !== "Agents" || taken) return undefined;
          taken = true;
          return options.find(o => o === "Settings");
        }),
        custom: vi.fn(async (factory: any) => {
          built = factory({ requestRender: () => {} }, {}, {}, () => {});
          built.handleInput(" ");
          return undefined;
        }),
        input: vi.fn(async () => undefined),
      },
    });
    await booted.commands.get("agents").handler("", context);
    return context;
  }

  const savedSettings = () =>
    JSON.parse(readFileSync(join(hermetic.dir, ".pi", "subagents.json"), "utf-8"));

  it("keeps an absent workflow setting absent when saving unrelated settings", async () => {
    const booted = bootDefault();
    booted.pi.getAllTools.mockReturnValue([foreign("Workflow")]);
    await booted.lifecycle.get("session_start")?.({}, uiContext());

    await changeAnUnrelatedSetting(booted);

    expect(savedSettings()).not.toHaveProperty("workflowsEnabled");
  });

  it("still persists the setting when the user pinned it", async () => {
    const booted = boot({ workflowsEnabled: false });

    await changeAnUnrelatedSetting(booted);

    expect(savedSettings().workflowsEnabled).toBe(false);
  });

  it("preserves all feature opt-ins when saving unrelated settings", async () => {
    const booted = boot({ workflowsEnabled: true, roomsEnabled: true, fusionEnabled: true });

    await changeAnUnrelatedSetting(booted);

    expect(savedSettings()).toMatchObject({ workflowsEnabled: true, roomsEnabled: true, fusionEnabled: true });
  });

  it("ignores tool names that merely contain the word", async () => {
    // A substring test would turn any CI integration into a silent shutdown of
    // this feature — the kind of bug nobody can see from the outside.
    const booted = boot({ workflowsEnabled: true });
    booted.pi.getAllTools.mockReturnValue([
      foreign("list_workflows"),
      foreign("github_workflow_run"),
      foreign("WorkflowTemplate"),
    ]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    expect(booted.pi.setActiveTools).not.toHaveBeenCalled();
    expect(booted.pi.getActiveTools()).toContain("SubagentWorkflow");
    expect(warnings(context)).toEqual([]);
  });
});
