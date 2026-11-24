import { expect, test } from "bun:test";
import type { Member, ModelOption } from "@crosstalk/shared";
import { agentLine, agentSections, asDefaults, chipWords, effortHint, foldKey, hasDefaults, heldLine, memoryWords, modelWord, openAt, sheetSections, startsLikeThis, whenWords } from "./chatSettings";

const OPUS = { id: "opus", resolvedModel: "claude-opus-5-5", label: "Opus 5.5", isDefault: true, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: null } as unknown as ModelOption;
const HAIKU = { id: "haiku", resolvedModel: "claude-haiku-4-5", label: "Haiku 4.5", isDefault: false, efforts: [], defaultEffort: null } as unknown as ModelOption;
const GPT = { id: "gpt-5.5", label: "GPT-5.5", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" } as unknown as ModelOption;
const member = (m: Partial<Member> = {}) => ({ id: "m1", roomId: "r1", handle: "claude", provider: "claude", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: 1, position: 0, ...m }) as Member;

test("the chips say the model and effort in force, and what the agent may do", () => {
  expect(chipWords(member(), [OPUS, HAIKU], OPUS)).toEqual({ answers: "Opus 5.5", may: "Asks first", danger: false });
  expect(chipWords(member({ model: "claude-opus-5-5", config: { effort: "xhigh" } }), [OPUS, HAIKU], OPUS).answers).toBe("Opus 5.5 · Extra");
  // An effort the model doesn't take isn't in force: the chip doesn't claim it.
  expect(chipWords(member({ model: "haiku", config: { effort: "high" } }), [OPUS, HAIKU], HAIKU).answers).toBe("Haiku 4.5");
  // Codex says what its model's own level is, so the chip can too.
  expect(chipWords(member({ provider: "codex", permissionMode: "full" }), [GPT], GPT)).toEqual({ answers: "GPT-5.5 · Medium", may: "Full access", danger: true });
});

test("a model is called what its agent's list calls it, by either of its names", () => {
  expect(modelWord(member({ model: "opus" }), [OPUS])).toBe("Opus 5.5");
  expect(modelWord(member({ model: "opus", resolvedModel: "claude-opus-5-5[1m]" }), [OPUS])).toBe("Opus 5.5");
  expect(modelWord(member({ model: "typed-by-hand" }), [OPUS])).toBe("typed-by-hand");
  expect(modelWord(member(), [])).toBe("Default model");
});

test("which sections a chat has", () => {
  expect(sheetSections(false, "claude")).toEqual(["answers", "may", "helpers", "memory", "chat"]);
  // An agent with no helpers of its own has no Helpers section.
  expect(sheetSections(false, "opencode")).toEqual(["answers", "may", "memory", "chat"]);
  // A group chat: its own section first, then each agent's block (agentSections), then the chat's.
  expect(sheetSections(true, null)).toEqual(["group", "chat"]);
  expect(agentSections("codex", true)).toEqual(["answers", "may", "helpers", "memory", "agent"]);
});

test("the sheet opens at the section a chip names, inside its agent's block in a group chat", () => {
  expect(openAt(null, false)).toEqual([]);
  expect(openAt({ section: "may", memberId: "m1" }, false)).toEqual(["m1:may"]);
  expect(openAt({ section: "may", memberId: "m1" }, true)).toEqual(["agent:m1", "m1:may"]);
  expect(openAt({ memberId: "m1" }, true)).toEqual(["agent:m1"]);
  expect(openAt({ section: "chat" }, true)).toEqual(["chat"]);
  expect(foldKey("chat", "m1")).toBe("chat");
});

test("what will happen is said before the choice: next reply, after this reply, or a fresh start", () => {
  expect(whenWords("settings", member(), "Claude Code")).toBe("A change applies from Claude Code's next reply. The chat carries on as it is.");
  expect(whenWords("permissions", member(), "Codex")).toBe("A change applies from Codex's next reply.");
  expect(whenWords("settings", member({ status: "working" }), "Claude Code")).toBe("Claude Code is replying now. A change here applies once this reply ends.");
  expect(whenWords("account", member(), "Claude Code")).toBe("Switching accounts starts Claude Code fresh: it forgets what was said so far. The messages stay.");
  expect(whenWords("account", member({ status: "thinking" }), "Claude Code")).toEndWith("It happens once Claude Code finishes this reply.");
});

test("a change that waits says what it waits for", () => {
  expect(heldLine(member(), "Claude Code")).toBeNull();
  expect(heldLine(member({ held: { change: "settings", helpers: true } }), "Claude Code")).toBe("Your new settings apply once Claude Code finishes its helpers.");
  expect(heldLine(member({ held: { change: "account", helpers: false } }), "Codex")).toBe("Your account switch applies once Codex finishes this reply.");
});

test("new chats can start like this one, unless they already do", () => {
  const m = member({ model: "claude-opus-5-5", permissionMode: "edits", config: { effort: "high", account: "work", fast: true } });
  expect(asDefaults(m)).toEqual({ permissionMode: "edits", model: "claude-opus-5-5", effort: "high", helperModel: null, account: "work" });
  expect(startsLikeThis(m, asDefaults(m))).toBe(true);
  expect(startsLikeThis(m, { permissionMode: "ask", model: null, effort: null })).toBe(false);
  // Nothing saved yet is the agent's own defaults, which a chat nobody changed already runs on.
  expect(startsLikeThis(member(), undefined)).toBe(true);
  expect(hasDefaults("claude", false)).toBe(true);
  expect(hasDefaults("claude", true)).toBe(false);
  expect(hasDefaults("opencode", false)).toBe(false);
});

test("effort hints, memory and an agent's line", () => {
  expect(effortHint(["low", "high"], "", "Claude Code")).toBe("Claude Code picks how hard to think for each reply.");
  expect(effortHint(["low", "medium", "high"], "low", "Codex")).toStartWith("The quickest replies");
  expect(effortHint(["low", "medium", "high"], "high", "Codex")).toStartWith("Thinks the longest");
  expect(memoryWords(null, 200_000)).toEqual({ pct: null, words: "Shown after the next reply" });
  expect(memoryWords(50_000, 200_000)).toEqual({ pct: 25, words: "25% full" });
  expect(agentLine(member({ model: "haiku", permissionMode: "edits", config: { effort: "low" } }), [OPUS, HAIKU], "Work")).toBe("Claude Code · Work · Haiku 4.5 · Low · Can edit");
});
