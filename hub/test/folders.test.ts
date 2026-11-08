import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { App } from "../src/app";
import { startServer } from "../src/server";

test("folders: chats' folders newest first, then the workspaces folder's by name, no hidden, missing or temp ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-folders-"));
  const root = join(dir, "workspaces");
  mkdirSync(join(root, "Zeta"), { recursive: true });
  mkdirSync(join(root, "alpha"));
  mkdirSync(join(root, ".hidden"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: root, maxHopsDefault: 6 } });
  const server = startServer(app);
  try {
    const home = process.env.HOME!;
    // Chats in real folders (the home folder and its parent exist everywhere) and one in a folder that's gone. Set
    // straight in the database: making a chat creates its folder, and these must not touch the real ones.
    const older = app.createRoom({ name: "Old", mode: "direct" });
    const newer = app.createRoom({ name: "New", mode: "direct" });
    const gone = app.createRoom({ name: "Gone", mode: "direct" });
    const parent = dirname(home);
    app.store.db.run("UPDATE rooms SET cwd = ?, updated_at = ? WHERE id = ?", [parent, 1000, older.id]);
    app.store.db.run("UPDATE rooms SET cwd = ?, updated_at = ? WHERE id = ?", [home, 2000, newer.id]);
    app.store.db.run("UPDATE rooms SET cwd = ?, updated_at = ? WHERE id = ?", [join(home, "no-such-folder-ct-test"), 3000, gone.id]);

    const r = app.folders();
    expect(r.root).toBe(root);
    const paths = r.folders.map((f) => f.path);
    expect(paths.slice(0, 2)).toEqual([home, parent]);
    expect(r.folders[0]!.usedAt).toBe(2000);
    expect(paths).not.toContain(join(home, "no-such-folder-ct-test"));
    expect(paths).not.toContain(join(root, ".hidden"));
    const inRoot = r.folders.filter((f) => f.path.startsWith(root + "/"));
    expect(inRoot.map((f) => f.path)).toEqual(expect.arrayContaining([join(root, "alpha"), join(root, "Zeta")]));
    expect(inRoot.every((f) => f.usedAt === null || paths.indexOf(f.path) < 2)).toBe(true);
    // Sorted by name, case-insensitively where the locale does.
    expect(paths.indexOf(join(root, "alpha"))).toBeLessThan(paths.indexOf(join(root, "Zeta")));

    // Over the API, for a paired device only.
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/api/folders`)).status).toBe(401);
    const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "T", "Web"))!;
    const res = await fetch(`${base}/api/folders`, { headers: { authorization: `Bearer ${device.token}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).folders.map((f: any) => f.path)).toEqual(paths);
  } finally {
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
