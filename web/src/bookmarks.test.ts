import { expect, test } from "bun:test";
import type { Bookmark } from "@crosstalk/shared";
import { ApiError } from "./api";
import { allBookmarks, bookmarkWho, bookmarksProblem, withBookmark } from "./bookmarks";

const b = (id: string, at: number, patch: Partial<Bookmark> = {}): Bookmark => ({ messageId: id, roomId: "r", roomName: "Chat", seq: 1, who: "you", text: id, cut: false, createdAt: at, bookmarkedAt: at, ...patch });

test("allBookmarks: every machine's, newest bookmark first, with its machine", () => {
  const list = allBookmarks([
    { key: "a", name: "Mac mini", bookmarks: [b("a1", 10), b("a2", 30)] },
    { key: "b", name: "Linux box", bookmarks: [b("b1", 20)] },
    { key: "c", name: "Old", bookmarks: null },
  ]);
  expect(list.map((x) => `${x.machineName}:${x.messageId}`)).toEqual(["Mac mini:a2", "Linux box:b1", "Mac mini:a1"]);
});

test("bookmarkWho: you, the chat's own agent by its kind, a group chat's by @handle, another chat's by name", () => {
  expect(bookmarkWho({ who: "you" }, "Codex")).toBe("You");
  expect(bookmarkWho({ who: "agent", agent: "@codex" }, "Codex")).toBe("Codex");
  expect(bookmarkWho({ who: "agent", agent: "@reviewer" }, null)).toBe("@reviewer");
  expect(bookmarkWho({ who: "agent", agent: "Claude Code" }, "Codex")).toBe("Claude Code");
  expect(bookmarkWho({ who: "agent" }, null)).toBe("The agent");
});

test("withBookmark and bookmarksProblem", () => {
  expect(withBookmark(null, "m1", 5)).toEqual({ m1: 5 });
  expect(withBookmark({ m1: 5, m2: 6 }, "m1", null)).toEqual({ m2: 6 });
  expect(bookmarksProblem(new ApiError(404, "Not found"))).toContain("older Crosstalk");
  expect(bookmarksProblem(new ApiError(401, "no"))).toContain("Pair it again");
});
