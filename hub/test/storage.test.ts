import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Room, StorageSettings } from "@crosstalk/shared";
import { Storage, type StorageDeps } from "../src/storage";
import { buildChatPrompt } from "../src/engine/prompt";

const DAY = 24 * 60 * 60_000;

function file(path: string, kb = 8, daysOld = 0) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(kb * 1024, 1));
  if (daysOld) age(path, daysOld);
}
function age(path: string, days: number) {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(path, t, t);
}
function room(id: string, cwd: string, daysIdle = 0): Room {
  const at = Date.now() - daysIdle * DAY;
  return { id, name: `Chat ${id}`, cwd, mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: at, updatedAt: at, archived: false };
}

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ct-storage-")));
  const home = join(dir, "home");
  const ws = join(dir, "workspaces");
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  const rooms: Room[] = [];
  const busy = new Set<string>();
  const kv = new Map<string, string>();
  const settings: StorageSettings = { autoClean: true, lowSpaceGb: 5 };
  const deps: StorageDeps = {
    rooms: () => rooms,
    isBusy: (id) => busy.has(id),
    settings: () => settings,
    kvGet: (k) => kv.get(k) ?? null,
    kvSet: (k, v) => void kv.set(k, v),
    workspaceRoot: ws,
    home,
    listFrom: { build: 1, upload: 1, large: 20 * 1024 },
  };
  return { dir, home, ws, rooms, busy, kv, settings, deps, storage: new Storage(deps), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the review list: build output, uploads and big folders, never a project's own folders, .git or anything outside", async () => {
  const t = setup();
  try {
    const chat = join(t.ws, "chat-a");
    file(join(chat, "app/package.json"), 1);
    file(join(chat, "app/node_modules/left-pad/index.js"));
    file(join(chat, "app/dist/app-1.0.zip"));
    file(join(chat, "app/src/huge-asset.bin"), 40); // inside a project: never offered
    file(join(chat, "images/test1/system.img"), 30);
    file(join(chat, "images/test2/system.img"), 30);
    file(join(chat, "tool/Makefile"), 1);
    file(join(chat, "tool/out/kernel.bin")); // a project's build output is offered
    file(join(chat, ".git/objects/pack/big.pack"), 40);
    file(join(chat, ".crosstalk/uploads/0e7e2667-a9eb-41f3-900a-711754d9ef46_recording.mov"));
    file(join(chat, ".crosstalk/uploads/6b0b4a5e-5d5b-4bb4-9a4e-0b6a2a1e3c11/MyApp/README.md"));
    file(join(t.dir, "outside/secret/data.bin"), 40);
    symlinkSync(join(t.dir, "outside"), join(chat, "linked"));
    t.rooms.push(room("r1", chat), room("r2", chat, 3));

    await t.storage.scan();
    const report = t.storage.report();
    const names = report.items.map((i) => `${i.kind}:${i.name}`).sort();
    expect(names).toEqual([
      "build:app/dist",
      "build:app/node_modules",
      "build:tool/out",
      "large:images/test1",
      "large:images/test2",
      "upload:MyApp/",
      "upload:recording.mov",
    ]);
    expect(report.items.every((i) => i.chats.length === 2 && i.chats.includes("Chat r1"))).toBe(true);
    expect(report.chats).toHaveLength(1);
    expect(report.chats[0].bytes).toBeGreaterThan(150 * 1024);
    expect(report.busy).toBeNull();
    // The home folder itself is never scanned as a chat folder.
    t.rooms.push(room("r3", t.home));
    await t.storage.scan();
    expect(t.storage.report().chats).toHaveLength(1);
  } finally {
    t.done();
  }
});

test("deleting from the review list: only scanned items, outer folders once, never through a swapped-in link or while the chat works", async () => {
  const t = setup();
  try {
    const chat = join(t.ws, "chat-b");
    file(join(chat, "app/package.json"), 1);
    file(join(chat, "app/dist/release.zip"));
    file(join(chat, "images/a/one.img"), 30);
    file(join(chat, "images/b/two.img"), 30);
    file(join(t.dir, "precious/keep.txt"), 1);
    t.rooms.push(room("r1", chat));
    await t.storage.scan();
    const id = (name: string) => t.storage.report().items.find((i) => i.name === name)!.id;

    expect(() => t.storage.remove([])).toThrow("Pick what to delete");
    expect(() => t.storage.remove(["nope"])).toThrow("The list changed");

    // A working chat's folder is left alone.
    t.busy.add("r1");
    t.storage.remove([id("app/dist")]);
    await t.storage.whenIdle();
    expect(existsSync(join(chat, "app/dist"))).toBe(true);
    expect(t.storage.report().lastDelete?.failed[0].error).toContain("working");
    t.busy.clear();

    // Swapped for a link after the scan: refused, and the link's target survives.
    const bId = id("images/b");
    rmSync(join(chat, "images/b"), { recursive: true });
    symlinkSync(join(t.dir, "precious"), join(chat, "images/b"));
    const report = t.storage.remove([id("app/dist"), id("images/a"), bId]);
    expect(report.busy).toBe("deleting");
    await t.storage.whenIdle();
    const last = t.storage.report().lastDelete!;
    expect(last.removed).toBe(2);
    expect(last.failed.map((f) => f.name)).toEqual(["images/b"]);
    expect(existsSync(join(chat, "app/dist"))).toBe(false);
    expect(existsSync(join(chat, "images/a"))).toBe(false);
    expect(existsSync(join(t.dir, "precious/keep.txt"))).toBe(true);
    expect(existsSync(join(chat, "app/package.json"))).toBe(true);
    expect(t.storage.report().items.map((i) => i.name)).toEqual(["images/b"]);
    expect(t.storage.cleared().map((c) => c.what).sort()).toEqual(["app/dist in Chat r1", "images/a in Chat r1"]);
  } finally {
    t.done();
  }
});

