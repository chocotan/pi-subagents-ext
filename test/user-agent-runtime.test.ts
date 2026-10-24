import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents, setDefaultAgent } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { formatDirectWorkflowApproval } from "../src/workflow/approval.js";
import type { WorkflowJournalEntry } from "../src/workflow/journal.js";
import { runWorkflow, type WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";

const meta = { name: "user-agents", description: "test explicit agent selection" };
const script = `export const meta = ${JSON.stringify(meta)}; return await agent("inspect");`;
const makeHost = () => ({
  spawnAgent: vi.fn(async (request: WorkflowSpawnRequest) => ({ ok: true, text: request.agentType })),
  abortAgent: vi.fn(),
});

afterEach(() => registerAgents(new Map()));

describe("no implicit executor", () => {
  it("refuses direct runner execution before environment detection or extension loading", async () => {
    registerAgents(new Map());
    const exec = vi.fn();
    await expect(runAgent({} as ExtensionContext, "Worker", "write something", {
      pi: { exec } as unknown as ExtensionAPI,
    })).rejects.toThrow("Unknown or disabled agent type");
    expect(exec).not.toHaveBeenCalled();
  });

  it("fails a workflow call with no explicit type or user default before spawning", async () => {
    const host = makeHost();
    const result = await runWorkflow({ script, host });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("explicit agentType");
    expect(result.agentCount).toBe(0);
    expect(host.spawnAgent).not.toHaveBeenCalled();
  });

  it("uses an explicit type without requiring a default", async () => {
    const host = makeHost();
    const result = await runWorkflow({
      script: script.replace('agent("inspect")', 'agent("inspect", { agentType: "git-review" })'), host,
    });
    expect(result.status).toBe("completed");
    expect(result.value).toBe("git-review");
    expect(host.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it("uses only the supplied default and lets an explicit type take precedence", async () => {
    const host = makeHost();
    expect((await runWorkflow({ script, host, defaultAgent: "user-worker" })).value).toBe("user-worker");
    const result = await runWorkflow({
      script: script.replace('agent("inspect")', 'agent("inspect", { agentType: "user-reviewer" })'),
      host, defaultAgent: "user-worker",
    });
    expect(result.value).toBe("user-reviewer");
  });

  it("does not replay an omitted-type call after its configured default changes", async () => {
    const entries: WorkflowJournalEntry[] = [];
    await runWorkflow({ script, host: makeHost(), defaultAgent: "first", journal: { append: entry => entries.push(entry) } });
    const same = makeHost();
    const cached = await runWorkflow({ script, host: same, defaultAgent: "first", journal: { entries } });
    expect(cached.replayedCount).toBe(1);
    expect(same.spawnAgent).not.toHaveBeenCalled();
    const changed = makeHost();
    const fresh = await runWorkflow({ script, host: changed, defaultAgent: "second", journal: { entries } });
    expect(fresh.replayedCount).toBe(0);
    expect(fresh.value).toBe("second");
    expect(changed.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it("discloses missing defaults, configured defaults, and resume identity in approval", () => {
    expect(formatDirectWorkflowApproval({ script, meta, args: undefined, source: "inline" }))
      .toContain("agentType: not configured (call will fail)");
    expect(formatDirectWorkflowApproval({ script, meta, args: undefined, source: "inline", defaultAgent: "my-reviewer" }))
      .toContain("agentType: my-reviewer");
    expect(formatDirectWorkflowApproval({
      script: script.replace('agent("inspect")', 'agent("inspect", { resume: "previous" })'),
      meta, args: undefined, source: "inline", defaultAgent: "my-reviewer",
    })).toContain("agentType: original agent (resume)");
  });

  it("captures the configured default before a detached workflow starts its children", async () => {
    const environment = hermeticDir({
      settings: { defaultAgent: "first", outputTranscript: false, workflowsEnabled: true },
      agentFiles: { first: "---\ndescription: First\n---\nFirst.", second: "---\ndescription: Second\n---\nSecond." },
    });
    const booted = makePi();
    const spawn = vi.spyOn(AgentManager.prototype, "spawnAndWait").mockImplementation(async (_pi, _ctx, type) => {
      const record: AgentRecord = {
        id: "fixture-agent", artifactId: "fixture-attempt", artifactStatus: "skipped", type,
        description: "fixture", status: "completed", result: "done", toolUses: 0, startedAt: 0,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0,
      };
      return { id: record.id, record };
    });
    try {
      subagentsExtension(booted.pi);
      await booted.tools.get("SubagentWorkflow").execute("workflow-call", { script }, undefined, undefined, ctx());
      setDefaultAgent("second");
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      expect(spawn.mock.calls[0][2]).toBe("first");
    } finally {
      await booted.lifecycle.get("session_shutdown")?.();
      spawn.mockRestore();
      setDefaultAgent(undefined);
      environment.restore();
    }
  });
});
