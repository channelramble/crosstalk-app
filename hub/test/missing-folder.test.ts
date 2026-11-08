import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDriver, DriverContext, TurnInput, TurnResult, TurnSink } from "../src/agents/driver";
import { ClaudeDriver } from "../src/agents/claude";
import { registerDriver } from "../src/agents";
import { App } from "../src/app";

const dirs: string[] = [];
afterAll(() => {
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  registerDriver("claude", (c) => new ClaudeDriver(c, c.bin));
});

/** Stands in for Claude Code: answers, and notes that it ran (a missing folder must stop it from starting at all). */
class Agent implements AgentDriver {
  readonly provider = "claude" as const;
  static ran = 0;
  constructor(private ctx: DriverContext) {}
  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    Agent.ran++;
    sink.text(`Answer in ${this.ctx.room.cwd}`);
    return { ok: true };
  }
  async interrupt() {}
  async dispose() {}
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ct-folder-root-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "ct-folder-own-"));
  dirs.push(root, elsewhere);
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: root, maxHopsDefault: 6 } });
  registerDriver("claude", (c) => new Agent(c));
  Agent.ran = 0;
  const say = async (roomId: string, text: string) => {
    app.engine.postHumanMessage(roomId, text, "Phone");
    for (let i = 0; i < 100 && app.engine.isBusy(); i++) await Bun.sleep(10);
    await Bun.sleep(20);
    return app.store.listMessages(roomId).map((m) => `${m.authorKind}:${m.status}:${m.text}`);
  };
  return { app, root, elsewhere, say, done: async () => (await app.engine.shutdown(), app.store.close()) };
}

test("a chat folder Crosstalk made, gone missing, is made again with a note, and the agent answers", async () => {
  const t = setup();
  try {
    const cwd = join(t.root, "chat-2026-10-14");
    mkdirSync(cwd);
    const room = t.app.chats.create({ provider: "claude", name: "Hello! API?", cwd });
    rmSync(cwd, { recursive: true });
    const messages = await t.say(room.id, "pick up where we left off");
    expect(existsSync(cwd)).toBe(true);
    expect(Agent.ran).toBe(1);
    expect(messages.find((m) => m.startsWith("system:"))).toContain(`Crosstalk made it again, empty: ${cwd}`);
    expect(messages.at(-1)).toStartWith("agent:done:Answer in");
  } finally {
    await t.done();
  }
});

test("a folder of the person's own that's gone isn't made up: the reply says what to do", async () => {
  const t = setup();
  try {
    const cwd = join(t.elsewhere, "my-project");
    mkdirSync(cwd);
    const room = t.app.chats.create({ provider: "claude", name: "My project", cwd });
    rmSync(cwd, { recursive: true });
    const messages = await t.say(room.id, "carry on");
    expect(existsSync(cwd)).toBe(false);
    expect(Agent.ran).toBe(0);
    expect(messages.at(-1)).toBe(`agent:error:This chat's folder isn't there any more: ${cwd}. Put it back, or pick another folder in the chat's settings, then tap Try again.`);
    expect(t.app.store.listMembers(room.id)[0].status).toBe("error");
    // Once it's back, the chat carries on.
    mkdirSync(cwd);
    expect((await t.say(room.id, "carry on")).at(-1)).toStartWith("agent:done:Answer in");
  } finally {
    await t.done();
  }
});
