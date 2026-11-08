// Prompt templates in the app (templates.ts): the blanks a first message asks for, filling them in, what a template sets on
// New chat, its row's words, and what a failed change says.
import { expect, test } from "bun:test";
import type { PromptTemplate } from "@crosstalk/shared";
import { ApiError } from "./api";
import { blankLabel, blankValue, blanksIn, changedInput, emptyBlanks, fillBlanks, olderHub, parsePick, pickValue, pieces, templateGroups, templateLine, templateNote, templatePreview, templateProblem, withTemplate } from "./templates";

const AT = 1_800_000_000_000;
const template = (over: Partial<PromptTemplate> = {}): PromptTemplate => ({ id: "tp_1", name: "Fix a bug", agent: null, account: null, model: null, effort: null, folder: null, text: "Hi", createdAt: AT, updatedAt: AT, ...over });

test("blanks are a few plain words in braces, each asked for once, in the order they come", () => {
  expect(blanksIn("Something isn't working: {what goes wrong}. It should {what should happen}.")).toEqual(["what goes wrong", "what should happen"]);
  // The same blank twice is one field; spaces inside the braces don't count.
  expect(blanksIn("Compare {a} with {b}, then {a} again, and { b }.")).toEqual(["a", "b"]);
  // Other tools' double braces are blanks too.
  expect(blanksIn("Review {{pull request}} for {{focus}}.")).toEqual(["pull request", "focus"]);
  // A little punctuation is fine, in any language.
  expect(blanksIn("{what's wrong?} {fix/change} {Größe} {page 2}")).toEqual(["what's wrong?", "fix/change", "Größe", "page 2"]);
  expect(blanksIn("No blanks here.")).toEqual([]);
});

test("code, and anything code-like in braces, is never a blank", () => {
  expect(blanksIn('Send {"name": 1} as the body.')).toEqual([]);
  expect(blanksIn("const s = `${name}`; and in Ruby #{name}, or %{name}")).toEqual([]);
  expect(blanksIn("Run `echo {file}` in {folder}.")).toEqual(["folder"]);
  expect(blanksIn("Fix this:\n```js\nfunction f() { return {x}; }\n```\nin {file}")).toEqual(["file"]);
  // A fence that never closes runs to the end.
  expect(blanksIn("{first}\n```\n{not this}")).toEqual(["first"]);
  // Too long, over two lines, empty, or starting with a symbol: text in braces.
  expect(blanksIn(`{${"a".repeat(41)}} {a\nb} {} {   } {-x} {a(b)} {a=b} {a;b} {<a>} {[a]}`)).toEqual([]);
  expect(blanksIn(`{${"a".repeat(40)}}`)).toEqual(["a".repeat(40)]);
  // A brace that never closes leaves the rest alone.
  expect(blanksIn("{open and {closed}")).toEqual(["closed"]);
});

test("filling in puts each value where its blank was, trimmed, and leaves the rest exactly as written", () => {
  const text = "Something isn't working: {what goes wrong}. It should {what should happen}. Again: {what goes wrong}.";
  expect(fillBlanks(text, { "what goes wrong": "  the login page is blank ", "what should happen": "show the form" })).toBe("Something isn't working: the login page is blank. It should show the form. Again: the login page is blank.");
  // A blank left empty stays as written, so nothing is lost.
  expect(fillBlanks(text, { "what goes wrong": "it crashes", "what should happen": "   " })).toBe("Something isn't working: it crashes. It should {what should happen}. Again: it crashes.");
  expect(fillBlanks("Review {{pr}} now", { pr: "#42" })).toBe("Review #42 now");
  // Code and code-like braces come through untouched, line breaks and all.
  const code = "Fix:\n```\nif (a) { b(); }\n```\nand `{x}` in {file}, ${y} too\n";
  expect(fillBlanks(code, { file: "app.ts", x: "no" })).toBe("Fix:\n```\nif (a) { b(); }\n```\nand `{x}` in app.ts, ${y} too\n");
  // Every piece put back together is the text.
  for (const t of [text, code, "{{a}", "{a}}", "{{a}}}", "{ {a} }", "a{b}c{d", "```{x}"]) expect(pieces(t).map((p) => ("blank" in p ? p.raw : p.text)).join("")).toBe(t);
});

test("New chat can start once every blank is filled in", () => {
  const text = "Plan {what} for {who}.";
  expect(emptyBlanks(text, {})).toEqual(["what", "who"]);
  expect(emptyBlanks(text, { what: "a site", who: " " })).toEqual(["who"]);
  expect(emptyBlanks(text, { what: "a site", who: "me", other: "" })).toEqual([]);
  expect(blankLabel("what goes wrong")).toBe("What goes wrong");
  expect(blankLabel("élan")).toBe("Élan");
});

