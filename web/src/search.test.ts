import { describe, expect, test } from "bun:test";
import type { SearchHit } from "@crosstalk/shared";
import { ApiError } from "./api";
import { exportProblem } from "./exportMarkdown";
import { anyTruncated, foundHits, groupHits, hitTime, hitWho, markSnippet, searchProblem, searchTerm, type MachineHits } from "./search";

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({ roomId: "r1", roomName: "Fix login", messageId: "m1", seq: 1, who: "you", snippet: "the login page", createdAt: 1_000, ...over });
const machine = (key: string, name: string, hits: SearchHit[], query = "login", over: Partial<MachineHits> = {}): MachineHits => ({ key, name, answer: { query, hits, truncated: false }, busy: false, problem: null, ...over });

describe("what to search for", () => {
  test("the words trimmed; nothing under 2 characters", () => {
    expect(searchTerm("  login ")).toBe("login");
    expect(searchTerm("lo")).toBe("lo");
    expect(searchTerm("a")).toBeNull();
    expect(searchTerm("  a  ")).toBeNull();
    expect(searchTerm("")).toBeNull();
  });
});

describe("marking the match in a snippet", () => {
  const joined = (s: string, q: string) => markSnippet(s, q).map((p) => (p.hit ? `[${p.text}]` : p.text)).join("");
  test("every place the words show, in any case, as written", () => {
    expect(joined("The Login page and the login form", "login")).toBe("The [Login] page and the [login] form");
    expect(joined("login", "LOGIN")).toBe("[login]");
    expect(joined("a login at the end: login", "login")).toBe("a [login] at the end: [login]");
  });
  test("characters with a meaning in patterns are plain text", () => {
    expect(joined("call foo.bar(1) now", "foo.bar(1)")).toBe("call [foo.bar(1)] now");
    expect(joined("a+b and a+b", "a+b")).toBe("[a+b] and [a+b]");
    expect(joined("cost $5 [x] \\ ok", "$5 [x] \\")).toBe("cost [$5 [x] \\] ok");
    expect(joined("fooXbar", "foo.bar")).toBe("fooXbar");
  });
  test("words not in it, an empty query and an empty snippet leave one plain part", () => {
    expect(markSnippet("nothing here", "zebra")).toEqual([{ text: "nothing here", hit: false }]);
    expect(markSnippet("nothing here", "  ")).toEqual([{ text: "nothing here", hit: false }]);
    expect(markSnippet("", "login")).toEqual([{ text: "", hit: false }]);
  });
  test("the parts put back together are the snippet", () => {
    const s = "…before LOGIN middle login after…";
    expect(markSnippet(s, "login").map((p) => p.text).join("")).toBe(s);
  });
});

describe("hits from every machine", () => {
  test("one list, newest first, each with its machine and the words that found it", () => {
    const mac = machine("", "Mac mini", [hit({ messageId: "a", createdAt: 3_000 }), hit({ messageId: "c", createdAt: 1_000 })]);
    const linux = machine("http://linux", "Linux box", [hit({ messageId: "b", roomId: "r9", roomName: "Deploy", createdAt: 2_000 })], "deploy");
    const list = foundHits([mac, linux]);
    expect(list.map((h) => h.messageId)).toEqual(["a", "b", "c"]);
    expect(list[1]).toMatchObject({ machineKey: "http://linux", machineName: "Linux box", query: "deploy", roomName: "Deploy" });
    expect(list[0]).toMatchObject({ machineKey: "", machineName: "Mac mini", query: "login" });
  });
  test("a machine with no answer (failed, or still asked) adds none", () => {
    const down = machine("http://linux", "Linux box", [], "login", { answer: null, problem: "It isn't answering." });
    expect(foundHits([down, machine("", "Mac mini", [hit()])])).toHaveLength(1);
  });
  test("hits said at the same moment keep the later message first", () => {
    const list = foundHits([machine("", "Mac", [hit({ messageId: "x", seq: 5, createdAt: 9 }), hit({ messageId: "y", seq: 6, createdAt: 9 })])]);
    expect(list.map((h) => h.messageId)).toEqual(["y", "x"]);
  });
  test("it says when a machine had more matches than it sent", () => {
    expect(anyTruncated([machine("", "Mac", [hit()]), machine("k", "Linux", [hit()])])).toBe(false);
    expect(anyTruncated([machine("", "Mac", [hit()]), { ...machine("k", "Linux", [hit()]), answer: { query: "x", hits: [], truncated: true } }])).toBe(true);
  });
});

