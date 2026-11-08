// "Always allow" allows what its button says: that command's first word or two, that file, that site — never every use
// of the tool — and the choice outlives the agent's process (it's restarted when idle).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Approval, Member, Room } from "@crosstalk/shared";
import { commandCovered, alwaysAllow, parseRule, ruleLabel, ruleText } from "../src/mcp/always";
import { App } from "../src/app";
import { handleInternal } from "../src/mcp/internal";
import { registerDriver } from "../src/agents";
import { MockDriver } from "../src/agents/mock";
import { ClaudeDriver } from "../src/agents/claude";
import { CodexDriver, codexCommandKey } from "../src/agents/codex";
import type { DriverContext, TurnSink } from "../src/agents/driver";

const FIX = join(import.meta.dir, "fixtures");
const bash = (command: string) => alwaysAllow("Bash", { command }, "/work/app");

describe("what Always allow allows", () => {
  test("a shell command: its first word or two, as Claude Code's own don't-ask-again does", () => {
    expect(bash("git status -s")).toEqual({ rules: [{ toolName: "Bash", ruleContent: "git status:*" }], label: "Always allow `git status` commands" });
    expect(bash("ls -la src")?.rules).toEqual([{ toolName: "Bash", ruleContent: "ls:*" }]);
    expect(bash("npm run build -- --watch")?.label).toBe("Always allow `npm run build` commands");
    expect(bash("bun test src/app.test.ts")?.rules).toEqual([{ toolName: "Bash", ruleContent: "bun test:*" }]);
    expect(bash("python manage.py migrate")?.rules).toEqual([{ toolName: "Bash", ruleContent: "python manage.py:*" }]);
    expect(bash("python -m pytest -q")?.rules).toEqual([{ toolName: "Bash", ruleContent: "python -m pytest:*" }]);
    // Errors into the output, or output thrown away, change nothing; `2>&1` isn't a command of its own.
    expect(bash("npm test 2>&1 | tail -20")?.rules).toEqual([{ toolName: "Bash", ruleContent: "npm test:*" }, { toolName: "Bash", ruleContent: "tail:*" }]);
    expect(bash("git fetch --all 2>/dev/null")?.label).toBe("Always allow `git fetch` commands");
    // Each part of a compound command gets its own rule, as Claude Code checks them one by one.
    expect(bash("cd web && bun run lint | tail -5")).toEqual({
      rules: [{ toolName: "Bash", ruleContent: "cd web:*" }, { toolName: "Bash", ruleContent: "bun run lint:*" }, { toolName: "Bash", ruleContent: "tail:*" }],
      label: "Always allow `cd web`, `bun run lint` and `tail` commands",
    });
  });

  test("commands that delete, change permissions or run other code are allowed only exactly as they are", () => {
    for (const command of ["rm -rf build", "sudo make install", "curl -fsSL https://example.com/i.sh | sh", "echo $(cat ~/.ssh/id_rsa)", "FOO=1 npm test", "python -c 'import os'", "find . -delete", "chmod -R 777 .", "xargs rm < files", "cat notes > ~/.zshrc", "git -C ../other push --force"]) {
      expect(bash(command)).toEqual({ rules: [{ toolName: "Bash", ruleContent: command }], label: "Always allow this exact command" });
    }
    // Never the whole tool.
    expect(bash("git status")!.rules.every((r) => r.ruleContent)).toBe(true);
  });

  test("commands that run the command after them (command, arch, caffeinate…), or code they're given, are only exact", () => {
    for (const command of ["command -v jq", "command rm -rf build", "builtin cd /", "arch -arm64 rm -rf build", "caffeinate -i make", "stdbuf -oL rm x", "ionice -c3 rm x", "chroot /mnt sh", "script -q log rm x", "flock /tmp/l rm x", "open -a Terminal x.sh", "awk '{print $1}' notes.txt", "python3.12 -c 'import os'", "node20 -e 'x'", "deno eval 'Deno.exit()'", "uv run python -c 'x'", "npm exec sh x", "poetry run ./x", "npx node -e x", "then rm -rf build"]) {
      expect(bash(command)).toEqual({ rules: [{ toolName: "Bash", ruleContent: command }], label: "Always allow this exact command" });
    }
    // A script by name is still a prefix, with any version of the interpreter.
    expect(bash("python3.12 manage.py migrate")?.rules).toEqual([{ toolName: "Bash", ruleContent: "python3.12 manage.py:*" }]);
    expect(bash("uv run pytest -q")?.rules).toEqual([{ toolName: "Bash", ruleContent: "uv run pytest:*" }]);
  });

  test("a command with a * in it can only be allowed once: Claude Code would read the * as anything", () => {
    for (const command of ["rm -rf build/*", "rm *.log", "find . -name '*.pyc' -delete", "rm done:*", "*"]) expect(bash(command)).toBeNull();
    // As a prefix the * is in what follows, which a prefix allows anyway.
    expect(bash("ls *.log")?.rules).toEqual([{ toolName: "Bash", ruleContent: "ls:*" }]);
  });

  test("a saved rule reads back as the very rule Claude Code was given, and says what it allows in words", () => {
    const rules = [{ toolName: "Bash", ruleContent: "echo (a) \\\\ b" }, { toolName: "Edit", ruleContent: "//work/a (1).ts" }, { toolName: "WebSearch" }];
    for (const r of rules) expect(parseRule(ruleText(r))).toEqual(r);
    expect(ruleText(rules[0])).toBe("Bash(echo \\(a\\) \\\\\\\\ b)");
    expect(ruleLabel("Bash(git status:*)")).toBe("`git status` commands");
    expect(ruleLabel("Bash(rm -rf build)")).toBe("The exact command `rm -rf build`");
    expect(ruleLabel("Edit(//work/app/todo \\[draft\\].md)")).toBe("Edits to /work/app/todo [draft].md");
    expect(ruleLabel("Read(//work/lib/**)")).toBe("Reading in /work/lib");
    expect(ruleLabel("WebFetch(domain:docs.example.com)")).toBe("Fetching from docs.example.com");
    expect(ruleLabel("mcp__github__create_issue")).toBe("github: create issue");
  });

  test("edits: that file; reads: that file or folder; fetches: that site; other tools: that one tool", () => {
    expect(alwaysAllow("Edit", { file_path: "/work/app/src/main.ts" }, "/work/app")).toEqual({ rules: [{ toolName: "Edit", ruleContent: "//work/app/src/main.ts" }], label: "Always allow edits to main.ts" });
    expect(alwaysAllow("Write", { file_path: "notes/todo [draft].md" }, "/work/app")).toEqual({ rules: [{ toolName: "Edit", ruleContent: "//work/app/notes/todo \\[draft\\].md" }], label: "Always allow edits to todo [draft].md" });
    expect(alwaysAllow("NotebookEdit", { notebook_path: "/work/app/a.ipynb" }, "/work/app")?.rules).toEqual([{ toolName: "Edit", ruleContent: "//work/app/a.ipynb" }]);
    expect(alwaysAllow("Read", { file_path: "/etc/hosts" }, "/work/app")?.label).toBe("Always allow reading hosts");
    expect(alwaysAllow("Grep", { pattern: "x", path: "/work/lib" }, "/work/app")?.rules).toEqual([{ toolName: "Read", ruleContent: "//work/lib/**" }]);
    expect(alwaysAllow("WebFetch", { url: "https://docs.example.com/a?b", prompt: "" }, "/work/app")).toEqual({ rules: [{ toolName: "WebFetch", ruleContent: "domain:docs.example.com" }], label: "Always allow fetching from docs.example.com" });
    expect(alwaysAllow("mcp__github__create_issue", {}, "/work/app")).toEqual({ rules: [{ toolName: "mcp__github__create_issue" }], label: "Always allow github: create issue" });
    // Nothing safe to name: it can only be allowed once.
    expect(alwaysAllow("Read", { file_path: "~/notes.txt" }, "/work/app")).toBeNull();
    expect(alwaysAllow("WebFetch", { url: "not a url" }, "/work/app")).toBeNull();
  });
});

