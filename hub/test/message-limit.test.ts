import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGE_MAX, messageTooLongWords } from "@crosstalk/shared";
import { App } from "../src/app";
import { startServer } from "../src/server";

test("a message longer than one holds is refused in plain words: how long it is, the most one holds, and what to do instead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-message-limit-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  try {
    const room = app.createRoom({ name: "Long", mode: "direct" });
    const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Test", "Web"))!;
    const post = (text: string) =>
      fetch(`http://127.0.0.1:${server.port}/api/rooms/${room.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: JSON.stringify({ text }) });
    const res = await post("x".repeat(MESSAGE_MAX + 17));
    expect(res.status).toBe(413);
    const { error } = (await res.json()) as { error: string };
    expect(error).toBe(messageTooLongWords(MESSAGE_MAX + 17));
    expect(error).toBe("This message is 100,017 characters long, and one message holds up to 100,000. Attach it as a file instead, or make it shorter.");
    expect(app.store.listMessages(room.id)).toHaveLength(0);
  } finally {
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
