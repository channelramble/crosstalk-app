// Where a chat on a service compacts by default: the app says it in the chat's context menu (shared serviceCompactPoint), and
// the agents get it from the hub's settings. Those two must not drift, or the menu's sizes read earlier than they are.
import { expect, test } from "bun:test";
import { serviceCompactPoint } from "@crosstalk/shared";
import { serviceCompactLimit } from "../src/agents/driver";
import { openCodeConfig } from "../src/agents/opencode";

const WINDOWS = [2_000_000, 1_048_576, 333_000, 200_000, 64_000, 48_000, 32_768, 20_000];
const endpoint = { id: "rl", label: "Refuseless", baseUrl: "https://api.refuseless.com", models: ["m"], key: "test-key" };

test("Crosstalk's agent compacts where the app says", () => {
  for (const contextWindow of WINDOWS) expect(serviceCompactPoint("builtin", contextWindow)).toBe(serviceCompactLimit({}, { contextWindow }));
  expect(serviceCompactPoint("builtin", 1_048_576)).toBe(250_000);
});

test("OpenCode's buffer puts its compaction where the app says", () => {
  for (const contextWindow of WINDOWS) {
    const { compaction } = openCodeConfig({ endpoint: { ...endpoint, contextWindow }, model: "m", mode: "full", efforts: [], instructions: [], crosstalk: null, browser: null });
    expect(serviceCompactPoint("opencode", contextWindow)).toBe(contextWindow - compaction.buffer);
  }
});

test("no window known, or an agent that says for itself: the app doesn't claim a point", () => {
  expect(serviceCompactPoint("opencode", null)).toBeNull();
  expect(serviceCompactPoint("builtin", undefined)).toBeNull();
  expect(serviceCompactPoint("claude", 1_048_576)).toBeNull();
  expect(serviceCompactPoint("codex", 1_048_576)).toBeNull();
  // Too small to keep OpenCode's buffer free: it goes by its own default.
  expect(serviceCompactPoint("opencode", 16_000)).toBeNull();
});
