import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Approval, Member } from "@crosstalk/shared";

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

const member: Member = { id: "m1", roomId: "r1", handle: "codex", provider: "codex", model: null, role: "", permissionMode: "ask", status: "working", statusDetail: null, config: {}, createdAt: 0, position: 0 };
const qid = JSON.stringify(["request_user_input_async", "call_1", 0]);
const card = (patch: Partial<Approval>): Approval => ({
  id: "ap1",
  roomId: "r1",
  memberId: "m1",
  turnId: "t1",
  kind: "question",
  title: "Ship it?",
  detail: "",
  status: "pending",
  decision: null,
  decidedBy: null,
  createdAt: 0,
  decidedAt: null,
  questions: [{ id: qid, header: "", question: "Ship it?", options: ["Yes", "No", "Not sure"].map((label) => ({ label, description: "" })), multiSelect: false, allowOther: true, preselected: "Yes" }],
  answers: null,
  ...patch,
});

test("a question Codex asked without waiting: says it keeps working, starts on the recommended answer, sendable at once", async () => {
  const { ApprovalCard } = await import("./views/ApprovalCard");
  const html = renderToStaticMarkup(createElement(ApprovalCard, { approval: card({ delivery: "async" }), member }));
  expect(words(html)).toContain("Codex keeps working. Your answer goes to it as a message.");
  // "Yes" starts picked; the others don't.
  expect(html).toMatch(/aria-checked="true"[^>]*>(?:(?!<button).)*Yes/);
  expect((html.match(/aria-checked="true"/g) ?? []).length).toBe(1);
  expect(html).toMatch(/<button class="btn small primary"[^>]*>Send answer<\/button>/);
  expect(html).not.toMatch(/<button class="btn small primary" disabled/);
  expect(html).not.toContain("goes on without an answer");
});

test("a question Codex can go on without counts down; one it waits for doesn't; closed cards say what they came to", async () => {
  const { ApprovalCard } = await import("./views/ApprovalCard");
  const plain = card({ questions: [{ ...card({}).questions![0], id: "ship", preselected: undefined }] });
  const timed = renderToStaticMarkup(createElement(ApprovalCard, { approval: { ...plain, autoResolveAt: Date.now() + 90_500 }, member }));
  expect(words(timed)).toMatch(/Codex goes on without an answer in 1:3\d unless you start answering\./);
  // Nothing picked yet: it can't be sent empty.
  expect(timed).toMatch(/<button class="btn small primary" disabled/);
  // Before any device has shown it, no time is running yet.
  const unseen = renderToStaticMarkup(createElement(ApprovalCard, { approval: { ...plain, autoResolveMs: 120_000 }, member }));
  expect(unseen).not.toContain("goes on without an answer");
  const waits = renderToStaticMarkup(createElement(ApprovalCard, { approval: plain, member }));
  expect(waits).not.toContain("goes on without an answer");
  expect(waits).not.toContain("keeps working");
  expect(words(renderToStaticMarkup(createElement(ApprovalCard, { approval: card({ delivery: "async", status: "expired", decidedAt: 5 }), member })))).toContain("closed");
  expect(words(renderToStaticMarkup(createElement(ApprovalCard, { approval: card({ status: "expired", autoResolveAt: 1000, decidedAt: 1001 }), member })))).toContain("timed out");
  const answered = words(renderToStaticMarkup(createElement(ApprovalCard, { approval: card({ delivery: "async", status: "approved", decidedBy: "Phone", answers: { [qid]: ["No"] } }), member })));
  expect(answered).toContain("answered · Phone");
  expect(answered).toContain("No");
});