describe("Claude Code's permission prompt", () => {
  async function setup() {
    let release = () => {};
    registerDriver("mock", () => ({
      provider: "mock",
      runTurn: () => new Promise((res) => (release = () => res({ ok: true, text: "Done." }))),
      interrupt: async () => {},
      dispose: async () => {},
    }));
    const dir = mkdtempSync(join(tmpdir(), "ct-always-"));
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
    const room = app.createRoom({ name: "Ask first", mode: "direct" });
    const member = app.addMember(room.id, { provider: "mock", handle: "claude", permissionMode: "ask" });
    app.engine.postHumanMessage(room.id, "check the repo", "Phone");
    while (!app.engine.runningTurns(room.id).length) await Bun.sleep(5);
    const prompt = async (tool_name: string, input: Record<string, unknown>) => {
      const req = new Request("http://hub/internal/approve", { method: "POST", headers: { "x-crosstalk-member": member.id, "x-crosstalk-token": app.internalToken(member.id) }, body: JSON.stringify({ tool_name, input }) });
      return handleInternal(app, req, new URL(req.url)).then((r) => r.json() as Promise<Record<string, unknown>>);
    };
    const pending = async () => {
      for (let i = 0; i < 200; i++) {
        const a = app.store.listPendingApprovals()[0];
        if (a) return a;
        await Bun.sleep(5);
      }
      throw new Error("no approval card");
    };
    const close = async () => {
      release();
      await app.engine.whenIdle();
      await app.engine.shutdown();
      app.store.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(app.computers.dir, { recursive: true, force: true });
      registerDriver("mock", (ctx) => new MockDriver(ctx));
    };
    return { app, member, prompt, pending, close };
  }

  test("the card says what Always allow allows, and Claude Code gets that rule (not the whole tool), kept for its next process", async () => {
    const t = await setup();
    try {
      const answer = t.prompt("Bash", { command: "git status -s", description: "Check the tree" });
      const card: Approval = await t.pending();
      expect(card).toMatchObject({ kind: "command", title: "git status -s", always: "Always allow `git status` commands" });
      t.app.engine.decideApproval(card.id, "approve_always", "Phone");
      expect(await answer).toEqual({
        behavior: "allow",
        updatedInput: { command: "git status -s", description: "Check the tree" },
        updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git status:*" }], behavior: "allow", destination: "session" }],
      });
      expect(t.app.store.getApproval(card.id)).toMatchObject({ status: "approved", decision: "approve_always", always: "Always allow `git status` commands" });
      expect(t.app.store.getMemberSession(t.member.id).allowRules).toEqual(["Bash(git status:*)"]);

      // An edit: that file only.
      const edit = t.prompt("Edit", { file_path: join(t.app.store.getRoom(t.member.roomId)!.cwd, "src/app.ts"), old_string: "a", new_string: "b" });
      const editCard = await t.pending();
      expect(editCard.always).toBe("Always allow edits to app.ts");
      t.app.engine.decideApproval(editCard.id, "approve_always", "Phone");
      const rules = ((await edit).updatedPermissions as { rules: { toolName: string; ruleContent: string }[] }[])[0].rules;
      expect(rules).toEqual([{ toolName: "Edit", ruleContent: `/${join(t.app.store.getRoom(t.member.roomId)!.cwd, "src/app.ts")}` }]);

      // A request that can only be allowed once: no Always allow, and an older app's "always" is taken as once.
      const once = t.prompt("Read", { file_path: "~/notes.txt" });
      const onceCard = await t.pending();
      expect(onceCard.always).toBeNull();
      t.app.engine.decideApproval(onceCard.id, "approve_always", "Phone");
      expect(await once).toEqual({ behavior: "allow", updatedInput: { file_path: "~/notes.txt" } });
      expect(t.app.store.getApproval(onceCard.id)?.decision).toBe("approve");
    } finally {
      await t.close();
    }
  });

  test("the chat's settings list what's always allowed, each can be taken back, and stricter permissions take all of it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-always-list-"));
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 5 } });
    try {
      const room = app.createRoom({ name: "Grants", mode: "direct" });
      const member = app.addMember(room.id, { provider: "mock", handle: "claude", permissionMode: "auto" });
      const make = codexCommandKey("make", "/work/app", null);
      app.store.setMemberSession(member.id, { sessionId: "s1", allowRules: ["Bash(git status:*)", "Edit(//work/app/a.ts)"], allowCommands: ["make", make], allowFiles: ["/work/app/b.ts"] });
      expect(app.alwaysAllowed(member.id)).toEqual([
        { id: "rule:Bash(git status:*)", label: "`git status` commands" },
        { id: "rule:Edit(//work/app/a.ts)", label: "Edits to /work/app/a.ts" },
        // An older plain command (kept without its folder) isn't allowed any more, so it isn't listed.
        { id: `command:${make}`, label: "The exact command `make` (in /work/app)" },
        { id: "file:/work/app/b.ts", label: "Edits to /work/app/b.ts" },
      ]);
      const left = await app.removeAlwaysAllowed(member.id, "rule:Bash(git status:*)");
      expect(left.map((g) => g.id)).toEqual(["rule:Edit(//work/app/a.ts)", `command:${make}`, "file:/work/app/b.ts"]);
      expect(app.store.getMemberSession(member.id).allowRules).toEqual(["Edit(//work/app/a.ts)"]);
      await expect(app.removeAlwaysAllowed(member.id, "nonsense")).rejects.toThrow("Say what to take back");
      // Looser permissions keep them; stricter ones ("Ask first") take them all back. The session itself stays.
      app.updateMember(member.id, { permissionMode: "full" });
      expect(app.alwaysAllowed(member.id)).toHaveLength(3);
      app.updateMember(member.id, { permissionMode: "ask" });
      expect(app.alwaysAllowed(member.id)).toEqual([]);
      expect(app.store.getMemberSession(member.id).sessionId).toBe("s1");
    } finally {
      await app.engine.shutdown();
      app.store.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(app.computers.dir, { recursive: true, force: true });
    }
  });

  test("a restarted Claude Code gets the rules the user chose to always allow in this chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-always-claude-"));
    try {
      const room: Room = { id: "r1", name: "R", cwd: dir, mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: 0, updatedAt: 0, archived: false };
      const member: Member = { id: "m1", roomId: "r1", handle: "claude", provider: "claude", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: 0, position: 0 };
      const saved = { allowRules: ["Bash(git status:*)", "Edit(//tmp/x.ts)"] };
      const args = join(dir, "args.jsonl");
      const ctx: DriverContext = { room, member, session: {}, latestSession: () => saved, mcp: { command: "true", args: [], env: {} }, env: { PATH: process.env.PATH ?? "", FAKE_CLAUDE_ARGS_OUT: args }, bin: "" };
      const d = new ClaudeDriver(ctx, join(FIX, "fake-claude"));
      const sink = quietSink();
      expect((await d.runTurn({ turnId: "t1", prompt: "hello", systemNote: null }, sink)).ok).toBe(true);
      const argv = JSON.parse(readFileSync(args, "utf8").trim().split("\n")[0]) as string[];
      // In a file only this user can read: a rule can name a secret a command was given, and `ps` shows the command line.
      const file = argv[argv.indexOf("--settings") + 1];
      expect(argv.join(" ")).not.toContain("git status");
      expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
      expect(JSON.parse(readFileSync(file, "utf8")).permissions).toEqual({ allow: ["Bash(git status:*)", "Edit(//tmp/x.ts)"] });
      await d.dispose();
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex's approvals", () => {
  function codex() {
    const dir = mkdtempSync(join(tmpdir(), "ct-always-codex-"));
    const room: Room = { id: "r1", name: "R", cwd: dir, mode: "direct", leadMemberId: null, maxHops: 6, rounds: 1, parallel: false, createdAt: 0, updatedAt: 0, archived: false };
    const member: Member = { id: "m1", roomId: "r1", handle: "codex", provider: "codex", model: null, role: "", permissionMode: "edits", status: "idle", statusDetail: null, config: {}, createdAt: 0, position: 0 };
    const session: Record<string, unknown> = {};
    const env = { PATH: process.env.PATH ?? "", CODEX_HOME: join(dir, "codex-home") };
    // The saved session as it is now, as the engine hands it over: a grant taken back there is gone at once.
    const ctx = (): DriverContext => ({ room, member, session: { ...session }, latestSession: () => session, mcp: { command: "true", args: [], env: {} }, env, bin: "" });
    const asked: { kind: string; title: string; detail: string; always?: string | null }[] = [];
    const sink = quietSink((r) => (asked.push(r), "approve_always"), session);
    let text = "";
    const run = async (d: CodexDriver, prompt: string) => {
      text = "";
      expect((await d.runTurn({ turnId: `t-${prompt}`, prompt, systemNote: null }, { ...sink, text: (x) => (text += x) })).ok).toBe(true);
      return text;
    };
    return { dir, session, asked, run, driver: () => new CodexDriver(ctx(), join(FIX, "fake-codex-app")), close: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("Always allow says it's that exact command; a later driver (a restarted app-server) runs it without asking again", async () => {
    const t = codex();
    try {
      const first = t.driver();
      // Crosstalk answers each one itself (once), so taking a grant back works at once.
      expect(await t.run(first, "ASK_RUN:make")).toBe("Decision: accept");
      expect(t.asked).toEqual([expect.objectContaining({ kind: "command", title: "make", always: "Always allow this exact command" })]);
      expect(t.session.allowCommands).toEqual([codexCommandKey("make", "/tmp", null)]);
      await first.dispose();

      const second = t.driver();
      expect(await t.run(second, "ASK_RUN:make")).toBe("Decision: accept");
      expect(t.asked.length).toBe(1); // not asked again
      // Another command is asked about as usual.
      await t.run(second, "ASK_RUN:make-install");
      expect(t.asked.length).toBe(2);
      await second.dispose();
    } finally {
      t.close();
    }
  });

  test("only exactly the same is answered: the command in another folder, network access, or input into a terminal is asked about", async () => {
    const t = codex();
    const d = t.driver();
    try {
      await t.run(d, "ASK_RUN:make");
      expect(t.asked.length).toBe(1);
      await t.run(d, "ASK_RUN:make@/Users/someone");
      expect(t.asked.length).toBe(2); // another folder
      // Network access for it, or typing into a terminal, can only be allowed once.
      expect(await t.run(d, "ASK_NET:make")).toBe("Decision: accept");
      expect(t.asked[2]).toMatchObject({ kind: "command", always: null });
      expect(t.asked[2].detail).toContain("Network access to example.com");
      await t.run(d, "ASK_STDIN:make");
      expect(t.asked[3]).toMatchObject({ always: null });
      await t.run(d, "ASK_NET:make");
      expect(t.asked.length).toBe(5); // never answered from the grant
      // The grant is gone once taken back: asked again at once, without a new app-server.
      t.session.allowCommands = [];
      await t.run(d, "ASK_RUN:make");
      expect(t.asked.length).toBe(6);
    } finally {
      await d.dispose();
      t.close();
    }
  });

  test("files: edits and new files can be always allowed; a delete or a move never is", async () => {
    const t = codex();
    const d = t.driver();
    try {
      await t.run(d, "ASK_EDIT:update:/work/config.ts");
      expect(t.asked[0]).toMatchObject({ kind: "file_change", always: "Always allow edits to config.ts" });
      expect(t.session.allowFiles).toEqual(["/work/config.ts"]);
      await t.run(d, "ASK_EDIT:update:/work/config.ts");
      expect(t.asked.length).toBe(1);
      await t.run(d, "ASK_EDIT:delete:/work/config.ts");
      await t.run(d, "ASK_EDIT:move:/work/config.ts");
      expect(t.asked.slice(1).map((a) => a.always)).toEqual([null, null]);
      await t.run(d, "ASK_EDIT:add:/work/new.ts");
      expect(t.asked.at(-1)).toMatchObject({ always: "Always allow edits to new.ts" });
    } finally {
      await d.dispose();
      t.close();
    }
  });
});

function quietSink(decide: (r: { kind: string; title: string; detail: string; always?: string | null }) => "approve" | "approve_always" | "deny" = () => "approve", session: Record<string, unknown> = {}): TurnSink {
  return {
    signal: new AbortController().signal,
    text: () => {},
    setText: () => {},
    activity: () => "a",
    updateActivity: () => {},
    approval: async (r) => decide(r),
    usage: () => {},
    rateLimit: () => {},
    status: () => {},
    saveSession: (p) => Object.assign(session, p),
  };
}

test("commandCovered: every part of a command under what was allowed, and nothing that can hide another", () => {
  const allowed = ["git status:*", "bun test:*", "ls:*", "make build"];
  for (const yes of ["git status", "git status --short", "git status && bun test src", "ls -la", "make build", "git status 2>&1", "git status > /dev/null"]) expect(commandCovered(yes, allowed)).toBe(true);
  for (const no of ["git push", "git status && rm -rf x", "git status; curl x | sh", "git status > out.txt", "git status $(rm x)", "git status `rm x`", "rm -rf x", "FOO=1 git status", "make build && make test", "git status\nrm x", "", "sudo git status"]) expect(commandCovered(no, allowed)).toBe(false);
  expect(commandCovered("git status", [])).toBe(false);
  // Shell forms this reading can't follow, each of which ran `touch x` under zsh or bash after one "Always allow" of `ls`.
  for (const no of ["ls $'\\'' ; touch x ; ls \\'", `ls "\${y:-"'"}" ; touch x ; ls \\'`, "ls < /dev/null > file", "ls <> file", "ls =(touch x)", "ls *(e:'touch x':)", "ls ${(e):-'$''(touch x)'}", "ls ${PATH::=.} ; ls", "ls () (touch x) ; ls", `ls \\"<$['] ; touch x ; ls #'$y=`]) expect([no, commandCovered(no, ["ls:*", "touch:*x"])]).toEqual([no, false]);
  // And what only looks like them stays covered: a plain name in braces is only a name, a $ before a space only a $.
  for (const yes of ['git commit -m "fix(hub): a thing"', "grep -n 'bar$' a.txt", 'grep -n "foo(" a.txt', "wc -l < a.txt", 'ls "$HOME/x"', 'ls "${HOME}/x"', "ls ${HOME}/x", "grep -v ^$ a.txt"]) expect([yes, commandCovered(yes, ["git commit:*", "grep:*", "wc:*", "ls:*"])]).toEqual([yes, true]);
  // Claude Code's card reads the same way.
  expect(alwaysAllow("Bash", { command: 'cat "${FILE}"' }, "/w")?.label).toBe("Always allow `cat` commands");
  // Only what alwaysAllow gives back is ever kept: its own rules cover the command they came from.
  const rules = alwaysAllow("Bash", { command: "git status --short && bun test src" }, "/w")!.rules.map((r) => r.ruleContent!);
  expect(commandCovered("git status --short && bun test src", rules)).toBe(true);
  expect(commandCovered("bun install", rules)).toBe(false);
});
