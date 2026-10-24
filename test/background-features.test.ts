import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBackgroundTasksConfig } from "../src/background/core/config.js";
import backgroundTasksExtension from "../src/background/extension.js";
import { type Hermetic, hermeticDir } from "./helpers/boot-extension.js";

vi.unmock("../src/background/extension.js");

describe("background feature configuration", () => {
  it("disables Fusion by default and preserves the other feature defaults", () => {
    expect(parseBackgroundTasksConfig({}).features).toEqual({
      process: true, delegate: true, fusion: false, attested: true, attribution: true,
    });
    expect(parseBackgroundTasksConfig({}, true).features.fusion).toBe(true);
    expect(parseBackgroundTasksConfig({}, false).features.fusion).toBe(false);
  });

  it("gives an explicit PI_BG_FEATURES list precedence over the Fusion setting", () => {
    expect(parseBackgroundTasksConfig({ PI_BG_FEATURES: "process,fusion" }, false).features.fusion).toBe(true);
    expect(parseBackgroundTasksConfig({ PI_BG_FEATURES: "process" }, true).features.fusion).toBe(false);
    expect(() => parseBackgroundTasksConfig({ PI_BG_FEATURES: "fusion" }, true)).toThrow(/mandatory token process/);
  });
});

describe("Fusion registration", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    vi.stubEnv("PI_BG_FEATURES", undefined);
    vi.stubEnv("PI_BG_DOCK_SHORTCUT", "off");
  });

  afterEach(() => {
    hermetic?.restore();
    vi.unstubAllEnvs();
  });

  it.each([
    { settings: {}, enabled: false },
    { settings: { fusionEnabled: false }, enabled: false },
    { settings: { fusionEnabled: true }, enabled: true },
  ])("registers Fusion tools and commands according to $settings", async ({ settings, enabled }) => {
    hermetic = hermeticDir({ settings });
    const tools: string[] = [];
    const commands: string[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      registerCommand: (name: string) => commands.push(name),
      registerMessageRenderer: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
    } as unknown as ExtensionAPI;

    await backgroundTasksExtension(pi);

    for (const name of ["fusion_reason", "fusion_investigate", "fusion_research", "fusion_validate"]) {
      expect(tools.includes(name)).toBe(enabled);
    }
    expect(commands.includes("fusion")).toBe(enabled);
    expect(commands.includes("fusion-models")).toBe(enabled);
    expect(tools).toEqual(expect.arrayContaining(["bg_run", "bg_delegate", "bg_result", "bg_status", "bg_logs", "bg_kill"]));
  });
});
