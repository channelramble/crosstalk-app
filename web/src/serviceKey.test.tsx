import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { serviceKeyWords, signInNeededWords, type Member, type Message, type Turn } from "@crosstalk/shared";

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { OpenAiServices } = await import("./views/ServiceKey");
const { MessageRow } = await import("./views/RoomView");

// A reply Crosstalk's own agent or OpenCode couldn't get because the service refused its key: the reply says so in plain
// words, with Open AI services as the way there — never a Sign in, which they don't have (hub/test/builtin-signin.test.ts).

const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const NOW = Date.UTC(2026, 10, 1, 9, 40, 0);
const REFUSED = serviceKeyWords("NanoGPT");

test("Open AI services goes beside Try again on a refused key, and on nothing else", () => {
  const draw = (error: string | null | undefined) => renderToStaticMarkup(createElement(OpenAiServices, { error }));
  for (const error of [REFUSED, `⚠️ ${REFUSED}`, serviceKeyWords("NanoGPT", true)]) {
    const html = draw(error);
    expect(words(html)).toBe("Open AI services");
    expect(html).toContain('<button type="button" class="link-action open-ai-services"');
    // The icon is decoration: the button is named by its words alone.
    expect(html).toContain('aria-hidden="true"');
  }
  for (const error of [signInNeededWords({ provider: "claude", account: "default" }, "Mac mini"), "NanoGPT had a problem (error 503). Wait a minute, then tap Try again.", "", null, undefined]) expect(draw(error)).toBe("");
});

for (const [provider, service] of [["builtin", "NanoGPT"], ["opencode", "Refuseless"]] as const) {
  test(`its failed reply says the key in plain words once, and offers no sign-in (${provider}, on ${service})`, () => {
    const refused = serviceKeyWords(service);
    const member = { id: "mb1", roomId: "r1", handle: "agent", provider, model: "deepseek/deepseek-v4.1-flash-uncensored", role: "", permissionMode: "full", status: "error", statusDetail: refused, config: { account: "nano1" }, createdAt: 0, position: 0 } as Member;
    const turn: Turn = { id: "t1", roomId: "r1", memberId: "mb1", triggerMessageId: "m1", replyMessageId: "m2", hop: 0, chainId: "c1", status: "error", error: refused, usage: null, createdAt: NOW, startedAt: NOW, endedAt: NOW };
    const reply: Message = { id: "m2", roomId: "r1", authorKind: "agent", memberId: "mb1", authorName: "agent", text: `⚠️ ${refused}`, mentions: [], turnId: "t1", status: "error", createdAt: NOW, updatedAt: NOW };
    const html = renderToStaticMarkup(createElement(MessageRow, { message: reply, member, handles: ["agent"], turn, statusKnown: true, announce: true }));
    expect(words(html).split(`${service} refused the key`).length - 1).toBe(1);
    expect(words(html)).toContain("check it in Settings → AI services, then tap Try again.");
    expect(html).not.toContain("signin-prompt");
    expect(words(html)).not.toMatch(/\bSign in\b/);
  });
}
