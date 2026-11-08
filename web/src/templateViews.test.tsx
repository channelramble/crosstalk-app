// What Settings → Templates and New chat → From a template show (views/TemplatesSection.tsx, views/TemplatePick.tsx), drawn
// as HTML: the list and its controls' names, an older machine's note, the template menu with machines' names, blanks to fill
// in, and why a template can't be picked.
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PromptTemplate, ProviderStatus } from "@crosstalk/shared";

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

/** The words on screen: tags stripped, entities read. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const AT = 1_800_000_000_000;
const template = (id: string, name: string, over: Partial<PromptTemplate> = {}): PromptTemplate => ({ id, name, agent: null, account: null, model: null, effort: null, folder: null, text: `${name}.`, createdAt: AT, updatedAt: AT, ...over });
const status = (provider: string, signedIn: boolean) => ({ provider, installed: true, signedIn, version: "test", binPath: null, account: null, plan: null, authMethod: null, error: null, checkedAt: AT }) as ProviderStatus;
/** A machine as New chat sees it (store.ts Machine), with its templates. */
const machine = (key: string, name: string, templates: PromptTemplate[] | null, signedIn: string[] = ["claude", "codex"]) =>
  ({ key, name, conn: { baseUrl: key, token: "t", deviceName: "Phone" }, status: "open", syncing: false, downSince: null, loadedAt: AT, hub: null, rooms: {}, members: {}, approvals: {}, roomActivity: {}, storage: null, accounts: {}, providers: Object.fromEntries(["claude", "codex"].map((p) => [p, status(p, signedIn.includes(p))])), macDialogs: [], templates }) as never;

const { TemplatePick } = await import("./views/TemplatePick");
const { TemplatesList } = await import("./views/TemplatesSection");
const { templateGroups } = await import("./templates");

const pick = (machines: never[], props: Partial<Parameters<typeof TemplatePick>[0]> = {}) =>
  renderToStaticMarkup(createElement(TemplatePick, { groups: templateGroups(machines), several: machines.length > 1, picked: null, onPick() {}, message: "", onMessage() {}, values: {}, onValues() {}, ...props }));

test("New chat lists the machine's templates after None; nothing about blanks until one is picked", () => {
  const html = pick([machine("", "Mac mini", [template("a", "Fix a bug"), template("b", "Plan it first")])]);
  expect(html).toContain('aria-label="From a template"');
  expect(html).not.toContain("<optgroup");
  expect([...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]])).toEqual([
    ["", "None"],
    ["\na", "Fix a bug"],
    ["\nb", "Plan it first"],
  ]);
  expect(html).not.toContain("Fill in the blanks");
  expect(html).not.toContain("First message");
});