test("a blank named like one of an object's own names is a blank like any other", () => {
  const text = "Write tests for the {constructor} of {class}, its {toString}, {valueOf} and {hasOwnProperty}, and {__proto__}.";
  const names = ["constructor", "class", "toString", "valueOf", "hasOwnProperty"];
  // "__proto__" starts with a symbol: text in braces.
  expect(blanksIn(text)).toEqual(names);
  // Nothing typed yet: each one is empty, and stays as written.
  expect(emptyBlanks(text, {})).toEqual(names);
  expect(fillBlanks(text, {})).toBe(text);
  expect(blankValue({}, "toString")).toBe("");
  // Typed in, as New chat keeps them (a copy of the values with the one typed).
  const values = names.reduce<Record<string, string>>((v, b) => ({ ...v, [b]: `my ${b}` }), {});
  expect(emptyBlanks(text, values)).toEqual([]);
  expect(fillBlanks(text, values)).toBe("Write tests for the my constructor of my class, its my toString, my valueOf and my hasOwnProperty, and {__proto__}.");
  expect(blankValue(values, "constructor")).toBe("my constructor");
});

test("a template's row says what it sets, in a few words", () => {
  expect(templateLine(template())).toBe("Any agent");
  expect(templateLine(template({ agent: "codex", model: "gpt-5.5", effort: "xhigh", folder: "/Users/me/Projects/site/" }))).toBe("Codex · gpt-5.5 · Extra high · in site");
  expect(templateLine(template({ agent: "claude", effort: "weird" }))).toBe("Claude Code · weird");
  // A folder without an agent; a model without one is never shown (the hub doesn't keep it).
  expect(templateLine(template({ folder: "~/notes", model: "x" }))).toBe("Any agent · in notes");
  expect(templatePreview("  Line one\n\nline   two ")).toBe("Line one line two");
  expect(templatePreview("a".repeat(130))).toBe(`${"a".repeat(119)}…`);
});

test("a template sets New chat's account, model and effort only as far as they fit there", () => {
  const base = { account: "default", model: "claude-opus-5-5", effort: "high", permissionMode: "ask" as const, helperModel: "claude-sonnet-5" };
  const here = { ownMachine: true, hasAccount: (id: string) => id === "work", mainReady: true };
  // No agent: nothing of New chat's changes.
  expect(withTemplate(template({ model: "x" }), base, here)).toBe(base);
  // Only a model: on the account New chat has, effort kept.
  expect(withTemplate(template({ agent: "claude", model: "claude-sonnet-5" }), base, here)).toEqual({ ...base, model: "claude-sonnet-5" });
  // Only an effort.
  expect(withTemplate(template({ agent: "claude", effort: "low" }), base, here)).toEqual({ ...base, effort: "low" });
  // An agent and nothing else: what New chat has.
  expect(withTemplate(template({ agent: "claude" }), base, here)).toEqual(base);
  // Its own account, on its own machine: that account, and the base's choices for the other account go.
  expect(withTemplate(template({ agent: "claude", account: "work" }), base, here)).toEqual({ ...base, account: "work", model: "", effort: "", helperModel: "" });
  expect(withTemplate(template({ agent: "claude", account: "work", model: "m", effort: "low" }), base, here)).toEqual({ ...base, account: "work", model: "m", effort: "low", helperModel: "" });
  // Once its account is gone, a model goes with the main sign-in, whose list it came from…
  const onApiKey = { ...base, account: "api" };
  expect(withTemplate(template({ agent: "claude", account: "gone", model: "m" }), onApiKey, here)).toEqual({ ...onApiKey, account: "default", model: "m", effort: "", helperModel: "" });
  // …and without a model, New chat's own account and model stay: an effort alone doesn't need another account.
  expect(withTemplate(template({ agent: "claude", account: "gone" }), onApiKey, here)).toEqual(onApiKey);
  expect(withTemplate(template({ agent: "claude", effort: "low" }), onApiKey, here)).toEqual({ ...onApiKey, effort: "low" });
  // The main sign-in isn't signed in: a chat there couldn't answer, so yours stay, with the template's effort.
  const signedOut = { ...here, mainReady: false };
  expect(withTemplate(template({ agent: "claude", model: "m", effort: "low" }), onApiKey, signedOut)).toEqual({ ...onApiKey, effort: "low" });
  expect(withTemplate(template({ agent: "claude", account: "work", model: "m" }), onApiKey, signedOut)).toMatchObject({ account: "work", model: "m" });
  // On another machine, its account and model are that machine's: yours stay, with its effort.
  const elsewhere = { ...here, ownMachine: false };
  expect(withTemplate(template({ agent: "claude", account: "work", model: "m" }), onApiKey, elsewhere)).toEqual(onApiKey);
  expect(withTemplate(template({ agent: "claude", model: "m", effort: "low" }), base, elsewhere)).toEqual({ ...base, effort: "low" });
  // New chat without helper models (none to clear).
  const plain = { account: "api", model: "a", effort: "b" };
  expect(withTemplate(template({ agent: "codex", model: "gpt-5.5" }), plain, here)).toEqual({ account: "default", model: "gpt-5.5", effort: "" });
});

