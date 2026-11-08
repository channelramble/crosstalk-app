import { expect, test } from "bun:test";
import { HELP, JARGON_WORDS, jargonIn } from "./helpCopy";

const tips = Object.entries(HELP);

test("there is a tip for every heading and setting the first-run brief names", () => {
  expect(Object.keys(HELP).sort()).toEqual(["computers", "helpers", "machines", "modelPool", "permissions", "storage", "teamwork", "templates", "thisMac", "usage"]);
});

test("each tip is one short sentence", () => {
  for (const [topic, { text }] of tips) {
    expect(text.length, `${topic} is too long for a phone`).toBeLessThanOrEqual(110);
    expect(text.length, `${topic} says too little`).toBeGreaterThanOrEqual(40);
    expect(text, `${topic} starts with a capital letter and ends with a full stop`).toMatch(/^[A-Z][^]*\.$/);
    // Only the last full stop ends a sentence ("e.g." or a second sentence would show up here).
    expect(text.match(/[.!?](\s|$)/g)?.length, `${topic} is more than one sentence`).toBe(1);
    expect(text, `${topic} has a double space or a line break`).not.toMatch(/\s{2}|\n/);
  }
});

test("no tip uses a technical word", () => {
  for (const [topic, { text, label }] of tips) {
    expect(jargonIn(text), `${topic}: ${text}`).toBeNull();
    expect(jargonIn(label), `${topic} label: ${label}`).toBeNull();
  }
});

test("the jargon check finds whole words only, in any case", () => {
  expect(jargonIn("Needs an API key.")).toBe("api");
  expect(jargonIn("Runs on the GPUs of your PCs.")).toBe("gpu");
  expect(jargonIn("Clears the cache.")).toBe("cache");
  expect(jargonIn("Therapies and capital letters are fine.")).toBeNull();
  expect(JARGON_WORDS.length).toBeGreaterThan(10);
});

test("each button label asks a question and no two tips repeat each other", () => {
  for (const [topic, { label }] of tips) expect(label, topic).toMatch(/^What.*\?$/);
  expect(new Set(tips.map(([, t]) => t.text)).size).toBe(tips.length);
  expect(new Set(tips.map(([, t]) => t.label)).size).toBe(tips.length);
});