test("with several machines, each template is under its machine's name; one for an agent not signed in there can't be picked", () => {
  const mac = machine("", "Mac mini", [template("a", "Fix a bug")]);
  const linux = machine("http://linux:7420", "Linux box", [template("c", "Deploy", { agent: "codex" }), template("d", "Notes")], ["claude"]);
  const html = pick([mac, linux, machine("http://old:7420", "Old box", null)]);
  expect([...html.matchAll(/<optgroup label="([^"]+)">/g)].map((m) => m[1])).toEqual(["Mac mini", "Linux box"]);
  expect(html).toMatch(/<option value="http:\/\/linux:7420\nc" disabled="">Deploy \(Codex isn&#x27;t signed in there\)<\/option>/);
  expect(html).toMatch(/<option value="http:\/\/linux:7420\nd">Notes<\/option>/);
  // A machine from before templates lists nothing.
  expect(html).not.toContain("Old box");
});

test("a picked template asks for its blanks, says what it sets and whose it is, and shows the first message to send", () => {
  const t = template("c", "Release", { agent: "codex", model: "gpt-5.5", text: "Write notes for {version}, for {who}." });
  const machines = [machine("", "Mac mini", []), machine("http://linux:7420", "Linux box", [t])];
  const picked = { machine: "http://linux:7420", template: t };
  let html = pick(machines, { picked, message: t.text, values: { version: "2.1" } });
  expect(html).toMatch(/<option value="http:\/\/linux:7420\nc" selected="">Release<\/option>/);
  expect(words(html)).toContain("Codex · gpt-5.5 · from Linux box");
  expect(html).toContain("<legend>Fill in the blanks</legend>");
  expect(words(html)).toContain("Version");
  expect(words(html)).toContain("Who");
  expect(html).toContain('value="2.1"');
  expect(words(html)).toContain("Fill in each one to start the chat.");
  expect(html).toContain('aria-label="First message"');
  expect(html).toContain("Write notes for {version}, for {who}.</textarea>");
  // All filled in: nothing left to say.
  html = pick(machines, { picked, message: t.text, values: { version: "2.1", who: "the team" } });
  expect(html).not.toContain("Fill in each one");
  // No blanks, and nothing else it sets on one machine: just the message.
  const plain = template("a", "Review", { text: "Review my changes." });
  html = pick([machine("", "Mac mini", [plain])], { picked: { machine: "", template: plain }, message: plain.text });
  expect(html).not.toContain("Fill in the blanks");
  expect(words(html)).toContain("Sent when the chat starts. Leave it empty to write your own.");
  expect(words(html)).not.toContain("Any agent");
});

test("blanks named like an object's own names are asked for, empty until typed in", () => {
  const t = template("c", "Tests", { text: "Write tests for the {constructor} of {class}, and its {toString}." });
  const machines = [machine("", "Mac mini", [t])];
  const picked = { machine: "", template: t };
  const boxes = (html: string) => [...html.matchAll(/<input class="input"[^>]*? value="([^"]*)"/g)].map((m) => m[1]);
  let html = pick(machines, { picked, message: t.text });
  expect(words(html)).toContain("Fill in the blanks Constructor Class ToString Fill in each one to start the chat.");
  expect(boxes(html)).toEqual(["", "", ""]);
  html = pick(machines, { picked, message: t.text, values: { constructor: "parser", class: "Lexer", toString: "output" } });
  expect(boxes(html)).toEqual(["parser", "Lexer", "output"]);
  expect(words(html)).not.toContain("Fill in each one");
});

test("a picked template says what of it isn't used where New chat is", () => {
  const t = template("c", "Deploy", { agent: "codex", model: "gpt-linux" });
  const machines = [machine("", "Mac mini", []), machine("http://linux:7420", "Linux box", [t])];
  const picked = { machine: "http://linux:7420", template: t };
  expect(words(pick(machines, { picked, message: t.text, note: "Its model is for Linux box, so yours is used here." }))).toContain("Codex · gpt-linux · from Linux box Its model is for Linux box, so yours is used here.");
  expect(words(pick(machines, { picked, message: t.text }))).not.toContain("yours");
});

test("a template deleted on another device while it's picked stays picked, the last one too", () => {
  const t = template("x", "Gone");
  let html = pick([machine("", "Mac mini", [template("a", "Other")])], { picked: { machine: "", template: t }, message: t.text });
  expect(html).toMatch(/<option value="\nx" selected="">Gone<\/option>/);
  html = pick([machine("", "Mac mini", [])], { picked: { machine: "", template: t }, message: t.text });
  expect([...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => m[2])).toEqual(["None", "Gone"]);
  expect(html).toContain('aria-label="First message"');
});

const settings = (templates: PromptTemplate[] | null, opts: { loaded?: boolean; several?: boolean } = {}) =>
  renderToStaticMarkup(createElement(TemplatesList, { templates, loaded: opts.loaded ?? true, machine: "Mac mini", several: !!opts.several, target: { key: "", name: "Mac mini", conn: { baseUrl: "", token: "t", deviceName: "Phone" } } }));

test("Settings lists the templates with Edit and options for each, and what each sets", () => {
  const html = settings([template("a", "Fix a bug", { starter: "bug" }), template("b", "Deploy", { agent: "codex", effort: "high", folder: "/Users/me/site", text: "Deploy\n\nthe site {when}." })]);
  expect(html).toContain('id="templates"');
  expect(words(html)).toContain("Templates");
  expect(html).toContain('aria-label="What are templates?"');
  expect(words(html)).toContain("Add a template");
  expect(html).toContain('aria-label="Templates on Mac mini"');
  for (const name of ["Fix a bug", "Deploy"]) {
    expect(html).toContain(`aria-label="Edit ${name}"`);
    expect(html).toMatch(new RegExp(`aria-label="Options for ${name}" title="Options" aria-expanded="false"`));
  }
  expect(words(html)).toContain("Deploy Codex · High · in site Deploy the site {when}.");
  // Two starters were deleted: they can be added back.
  expect(words(html)).toContain("Add the deleted starter templates back");
  // One machine: no word about others.
  expect(words(html)).not.toContain("each machine keeps its own");
});

test("Settings says whose templates they are when there are several machines, and when there are none", () => {
  const html = settings([], { several: true });
  expect(words(html)).toContain("These are on Mac mini: each machine keeps its own.");
  expect(words(html)).toContain("No templates on Mac mini yet.");
  expect(words(html)).toContain("Add the starter templates");
});

test("a machine from before templates says to update it; one still loading says so", () => {
  let html = settings(null);
  expect(words(html)).toContain("Update Crosstalk on Mac mini to keep templates there.");
  expect(words(html)).toContain("Check again");
  expect(words(html)).not.toContain("Add a template");
  html = settings(null, { loaded: false });
  expect(words(html)).toContain("Loading templates…");
  expect(words(html)).not.toContain("Update Crosstalk");
});
