/**
 * group-chat.test.ts — host-only default, session binding, hop/queue, /chat wiring.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent, SUBAGENT_TOOL_NAMES } from "../src/agent-runner.js";
import { parseMemberSpecs } from "../src/group-chat/commands.js";
import { enqueueSeatWork, hopExhausted, isRetryableSeatError, seatRetryDelayMs } from "../src/group-chat/runtime.js";
import { GroupStore } from "../src/group-chat/store.js";
import type { GroupChatHost, RoomBinding, RoomMember } from "../src/group-chat/types.js";
import { MAX_HOP } from "../src/group-chat/types.js";
import { extractMentionHandles, planWake } from "../src/group-chat/wake.js";
import subagentsExtension from "../src/index.js";
import { nextModelFallback } from "../src/model-fallback.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const members: RoomMember[] = [
  { handle: "explorer", type: "Explorer" },
  { handle: "reviewer", type: "Reviewer" },
];

describe("wake", () => {
  it("plans host-only when there is no @handle", () => {
    expect(planWake("ship the plan", members)).toMatchObject({ kind: "host", host: true, seats: [] });
  });

  it("wakes only the mentioned seats", () => {
    expect(extractMentionHandles("hey @reviewer look at auth")).toEqual(["reviewer"]);
    expect(planWake("hey @reviewer look at auth", members).seats.map(m => m.handle)).toEqual(["reviewer"]);
  });

  it("treats @everyone as all seats and @main as host", () => {
    expect(planWake("@everyone sync", members).kind).toBe("everyone");
    expect(planWake("@main keep this", members).kind).toBe("host");
  });

  it("falls back to host when only unknown seats are named", () => {
    expect(planWake("@ghost hello", members).kind).toBe("none");
    expect(planWake("@ghost hello", members).host).toBe(true);
  });
});

describe("GroupStore", () => {
  let hermetic: Hermetic;
  beforeEach(() => { hermetic = hermeticDir(); });
  afterEach(() => { hermetic.restore(); });

  it("persists meta and log without a cwd-level active pointer", () => {
    const store = new GroupStore(hermetic.dir);
    const room = store.create("Design", members);
    expect(room.id).toBe("design");
    store.append(room.id, { kind: "user", role: "user", hop: 0, text: "hello @reviewer" });
    expect(store.readLog(room.id)[0].text).toBe("hello @reviewer");
    expect(existsSync(join(hermetic.dir, ".pi/groups/active.json"))).toBe(false);
    expect(existsSync(join(hermetic.dir, ".pi/groups/design/meta.json"))).toBe(true);
    expect(new GroupStore(hermetic.dir).find("Design")?.id).toBe("design");
  });
});

describe("hop", () => {
  it("exhausts after MAX_HOP", () => {
    expect(hopExhausted(MAX_HOP)).toBe(false);
    expect(hopExhausted(MAX_HOP + 1)).toBe(true);
  });
});

describe("enqueueSeatWork", () => {
  let hermetic: Hermetic;
  beforeEach(() => { hermetic = hermeticDir(); });
  afterEach(() => {
    vi.useRealTimers();
    hermetic.restore();
  });

  function host(): GroupChatHost {
    const binding: { current: RoomBinding | null } = { current: null };
    return {
      spawn: vi.fn(async (type, prompt) => ({
        id: `id-${type}`,
        status: "completed",
        result: `${type} saw: ${prompt.slice(-40)}`,
        hasSession: true,
      })),
      resume: vi.fn(),
      abort: vi.fn(() => true),
      resolveLive: () => undefined,
      getRecord: () => undefined,
      resolveType: spec => spec,
      sessionId: () => "s1",
      cwd: () => hermetic.dir,
      appendBinding: b => { binding.current = b; },
      readBinding: () => binding.current,
      appendRoomLine: vi.fn(),
      seatTools: () => [],
      modelFor: () => undefined,
      modelFallbacks: () => ({}),
    };
  }

  it("refuses self handoff", async () => {
    const store = new GroupStore(hermetic.dir);
    const room = store.create("pair", members);
    const h = host();
    const self = await enqueueSeatWork({
      store, room, host: h, sessionId: "s1", seat: members[0], kind: "handoff",
      from: "explorer", text: "self", hop: 1,
    });
    expect(self).toEqual({ ok: false, error: "cannot hand off to yourself" });
  });

  it("retries a transient spawn error then succeeds", async () => {
    vi.useFakeTimers();
    const store = new GroupStore(hermetic.dir);
    const room = store.create("pair", members);
    const h = host();
    vi.mocked(h.spawn)
      .mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
      .mockResolvedValueOnce({
        id: "id-Explorer",
        status: "completed",
        result: "ok",
        hasSession: true,
      });
    await enqueueSeatWork({
      store, room, host: h, sessionId: "s1", seat: members[0], kind: "tell",
      from: "main", text: "go", hop: 0,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    const log = store.readLog(room.id).map(l => l.text);
    expect(log.some(t => /retry 1\/10 after: fetch failed/.test(t))).toBe(true);
    expect(log).toContain("ok");
  });

  it("does not retry a user stop", async () => {
    const store = new GroupStore(hermetic.dir);
    const room = store.create("pair", members);
    const h = host();
    vi.mocked(h.spawn).mockResolvedValue({
      id: "id-Explorer",
      status: "stopped",
      error: "STOPPED BY THE USER",
      hasSession: true,
    });
    await enqueueSeatWork({
      store, room, host: h, sessionId: "s1", seat: members[0], kind: "tell",
      from: "main", text: "go", hop: 0,
    });
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it("switches model after the retry budget", async () => {
    vi.useFakeTimers();
    const store = new GroupStore(hermetic.dir);
    const room = store.create("pair", members);
    const h = host();
    h.modelFor = () => "openai/primary";
    h.modelFallbacks = () => ({ "openai/primary": "openai/backup" });
    vi.mocked(h.spawn).mockResolvedValue({
      id: "id-Explorer",
      status: "error",
      error: "fetch failed",
      hasSession: false,
    });
    const pending = enqueueSeatWork({
      store, room, host: h, sessionId: "s1", seat: members[0], kind: "tell",
      from: "main", text: "go", hop: 0,
    });
    await pending;
    await vi.runAllTimersAsync();
    const models = vi.mocked(h.spawn).mock.calls.map(call => call[2]?.model);
    expect(models.filter(model => model === undefined).length).toBeGreaterThan(1);
    expect(models).toContain("openai/backup");
    expect(store.readLog(room.id).some(line => line.text.includes("switching to openai/backup"))).toBe(true);
  });
});

describe("seat retry and model fallback", () => {
  it("backs off from 2s and caps at 32s", () => {
    expect(seatRetryDelayMs(1)).toBe(2_000);
    expect(seatRetryDelayMs(2)).toBe(4_000);
    expect(seatRetryDelayMs(5)).toBe(32_000);
  });

  it("walks a backup chain once", () => {
    const map = { "openai/a": "openai/b", "openai/b": "openai/a" };
    const tried = new Set<string>();
    expect(nextModelFallback("openai/a", map, tried)).toBe("openai/b");
    tried.add("openai/a");
    tried.add("openai/b");
    expect(nextModelFallback("openai/b", map, tried)).toBeUndefined();
  });
});

describe("isRetryableSeatError", () => {
  it("retries network-ish failures and skips user/policy stops", () => {
    expect(isRetryableSeatError("fetch failed")).toBe(true);
    expect(isRetryableSeatError("429 rate limit")).toBe(true);
    expect(isRetryableSeatError("STOPPED BY THE USER")).toBe(false);
    expect(isRetryableSeatError("unknown agent type: ghost")).toBe(false);
  });
});

describe("parseMemberSpecs", () => {
  it("numbers colliding types and caps at 6", () => {
    const parsed = parseMemberSpecs("Explorer Explorer", spec => spec === "Explorer" ? "Explorer" : undefined);
    expect(parsed.map(m => m.handle)).toEqual(["explorer", "explorer-2"]);
    expect(() => parseMemberSpecs("A B C D E F G", spec => spec)).toThrow(/At most 6/);
  });
});

describe("group-chat wiring", () => {
  let hermetic: Hermetic | undefined;
  let booted: Map<string, any> | undefined;

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "ok",
      session: { steer: vi.fn(), dispose: vi.fn(), subscribe: vi.fn(() => () => {}), messages: [] },
      aborted: false,
      steered: false,
      failure: undefined,
    } as any);
  });

  afterEach(async () => {
    await booted?.get("session_shutdown")?.();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    booted = undefined;
    hermetic?.restore();
    hermetic = undefined;
  });

  function boot(settings: Record<string, unknown> = { roomsEnabled: true }) {
    hermetic = hermeticDir({ testAgents: true, settings: { outputTranscript: false, ...settings } });
    const { pi, lifecycle, commands, tools } = makePi();
    subagentsExtension(pi);
    booted = lifecycle;
    return { lifecycle, commands, tools, pi };
  }

  it.each([{}, { roomsEnabled: false }])("does not register rooms or restore their routing when disabled: %j", async settings => {
    const { lifecycle, commands, tools } = boot(settings);
    const store = new GroupStore(hermetic!.dir);
    const room = store.create("saved", members);
    const session = ctx({
      cwd: hermetic!.dir,
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [{
          type: "custom", customType: "subagents:room",
          data: { chat: true, roomId: room.id, leader: "main" },
        }],
      },
    });
    await lifecycle.get("session_start")!({}, session);

    expect(commands.has("chat")).toBe(false);
    expect(commands.has("room")).toBe(false);
    for (const name of ["RoomEnsure", "RoomLeave", "room_tell", "handoff", "room_cancel"]) {
      expect(tools.has(name)).toBe(false);
    }
    await lifecycle.get("input")!({ text: "hello saved room", source: "interactive" }, session);
    expect(store.readLog(room.id)).toEqual([]);
    const prompt = await lifecycle.get("before_agent_start")!({ prompt: "hello", systemPrompt: "base" }, session);
    expect(prompt).toBeUndefined();
  });

  it("registers /chat and RoomEnsure; bare text continues to the host", async () => {
    const { lifecycle, commands, tools } = boot();
    const session = ctx({ cwd: hermetic!.dir });
    await lifecycle.get("session_start")!({}, session);

    expect(commands.has("chat")).toBe(true);
    expect(commands.has("room")).toBe(true);
    expect(tools.has(SUBAGENT_TOOL_NAMES.ROOM_JOIN)).toBe(true);
    expect(tools.has(SUBAGENT_TOOL_NAMES.ROOM_LEAVE)).toBe(true);
    expect(tools.has(SUBAGENT_TOOL_NAMES.ROOM_TELL)).toBe(true);
    expect(tools.has(SUBAGENT_TOOL_NAMES.ROOM_HANDOFF)).toBe(true);
    expect(tools.has(SUBAGENT_TOOL_NAMES.ROOM_CANCEL)).toBe(true);

    await commands.get("chat")!.handler("on Explorer Reviewer", session);
    const continued = await lifecycle.get("input")!({ text: "hello room", source: "interactive" }, session);
    expect(continued).toEqual({ action: "continue" });
    const store = new GroupStore(hermetic!.dir);
    expect(store.readLog("explorer-reviewer")[0].text).toBe("hello room");
  });

  it("handles @seat without running the host turn", async () => {
    const { lifecycle, commands } = boot();
    const session = ctx({ cwd: hermetic!.dir });
    await lifecycle.get("session_start")!({}, session);
    await commands.get("chat")!.handler("on Explorer Reviewer", session);
    const handled = await lifecycle.get("input")!({ text: "@reviewer only you", source: "interactive" }, session);
    expect(handled).toEqual({ action: "handled" });
  });

  it("does not intercept when chat is off", async () => {
    const { lifecycle } = boot();
    const session = ctx({ cwd: hermetic!.dir });
    await lifecycle.get("session_start")!({}, session);
    const result = await lifecycle.get("input")!({ text: "ordinary prompt", source: "interactive" }, session);
    expect(result).toEqual({ action: "continue" });
  });
});
