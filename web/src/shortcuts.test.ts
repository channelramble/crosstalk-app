import { expect, test } from "bun:test";
import { shortcutOf } from "./shortcuts";
import { SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_WIDTH, sidebarWidth } from "./sidebar";
import { nameAsTooltip } from "./tooltips";

const key = (k: Partial<Parameters<typeof shortcutOf>[0]>) => shortcutOf({ key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...k });

test("Ctrl+K and ⌘K search the chats, Alt+N starts one, and nothing else is taken from the keyboard", () => {
  expect(key({ key: "k", ctrlKey: true })).toBe("search");
  expect(key({ key: "k", metaKey: true })).toBe("search");
  // Caps Lock on.
  expect(key({ key: "K", ctrlKey: true })).toBe("search");
  expect(key({ key: "n", code: "KeyN", altKey: true })).toBe("create");
  // A Mac types "˜" for Option+N: told by the key's place.
  expect(key({ key: "Dead", code: "KeyN", altKey: true })).toBe("create");
  // Plain typing, and the browser's own shortcuts, are left alone.
  expect(key({ key: "k" })).toBe(null);
  expect(key({ key: "n" })).toBe(null);
  expect(key({ key: "k", ctrlKey: true, shiftKey: true })).toBe(null);
  expect(key({ key: "n", code: "KeyN", ctrlKey: true })).toBe(null);
  expect(key({ key: "n", code: "KeyN", metaKey: true })).toBe(null);
  expect(key({ key: "n", code: "KeyN", altKey: true, ctrlKey: true })).toBe(null);
  expect(key({ key: "Enter", ctrlKey: true })).toBe(null);
});

test("the docked chat list is dragged within its limits, in whole pixels", () => {
  expect(SIDEBAR_WIDTH).toBe(272);
  expect(sidebarWidth(300.4)).toBe(300);
  expect(sidebarWidth(10)).toBe(SIDEBAR_MIN);
  expect(sidebarWidth(5000)).toBe(SIDEBAR_MAX);
  // Nothing sensible kept on the device: the usual width.
  expect(sidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH);
});

/** A stand-in button: its attributes and the words on it. */
function button(attrs: Record<string, string>, words = "") {
  const held = new Map(Object.entries(attrs));
  return {
    textContent: words,
    getAttribute: (n: string) => held.get(n) ?? null,
    hasAttribute: (n: string) => held.has(n),
    setAttribute: (n: string, v: string) => void held.set(n, v),
    removeAttribute: (n: string) => void held.delete(n),
    held,
  };
}

test("an icon-only button gets its name as its tooltip; words on it, or a tooltip of its own, are left as they are", () => {
  const close = button({ "aria-label": "Close" });
  nameAsTooltip(close as unknown as Element);
  expect(close.held.get("title")).toBe("Close");
  // Its name changes (Dictate, Stop dictation): the tooltip follows.
  close.held.set("aria-label", "Close the list");
  nameAsTooltip(close as unknown as Element);
  expect(close.held.get("title")).toBe("Close the list");
  // Its own tooltip stays.
  const settings = button({ "aria-label": "Chat settings", title: "Chat settings for this chat" });
  nameAsTooltip(settings as unknown as Element);
  expect(settings.held.get("title")).toBe("Chat settings for this chat");
  // Words on the button say it already.
  const cancel = button({ "aria-label": "Cancel the upload" }, "Cancel");
  nameAsTooltip(cancel as unknown as Element);
  expect(cancel.held.has("title")).toBe(false);
  // No name, nothing to say.
  const bare = button({});
  nameAsTooltip(bare as unknown as Element);
  expect(bare.held.has("title")).toBe(false);
});
