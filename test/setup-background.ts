import { vi } from "vitest";

// Unit-test hosts do not model the bundled background extension's lifecycle.
vi.mock("../src/background/extension.js", () => ({ default: vi.fn() }));