describe("grouping by chat", () => {
  test("a chat's hits are together under its name, in the order of each chat's newest hit", () => {
    const list = foundHits([
      machine("", "Mac", [
        hit({ roomId: "r1", roomName: "One", messageId: "a", createdAt: 9 }),
        hit({ roomId: "r2", roomName: "Two", messageId: "b", createdAt: 8 }),
        hit({ roomId: "r1", roomName: "One", messageId: "c", createdAt: 7 }),
        hit({ roomId: "r3", roomName: "Three", messageId: "d", createdAt: 6 }),
        hit({ roomId: "r2", roomName: "Two", messageId: "e", createdAt: 5 }),
      ]),
    ]);
    const groups = groupHits(list);
    expect(groups.map((g) => [g.roomName, g.hits.map((h) => h.messageId)])).toEqual([["One", ["a", "c"]], ["Two", ["b", "e"]], ["Three", ["d"]]]);
  });
  test("the same chat id on two machines is two chats", () => {
    const groups = groupHits(foundHits([machine("", "Mac", [hit({ createdAt: 2 })]), machine("http://linux", "Linux box", [hit({ createdAt: 1 })])]));
    expect(groups.map((g) => g.machineName)).toEqual(["Mac", "Linux box"]);
  });
  test("showing the newest few: cut the list first, then group", () => {
    const hits = foundHits([machine("", "Mac", Array.from({ length: 10 }, (_, i) => hit({ roomId: `r${i % 3}`, roomName: `R${i % 3}`, messageId: `m${i}`, createdAt: 100 - i })))]);
    const groups = groupHits(hits.slice(0, 6));
    expect(groups.flatMap((g) => g.hits)).toHaveLength(6);
  });
});

describe("when a message was said", () => {
  const now = new Date(2026, 9, 28, 15, 30).getTime();
  test("the time today, the day this year, the year too before", () => {
    const today = hitTime(new Date(2026, 9, 28, 9, 5).getTime(), now);
    expect(today).toMatch(/9:05/);
    expect(today).not.toMatch(/Oct/);
    const thisYear = hitTime(new Date(2026, 2, 3, 9, 5).getTime(), now);
    expect(thisYear).toMatch(/Mar/);
    expect(thisYear).not.toMatch(/2026/);
    expect(hitTime(new Date(2025, 2, 3, 9, 5).getTime(), now)).toMatch(/2025/);
  });
});

describe("a machine that can't be searched", () => {
  test("every problem says what to do", () => {
    expect(searchProblem(new ApiError(404, "not found"))).toBe("It runs an older Crosstalk that can't search yet. Update it, then try again.");
    expect(searchProblem(new ApiError(405, "x"))).toContain("older Crosstalk");
    expect(searchProblem(new ApiError(401, "unauthorized"))).toBe("It signed this device out. Pair it again in Settings → Machines.");
    expect(searchProblem(new ApiError(0, "Can't reach the hub. Check that it's running and that this device is on your Tailscale network."))).toBe("Can't reach the hub. Check that it's running and that this device is on your Tailscale network.");
    expect(searchProblem(new ApiError(500, "disk I/O error"))).toBe("It answered with an error (disk I/O error). Try again in a moment.");
    expect(searchProblem(new Error("boom"))).toBe("boom");
    expect(searchProblem("weird")).toBe("Something went wrong. Try again.");
  });

  test("what a machine answered with goes in a sentence, on one line, cut to about 120 characters", () => {
    expect(searchProblem(new ApiError(500, "Disk is full.\n\n  Free some space."))).toBe("It answered with an error (Disk is full. Free some space). Try again in a moment.");
    // No words of its own: the number says it.
    expect(searchProblem(new ApiError(502, "Request failed (502)"))).toBe("It answered with an error (502). Try again in a moment.");
    expect(searchProblem(new ApiError(500, "   "))).toBe("It answered with an error (500). Try again in a moment.");
    // A page where a message should be (a proxy's error) can't fill the sidebar.
    const long = searchProblem(new ApiError(500, `<html>${"x".repeat(500)}</html>`));
    expect(long).toBe(`It answered with an error (<html>${"x".repeat(114)}…). Try again in a moment.`);
    expect(long.length).toBeLessThan(180);
    // Never cuts an emoji in two.
    expect(searchProblem(new ApiError(500, `${"x".repeat(119)}😀${"y".repeat(50)}`))).toBe(`It answered with an error (${"x".repeat(119)}…). Try again in a moment.`);
  });
});

describe("who said a hit", () => {
  test("you; the agent a hit names (one in another chat that sent it here, or a copied reply's); else this chat's own agent", () => {
    expect(hitWho(hit({ who: "you" }), "Claude Code")).toBe("You");
    expect(hitWho(hit({ who: "agent" }), "Claude Code")).toBe("Claude Code");
    expect(hitWho(hit({ who: "agent", agent: "Codex" }), "Claude Code")).toBe("Codex");
    // A hub from before hits named an agent, or a chat this device doesn't know.
    expect(hitWho(hit({ who: "agent" }), null)).toBe("The agent");
    expect(hitWho(hit({ who: "agent" }))).toBe("The agent");
    expect(hitWho(hit({ who: "agent", agent: "Codex" }), null)).toBe("Codex");
  });
});

describe("a chat that can't be exported", () => {
  test("an older machine, a missing chat, a signed-out device, and the machine's own words", () => {
    expect(exportProblem(404, "not found")).toBe("This machine runs an older Crosstalk that can't export yet. Update it, then try again.");
    expect(exportProblem(404, "No such chat")).toBe("That chat isn't on its machine any more.");
    expect(exportProblem(401, "unauthorized")).toBe("The machine signed this device out. Pair it again in Settings → Machines.");
    expect(exportProblem(500, "disk I/O error")).toBe("disk I/O error");
    expect(exportProblem(502, "")).toBe("The machine answered with an error (502).");
  });
});