test("automatic cleanup: old cache entries, everything when space is low, dependencies of idle hub chats, old hub copies", async () => {
  const t = setup();
  try {
    const derived = join(t.home, "Library/Developer/Xcode/DerivedData");
    file(join(derived, "Old-abc/info.plist"), 8, 5);
    age(join(derived, "Old-abc"), 5);
    file(join(derived, "New-def/info.plist"));
    file(join(t.home, ".npm/_cacache/content-v2/x"), 8, 3);
    age(join(t.home, ".npm/_cacache/content-v2"), 3);

    // Dependencies: only in hub-made chat folders unused for two weeks, with the file that reinstalls them beside.
    const idle = join(t.ws, "idle");
    file(join(idle, "web/package.json"), 1);
    file(join(idle, "web/node_modules/pkg/index.js"), 8, 20);
    age(join(idle, "web/node_modules/pkg"), 20);
    age(join(idle, "web/node_modules"), 20);
    file(join(idle, "web/dist/app.zip"), 8, 20); // build output: only ever listed
    file(join(idle, "loose/node_modules/pkg/index.js"), 8, 20); // no package.json beside: only listed
    age(join(idle, "loose/node_modules/pkg"), 20);
    age(join(idle, "loose/node_modules"), 20);
    const active = join(t.ws, "active");
    file(join(active, "web/package.json"), 1);
    file(join(active, "web/node_modules/pkg/index.js"), 8, 20);
    age(join(active, "web/node_modules"), 20);
    const outside = join(t.dir, "my-projects/site");
    file(join(outside, "package.json"), 1);
    file(join(outside, "node_modules/pkg/index.js"), 8, 20);
    age(join(outside, "node_modules"), 20);
    t.rooms.push(room("idle", idle, 20), room("active", active, 1), room("mine", outside, 30));

    // Copies of the hub program beside it: the newest two stay, others go once a month old.
    const bin = join(t.dir, "bin");
    file(join(bin, "crosstalk-hub"), 1);
    for (const [name, days] of [["a", 40], ["b", 35], ["c", 1], ["d", 50]] as const) file(join(bin, `crosstalk-hub.${name}`), 1, days);
    const storage = new Storage({ ...t.deps, execPath: join(bin, "crosstalk-hub") });

    await storage.autoClean();
    expect(existsSync(join(derived, "Old-abc"))).toBe(false);
    expect(existsSync(join(derived, "New-def"))).toBe(true);
    expect(existsSync(join(t.home, ".npm/_cacache/content-v2"))).toBe(true); // only when space is low
    expect(existsSync(join(idle, "web/node_modules"))).toBe(false);
    expect(existsSync(join(idle, "web/package.json"))).toBe(true);
    expect(existsSync(join(idle, "web/dist/app.zip"))).toBe(true);
    expect(existsSync(join(idle, "loose/node_modules"))).toBe(true);
    expect(existsSync(join(active, "web/node_modules"))).toBe(true);
    expect(existsSync(join(outside, "node_modules"))).toBe(true);
    expect(["a", "b", "c", "d"].filter((n) => existsSync(join(bin, `crosstalk-hub.${n}`)))).toEqual(["b", "c"]);
    expect(existsSync(join(bin, "crosstalk-hub"))).toBe(true);
    const what = storage.cleared().map((c) => c.what);
    expect(what).toContain("Old xcode build data");
    expect(what).toContain("web/node_modules in Chat idle");
    expect(storage.cleared().every((c) => c.auto)).toBe(true);

    // Low on space (the warning level is above what's free): whole caches go, except what was used in the last hour.
    t.settings.lowSpaceGb = 1_000_000;
    file(join(t.home, ".npm/_cacache/index-v5/fresh"));
    await storage.autoClean();
    expect(existsSync(join(t.home, ".npm/_cacache/content-v2"))).toBe(false);
    expect(existsSync(join(t.home, ".npm/_cacache/index-v5/fresh"))).toBe(true);
    expect(existsSync(join(derived, "New-def"))).toBe(true);

    // Turned off: nothing is cleared on its own.
    t.settings.autoClean = false;
    file(join(derived, "Older-ghi/info.plist"), 8, 9);
    age(join(derived, "Older-ghi"), 9);
    expect(await storage.autoClean()).toBe(0);
    expect(existsSync(join(derived, "Older-ghi"))).toBe(true);
  } finally {
    t.done();
  }
});

test("low space: one notification per 12 hours, a status update, and a line in agents' prompts", async () => {
  const t = setup();
  try {
    const statuses: boolean[] = [];
    let notified = 0;
    const storage = new Storage({ ...t.deps, onStatus: (s) => statuses.push(s.low), onLow: () => notified++ });
    expect(storage.agentNotice()).toBeNull();
    await storage.check();
    expect(statuses).toEqual([false]);
    t.settings.lowSpaceGb = 1_000_000;
    t.settings.autoClean = false;
    await storage.check();
    await storage.check();
    expect(statuses).toEqual([false, true]);
    expect(notified).toBe(1);
    expect(storage.agentNotice()).toMatch(/^Crosstalk: this machine is low on disk space \(\d+\.\d GB free\)/);
    expect(buildChatPrompt([], null, "Crosstalk: low")).toBe("(Crosstalk: low)");
    expect(buildChatPrompt([{ authorKind: "human", text: "/compact" } as never], null, "Crosstalk: low")).toBe("/compact");
  } finally {
    t.done();
  }
});