test("New chat says what of a picked template it doesn't use, and why", () => {
  const here = { ownMachine: true, hasAccount: (id: string) => id === "work", mainReady: true };
  const deploy = template({ agent: "codex", model: "gpt-linux", folder: "/home/me/site" });
  // All of it is used: nothing to say.
  expect(templateNote(deploy, here, "Linux box")).toBeNull();
  expect(templateNote(template(), { ...here, ownMachine: false }, "Linux box")).toBeNull();
  // On another machine.
  expect(templateNote(deploy, { ...here, ownMachine: false }, "Linux box")).toBe("Its model and folder are for Linux box, so yours are used here.");
  expect(templateNote(template({ agent: "codex", model: "gpt-linux" }), { ...here, ownMachine: false }, "Linux box")).toBe("Its model is for Linux box, so yours is used here.");
  expect(templateNote(template({ folder: "/home/me/site" }), { ...here, ownMachine: false }, "Linux box")).toBe("Its folder is for Linux box, so yours is used here.");
  // Its model needs the main sign-in, which isn't signed in; with its own account, it doesn't.
  expect(templateNote(deploy, { ...here, mainReady: false }, "Mac mini")).toBe("Its model is for Codex's main sign-in, which isn't signed in here, so yours is used.");
  expect(templateNote(template({ agent: "codex", account: "work", model: "m" }), { ...here, mainReady: false }, "Mac mini")).toBeNull();
});

test("an edit saves only what it changed; the agent goes with its account, model and effort", () => {
  const saved = { name: "Deploy", text: "Deploy {branch}.", agent: "codex" as const, account: "work", model: "gpt-5.5", effort: "high", folder: "/srv/site" };
  expect(changedInput(saved, { ...saved })).toEqual({});
  // Another device renamed it meanwhile: a change to the message alone leaves the name as that device made it.
  expect(changedInput(saved, { ...saved, text: "Deploy {branch} now." })).toEqual({ text: "Deploy {branch} now." });
  expect(changedInput(saved, { ...saved, folder: null, name: "Ship" })).toEqual({ name: "Ship", folder: null });
  // What runs it goes whole, so a model is never kept on an agent another device picked meanwhile.
  expect(changedInput(saved, { ...saved, model: "gpt-5.5-mini" })).toEqual({ agent: "codex", account: "work", model: "gpt-5.5-mini", effort: "high" });
  expect(changedInput(saved, { ...saved, agent: null, account: null, model: null, effort: null })).toEqual({ agent: null, account: null, model: null, effort: null });
});

test("a change that didn't happen says why: an older Crosstalk, a machine out of reach, or the hub's own words", () => {
  expect(templateProblem(new ApiError(404, "not found"), "Linux box")).toEqual({ why: "older", text: "Update Crosstalk on Linux box to keep templates there." });
  expect(olderHub("Mac mini")).toBe("Update Crosstalk on Mac mini to keep templates there.");
  expect(templateProblem(new ApiError(0, "Can't reach the hub."), "Linux box")).toEqual({ why: "down", text: "Can't reach Linux box. Try again when it's back." });
  const gone = "That template is gone. It may have been deleted on another device.";
  expect(templateProblem(new ApiError(404, gone, "no_template"), "Mac mini")).toEqual({ why: "other", text: gone });
  expect(templateProblem(new ApiError(401, "unauthorized"), "Linux box").text).toBe("This device was signed out of Linux box. Add it again in Settings → Machines.");
  expect(templateProblem(new ApiError(400, "Give the template a name."), "Mac mini")).toEqual({ why: "other", text: "Give the template a name." });
  expect(templateProblem("odd", "Mac mini")).toEqual({ why: "other", text: "odd" });
});

test("New chat lists each machine's templates under it, and leaves out machines without any", () => {
  const mac = { key: "", name: "Mac mini", templates: [template({ id: "a" }), template({ id: "b" })] };
  const older = { key: "http://old:7420", name: "Old box", templates: null };
  const empty = { key: "http://pc:7420", name: "PC", templates: [] };
  const linux = { key: "http://linux:7420", name: "Linux box", templates: [template({ id: "c" })] };
  expect(templateGroups([mac, older, empty, linux]).map((g) => [g.machine.name, g.templates.map((t) => t.id)])).toEqual([
    ["Mac mini", ["a", "b"]],
    ["Linux box", ["c"]],
  ]);
  expect(templateGroups([older, empty])).toEqual([]);
  // A pick names its machine and template, the home machine (key "") included.
  for (const [key, id] of [["", "tp_1"], ["http://linux:7420", "tp_2"], ["https://mac.tail.ts.net", "tp_x"]]) expect(parsePick(pickValue(key, id))).toEqual({ machineKey: key, id });
  expect(parsePick("")).toBeNull();
});
