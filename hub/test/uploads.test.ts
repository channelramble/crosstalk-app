import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { startServer } from "../src/server";
import { saveUpload, shareImages } from "../src/uploads";
import type { Upload } from "@crosstalk/shared";

test("uploads require authentication, stay in the room, respect the cap and appear as local message paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-uploads-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  try {
    const room = app.createRoom({ name: "Uploads", mode: "direct" });
    const pairing = await app.auth.createPairingCode();
    const device = (await app.auth.pair(pairing.code, "Test", "Web"))!;
    const base = `http://127.0.0.1:${server.port}`;
    const url = `/api/rooms/${room.id}/uploads`;
    const send = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${device.token}`, ...init.headers } });
    expect((await fetch(base + url, { method: "POST", body: "secret" })).status).toBe(401);
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfsoAAAAASUVORK5CYII=", "base64");
    const result = await send(url + "?name=../../photo.png", { method: "POST", body: bytes });
    expect(result.status).toBe(200);
    const upload = await result.json() as Upload;
    expect(upload.name).toBe("photo.png");
    expect(upload.path.startsWith(join(realpathSync(room.cwd), ".crosstalk", "uploads") + "/")).toBe(true);
    expect(readFileSync(upload.path)).toEqual(bytes);
    expect((await fetch(base + upload.url)).status).toBe(401);
    const image = await send(upload.url);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
    const message = await send(`/api/rooms/${room.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "", attachments: [upload.filename] }) });
    expect(message.status).toBe(200);
    expect((await message.json() as { text: string }).text).toContain(upload.path);
    const other = app.createRoom({ name: "Other" });
    expect((await send(`/api/rooms/${other.id}/messages`, { method: "POST", body: JSON.stringify({ text: "x", attachments: [upload.filename] }) })).status).toBe(404);
    expect((await send(`/api/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ text: "x", attachments: ["../escape"] }) })).status).toBe(400);
    // No size limit: a 20 MB file (over the old 10 MB cap) uploads fine.
    expect((await send(url + "?name=big.bin", { method: "POST", body: new Uint8Array(20 * 1024 * 1024) })).status).toBe(200);
    expect((await send(url + "?name=page.html", { method: "POST", body: "<script>bad</script>" })).status).toBe(200);
    const html = readdirSync(join(room.cwd, ".crosstalk/uploads")).find((f) => f.endsWith("page.html"))!;
    const download = await send(url + "/" + html);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    const empty = await send(url + "?name=empty.txt", { method: "POST", body: "" });
    expect(empty.status).toBe(200);
    expect((await empty.json() as Upload).size).toBe(0);
    const count = readdirSync(join(room.cwd, ".crosstalk/uploads")).length;
    // The only guard is free disk space: an upload that would eat into the reserve is refused and leaves nothing behind.
    process.env.CROSSTALK_UPLOAD_RESERVE_BYTES = String(Number.MAX_SAFE_INTEGER);
    try {
      expect((await send(url + "?name=nospace.bin", { method: "POST", body: "x" })).status).toBe(507);
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(1)); c.close(); } });
      await expect(saveUpload(room, new Request(base + url, { method: "POST", body: stream }), "stream.bin")).rejects.toMatchObject({ status: 507 });
    } finally { delete process.env.CROSSTALK_UPLOAD_RESERVE_BYTES; }
    expect(readdirSync(join(room.cwd, ".crosstalk/uploads")).length).toBe(count);
    const outside = join(dir, "outside"); mkdirSync(outside);
    const linked = app.createRoom({ name: "Linked" });
    symlinkSync(outside, join(linked.cwd, ".crosstalk"));
    expect((await send(`/api/rooms/${linked.id}/uploads?name=escape.txt`, { method: "POST", body: "no" })).status).toBe(400);
    expect(existsSync(join(outside, "uploads"))).toBe(false);
    symlinkSync(join(outside, "secret"), upload.path + ".txt");
    expect((await send(upload.url + ".txt")).status).toBe(400);
  } finally { server.stop(true); await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("folder uploads keep their structure, reject unsafe paths and appear as one folder in the message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-folders-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  try {
    const room = app.createRoom({ name: "Folders", mode: "direct" });
    const pairing = await app.auth.createPairingCode();
    const device = (await app.auth.pair(pairing.code, "Test", "Web"))!;
    const base = `http://127.0.0.1:${server.port}`;
    const send = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${device.token}`, ...init.headers } });
    const id = crypto.randomUUID();
    const put = (rel: string, body = "x") => send(`/api/rooms/${room.id}/uploads?folder=${id}&path=${encodeURIComponent(rel)}`, { method: "POST", body });
    expect((await put("my-app/README.md", "# hi")).status).toBe(200);
    const nested = await put("my-app/src/lib/util.ts", "export {}");
    expect(nested.status).toBe(200);
    const saved = (await nested.json()) as { folder: string; path: string };
    expect(saved.folder).toBe(`${id}/my-app`);
    expect(readFileSync(join(realpathSync(room.cwd), ".crosstalk/uploads", id, "my-app/src/lib/util.ts"), "utf8")).toBe("export {}");
    for (const bad of ["my-app/../../escape.txt", "lonely.txt", "my-app/./x", "my-app/a\u0000b"]) expect((await put(bad)).status).toBe(400);
    expect((await send(`/api/rooms/${room.id}/uploads?folder=../x&path=a/b`, { method: "POST", body: "x" })).status).toBe(400);
    const msg = await send(`/api/rooms/${room.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "look", attachments: [`folder:${saved.folder}`] }) });
    expect(msg.status).toBe(200);
    const folderText = ((await msg.json()) as { text: string }).text;
    expect(folderText).toContain(`[my-app/](/api/rooms/${room.id}/folders/${saved.folder}) (2 files)`);
    // The chat can list the folder and download a file from it, but nothing outside it.
    const listing = (await (await send(`/api/rooms/${room.id}/folders/${saved.folder}`)).json()) as { files: { path: string }[]; total: number };
    expect(listing.total).toBe(2);
    expect(listing.files.map((f) => f.path)).toEqual(["README.md", "src/lib/util.ts"]);
    const file = await send(`/api/rooms/${room.id}/folders/${saved.folder}?file=${encodeURIComponent("src/lib/util.ts")}`);
    expect(await file.text()).toBe("export {}");
    expect(file.headers.get("content-disposition")).toContain("attachment");
    expect((await send(`/api/rooms/${room.id}/folders/${saved.folder}?file=${encodeURIComponent("../../../etc/passwd")}`)).status).toBe(400);
    expect((await fetch(`${base}/api/rooms/${room.id}/folders/${saved.folder}`)).status).toBe(401);
    expect((await send(`/api/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ text: "x", attachments: [`folder:${id}/../..`] }) })).status).toBe(400);
  } finally { server.stop(true); await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test(".zip folders unpack safely: one top folder, loose files wrapped, unsafe paths and links rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-zips-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  // Builds a zip with Python's zipfile, which can write entries `zip` refuses to (like ../ paths and links).
  const makeZip = (entries: { name: string; data?: string; link?: string }[]) => {
    const out = join(dir, `${crypto.randomUUID()}.zip`);
    const script = `import zipfile,json,sys\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor e in json.loads(sys.argv[2]):\n  if e.get("link"):\n    i=zipfile.ZipInfo(e["name"]); i.external_attr=(0o120777<<16); z.writestr(i,e["link"])\n  else: z.writestr(e["name"],e.get("data",""))\nz.close()`;
    const r = Bun.spawnSync(["python3", "-c", script, out, JSON.stringify(entries)]);
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return readFileSync(out);
  };
  try {
    const room = app.createRoom({ name: "Zips", mode: "direct" });
    const pairing = await app.auth.createPairingCode();
    const device = (await app.auth.pair(pairing.code, "Test", "Web"))!;
    const base = `http://127.0.0.1:${server.port}`;
    const up = (name: string, body: Uint8Array) => fetch(`${base}/api/rooms/${room.id}/uploads?unzip=1&name=${encodeURIComponent(name)}`, { method: "POST", body, headers: { authorization: `Bearer ${device.token}` } });
    const one = await up("Project.zip", makeZip([{ name: "my-app/README.md", data: "hi" }, { name: "my-app/src/a.ts", data: "x" }, { name: "__MACOSX/my-app/._README.md", data: "junk" }]));
    expect(one.status).toBe(200);
    const saved = (await one.json()) as { folder: string; path: string; files: number };
    expect(saved.folder.endsWith("/my-app")).toBe(true);
    expect(saved.files).toBe(2);
    expect(readFileSync(join(saved.path, "src/a.ts"), "utf8")).toBe("x");
    const loose = (await (await up("notes.zip", makeZip([{ name: "a.txt" }, { name: "b.txt" }]))).json()) as { folder: string };
    expect(loose.folder.endsWith("/notes")).toBe(true);
    expect((await up("evil.zip", makeZip([{ name: "../evil.txt", data: "x" }]))).status).toBe(400);
    expect((await up("link.zip", makeZip([{ name: "f/ok.txt" }, { name: "f/passwd", link: "/etc/passwd" }]))).status).toBe(400);
    expect((await up("bad.zip", new TextEncoder().encode("not a zip"))).status).toBe(400);
    const msg = await fetch(`${base}/api/rooms/${room.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "", attachments: [`folder:${saved.folder}`] }) });
    expect(((await msg.json()) as { text: string }).text).toMatch(/\[my-app\/\]\(\/api\/rooms\/[^)]+\/folders\/[^)]+\) \(2 files\)/);
    // Failed unpacks leave nothing behind.
    const left = readdirSync(join(realpathSync(room.cwd), ".crosstalk/uploads"));
    expect(left.length).toBe(2);
  } finally { server.stop(true); await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("folder uploads: links on the path create nothing outside, retries at the cap work, ZIP junk isn't counted or kept, limits match the UI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-folder-edges-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  try {
    const room = app.createRoom({ name: "Edges", mode: "direct" });
    const pairing = await app.auth.createPairingCode();
    const device = (await app.auth.pair(pairing.code, "Test", "Web"))!;
    const base = `http://127.0.0.1:${server.port}`;
    const send = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${device.token}`, ...init.headers } });
    const uploads = join(realpathSync(room.cwd), ".crosstalk/uploads");
    // A link planted inside a folder upload must not let a later file create directories outside.
    const id = crypto.randomUUID();
    expect((await send(`/api/rooms/${room.id}/uploads?folder=${id}&path=app/a.txt`, { method: "POST", body: "x" })).status).toBe(200);
    const outside = join(dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(uploads, id, "app", "linked"));
    expect((await send(`/api/rooms/${room.id}/uploads?folder=${id}&path=app/linked/deep/b.txt`, { method: "POST", body: "x" })).status).toBe(400);
    expect(readdirSync(outside)).toEqual([]);
    // Resending a file that's already there (a retry) replaces it.
    const full = crypto.randomUUID();
    expect((await send(`/api/rooms/${room.id}/uploads?folder=${full}&path=big/f7.txt`, { method: "POST", body: "first" })).status).toBe(200);
    expect((await send(`/api/rooms/${room.id}/uploads?folder=${full}&path=big/f7.txt`, { method: "POST", body: "again" })).status).toBe(200);
    expect(readFileSync(join(uploads, full, "big/f7.txt"), "utf8")).toBe("again");
    // ZIP junk is neither counted nor unpacked.
    const zipPath = join(dir, "junk.zip");
    const script = `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.writestr("proj/README.md","hi")\nfor i in range(501): z.writestr(f"proj/d{i}/Thumbs.db","j")\nz.close()`;
    expect(Bun.spawnSync(["python3", "-c", script, zipPath]).exitCode).toBe(0);
    const zipped = await send(`/api/rooms/${room.id}/uploads?unzip=1&name=junk.zip`, { method: "POST", body: readFileSync(zipPath) });
    expect(zipped.status).toBe(200);
    expect(((await zipped.json()) as { files: number }).files).toBe(1);
    // There's no cap on how many files and folders one message carries.
    const many: string[] = [];
    for (let i = 0; i < 12; i++) many.push(((await (await send(`/api/rooms/${room.id}/uploads?name=f${i}.txt`, { method: "POST", body: "a" })).json()) as Upload).filename);
    const ok = await send(`/api/rooms/${room.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x", attachments: many }) });
    expect(ok.status).toBe(200);
    const folders = [id, full].map((f, i) => `folder:${f}/${i ? "big" : "app"}`);
    const withFolders = await send(`/api/rooms/${room.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x", attachments: [...many, ...folders, ...folders] }) });
    expect(withFolders.status).toBe(200);
  } finally { server.stop(true); await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test(".zip folders keep every file intact: non-ASCII names, build/ and dist/, empty and deflated files, Windows paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-zip-names-"));
  try {
    const zipPath = join(dir, "names.zip");
    // Deflated entries with UTF-8 names, like the iPhone Files app and macOS Archive Utility produce.
    const script = `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\nfor n,d in [("proj/Résumé & notes #1 [draft].txt","é"*5000),("proj/emoji 🚀.md","x"),("proj/build/out.js","b"),("proj/dist/a.js","d"),("proj/empty.txt",""),("proj\\\\win\\\\path.txt","w")]: z.writestr(n,d)\nz.close()`;
    expect(Bun.spawnSync(["python3", "-c", script, zipPath]).exitCode).toBe(0);
    const { saveZipFolder } = await import("../src/uploads");
    const room = { id: "r", name: "t", cwd: dir } as never;
    const saved = await saveZipFolder(room, new Request("http://x/", { method: "POST", body: readFileSync(zipPath) }), "names.zip");
    expect(saved.files).toBe(6);
    expect(readFileSync(join(saved.path, "Résumé & notes #1 [draft].txt"), "utf8")).toBe("é".repeat(5000));
    expect(readFileSync(join(saved.path, "emoji 🚀.md"), "utf8")).toBe("x");
    expect(readFileSync(join(saved.path, "build/out.js"), "utf8")).toBe("b");
    expect(readFileSync(join(saved.path, "win/path.txt"), "utf8")).toBe("w");
    // A damaged archive is rejected and leaves nothing behind.
    const bytes = readFileSync(zipPath);
    bytes[30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28) + 3] ^= 0xff; // inside the first file's data
    await expect(saveZipFolder(room, new Request("http://x/", { method: "POST", body: bytes }), "bad.zip")).rejects.toMatchObject({ status: 400 });
    expect(readdirSync(join(realpathSync(dir), ".crosstalk/uploads")).length).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("folder review fixes: links can't escape, ( ) names link correctly, listing pages, legacy ZIP names decode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-folder-fixes-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  try {
    const room = app.createRoom({ name: "Fixes", mode: "direct" });
    const pairing = await app.auth.createPairingCode();
    const device = (await app.auth.pair(pairing.code, "Test", "Web"))!;
    const base = `http://127.0.0.1:${server.port}`;
    const send = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${device.token}`, ...init.headers } });
    const uploads = join(realpathSync(room.cwd), ".crosstalk/uploads");
    mkdirSync(uploads, { recursive: true });
    // An upload-ID directory that's really a link to somewhere else can't be listed or downloaded from.
    const outside = join(dir, "outside", "app");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret");
    const linkId = crypto.randomUUID();
    symlinkSync(join(dir, "outside"), join(uploads, linkId));
    expect((await send(`/api/rooms/${room.id}/folders/${linkId}/app`)).status).toBe(400);
    expect((await send(`/api/rooms/${room.id}/folders/${linkId}/app?file=secret.txt`)).status).toBe(400);
    // Folder names with parentheses produce working links.
    for (const name of ["app)", "app(", "my (app)"]) {
      const id = crypto.randomUUID();
      expect((await send(`/api/rooms/${room.id}/uploads?folder=${id}&path=${encodeURIComponent(`${name}/a.txt`)}`, { method: "POST", body: "x" })).status).toBe(200);
      const msg = await send(`/api/rooms/${room.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "", attachments: [`folder:${id}/${name}`] }) });
      const text = ((await msg.json()) as { text: string }).text;
      const href = text.match(/\]\((\/api\/rooms\/[^)]+)\)/)![1];
      expect(href).not.toMatch(/[()]/);
      const listing = (await (await send(href)).json()) as { files: { path: string }[] };
      expect(listing.files.map((f) => f.path)).toEqual(["a.txt"]);
    }
    // Listing pages through big folders.
    const big = crypto.randomUUID();
    mkdirSync(join(uploads, big, "big"), { recursive: true });
    for (let i = 0; i < 1500; i++) writeFileSync(join(uploads, big, "big", `f${String(i).padStart(4, "0")}.txt`), "x");
    const first = (await (await send(`/api/rooms/${room.id}/folders/${big}/big`)).json()) as { files: { path: string }[]; total: number };
    const second = (await (await send(`/api/rooms/${room.id}/folders/${big}/big?offset=1000`)).json()) as { files: { path: string }[] };
    expect(first.total).toBe(1500);
    expect(first.files.length + second.files.length).toBe(1500);
    expect(second.files[0].path).toBe("f1000.txt");
    // A legacy ZIP (CP437 names, no UTF-8 flag) keeps its accented names. Python always flags non-ASCII names as
    // UTF-8, so the test writes a placeholder name and patches in é's CP437 byte (0x82).
    const zipPath = join(dir, "legacy.zip");
    expect(Bun.spawnSync(["python3", "-c", `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.writestr("proj/cafX.txt","c")\nz.close()\nb=open(sys.argv[1],"rb").read().replace(b"cafX",bytes([0x63,0x61,0x66,0x82]))\nopen(sys.argv[1],"wb").write(b)`, zipPath]).exitCode).toBe(0);
    expect(readFileSync(zipPath).readUInt16LE(6) & 0x0800).toBe(0); // really written without the UTF-8 flag
    const zipped = (await (await send(`/api/rooms/${room.id}/uploads?unzip=1&name=legacy.zip`, { method: "POST", body: readFileSync(zipPath) })).json()) as { path: string };
    expect(readFileSync(join(zipped.path, "café.txt"), "utf8")).toBe("c");
  } finally { server.stop(true); await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("browser-made ZIP64 archives unpack intact, and archives past 65,535 entries list fully", async () => {
  // The browser packer, loaded by path so the hub's type check doesn't pull in DOM types.
  const { makeZip } = await import(String("../../web/src/zip"));
  const { listZip } = await import("../src/unzip");
  const { saveZipFolder } = await import("../src/uploads");
  const dir = mkdtempSync(join(tmpdir(), "ct-zip64-"));
  try {
    const entries = ["app/a.txt", "app/sub/é.md", "app/empty.txt"].map((rel: string, i: number) => ({ rel, file: new File([i === 2 ? "" : `data ${i} `.repeat(1000)], rel) }));
    const zip = Buffer.from(await (await makeZip(entries, undefined, true)).arrayBuffer());
    const zipPath = join(dir, "forced64.zip");
    writeFileSync(zipPath, zip);
    // An independent reader agrees the archive is valid ZIP64.
    const py = Bun.spawnSync(["python3", "-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.namelist()))", zipPath]);
    expect(py.stdout.toString().trim()).toBe("3");
    const saved = await saveZipFolder({ id: "r", name: "t", cwd: dir } as never, new Request("http://x/", { method: "POST", body: zip }), "forced64.zip");
    expect(saved.files).toBe(3);
    expect(readFileSync(join(saved.path, "sub/é.md"), "utf8")).toBe("data 1 ".repeat(1000));
    // More entries than classic ZIP can count switches to ZIP64 records on its own.
    const many = Array.from({ length: 70_000 }, (_, i: number) => ({ rel: `big/f${i}.txt`, file: new File(["x"], "f") }));
    const manyPath = join(dir, "many.zip");
    writeFileSync(manyPath, Buffer.from(await (await makeZip(many)).arrayBuffer()));
    expect((await listZip(manyPath)).length).toBe(70_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000);

test("uploads never eat into the disk reserve, even without a length; interrupted folder retries keep the saved file", async () => {
  const { saveUpload, saveFolderFile } = await import("../src/uploads");
  const { statfsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "ct-reserve-"));
  const room = { id: "r", name: "t", cwd: dir } as never;
  const uploads = () => join(realpathSync(dir), ".crosstalk/uploads");
  const chunked = (total: number) => new ReadableStream<Uint8Array>({
    pull(c) { if (total <= 0) return c.close(); const n = Math.min(total, 1024 * 1024); total -= n; c.enqueue(new Uint8Array(n)); },
  });
  try {
    // Pretend only 16 MB is spare: a 32 MB upload with no Content-Length must stop, leaving nothing behind.
    const s = statfsSync(dir);
    process.env.CROSSTALK_UPLOAD_RESERVE_BYTES = String(Number(s.bavail) * Number(s.bsize) - 16 * 1024 * 1024);
    try {
      await expect(saveUpload(room, new Request("http://x/", { method: "POST", body: chunked(32 * 1024 * 1024) }), "big.bin")).rejects.toMatchObject({ status: 507 });
      expect(readdirSync(uploads())).toEqual([]);
    } finally { delete process.env.CROSSTALK_UPLOAD_RESERVE_BYTES; }
    // A retry that breaks halfway leaves the earlier copy in place, with no temporary files.
    const id = crypto.randomUUID();
    await saveFolderFile(room, new Request("http://x/", { method: "POST", body: "original" }), id, "app/a.txt");
    let sent = 0;
    const broken = new ReadableStream<Uint8Array>({ pull(c) { if (sent++ === 0) c.enqueue(new Uint8Array(1024)); else c.error(new Error("connection dropped")); } });
    await expect(saveFolderFile(room, new Request("http://x/", { method: "POST", body: broken, duplex: "half" } as RequestInit), id, "app/a.txt")).rejects.toThrow();
    expect(readFileSync(join(uploads(), id, "app/a.txt"), "utf8")).toBe("original");
    expect(readdirSync(join(uploads(), id, "app"))).toEqual(["a.txt"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agents' file links download from the project folder, and only from there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-project-files-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  try {
    const room = app.createRoom({ name: "Files", mode: "direct" });
    const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Test", "Web"))!;
    const base = `http://127.0.0.1:${server.port}`;
    const get = (p: string, auth = true) => fetch(`${base}/api/rooms/${room.id}/files?path=${encodeURIComponent(p)}`, { headers: auth ? { authorization: `Bearer ${device.token}` } : {} });
    mkdirSync(join(room.cwd, "dist"), { recursive: true });
    writeFileSync(join(room.cwd, "release.zip"), "zipdata");
    writeFileSync(join(room.cwd, "dist", "app v2.zip"), "app");
    const abs = await get(join(room.cwd, "release.zip"));
    expect(abs.status).toBe(200);
    expect(await abs.text()).toBe("zipdata");
    expect(abs.headers.get("content-disposition")).toContain("attachment");
    expect(await (await get("dist/app v2.zip")).text()).toBe("app");
    expect((await get(join(room.cwd, "release.zip"), false)).status).toBe(401);
    expect((await get("../../etc/passwd")).status).toBe(403);
    expect((await get("/etc/hosts")).status).toBe(403);
    symlinkSync("/etc/hosts", join(room.cwd, "sneaky"));
    expect((await get("sneaky")).status).toBe(403);
    expect((await get("dist")).status).toBe(400);
    expect((await get("missing.zip")).status).toBe(404);
  } finally { server.stop(true); await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("uploads that never made it into a message are cleaned up after a day; sent ones are kept", async () => {
  const { utimesSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "ct-cleanup-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  try {
    const room = app.createRoom({ name: "Tidy", mode: "direct" });
    const { saveUpload, saveFolderFile } = await import("../src/uploads");
    const sent = await saveUpload(room, new Request("http://x/", { method: "POST", body: "keep" }), "sent.txt");
    const unsent = await saveUpload(room, new Request("http://x/", { method: "POST", body: "drop" }), "unsent.txt");
    const fresh = await saveUpload(room, new Request("http://x/", { method: "POST", body: "new" }), "fresh.txt");
    const folderId = crypto.randomUUID();
    await saveFolderFile(room, new Request("http://x/", { method: "POST", body: "x" }), folderId, "proj/a.txt");
    app.engine.postHumanMessage(room.id, `look\\n\\nAttachments:\\n- [sent.txt](${sent.url})`, "Mac");
    // Age everything but `fresh` past the cutoff.
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    const uploads = join(realpathSync(room.cwd), ".crosstalk/uploads");
    for (const name of [sent.filename, unsent.filename, folderId]) utimesSync(join(uploads, name), old, old);
    expect(app.cleanupUploads()).toBe(2); // the unsent file and the unsent folder
    expect(readdirSync(uploads).sort()).toEqual([fresh.filename, sent.filename].sort());
    expect(app.cleanupUploads()).toBe(0);
  } finally { await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("single-file uploads keep their original names in chat and downloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-names-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const server = startServer(app);
  try {
    const room = app.createRoom({ name: "Names", mode: "direct" });
    const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "T", "Web"))!;
    const base = `http://127.0.0.1:${server.port}`;
    const H = { authorization: `Bearer ${device.token}` };
    const name = "Résumé & notes #1 (draft) [v2].txt";
    const up = (await (await fetch(`${base}/api/rooms/${room.id}/uploads?name=${encodeURIComponent(name)}`, { method: "POST", body: "x", headers: H })).json()) as Upload;
    expect(up.name).toBe(name);
    expect(up.url).not.toMatch(/[()]/);
    const dl = await fetch(base + up.url, { headers: H });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    const msg = (await (await fetch(`${base}/api/rooms/${room.id}/messages`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ text: "", attachments: [up.filename] }) })).json()) as { text: string };
    expect(msg.text).toContain(`- [Résumé & notes #1 (draft) \\[v2\\].txt](${up.url})`);
    // Very long names are shortened, keeping the extension.
    const long = (await (await fetch(`${base}/api/rooms/${room.id}/uploads?name=${encodeURIComponent("é".repeat(300) + ".pdf")}`, { method: "POST", body: "x", headers: H })).json()) as Upload;
    expect(long.name.endsWith(".pdf")).toBe(true);
    expect(new TextEncoder().encode(long.filename).length).toBeLessThan(255);
  } finally { server.stop(true); await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("cleanup never follows a link at .crosstalk, and rooms sharing a folder keep each other's sent uploads", async () => {
  const { utimesSync } = await import("node:fs");
  const { cleanupUploads } = await import("../src/uploads");
  const dir = mkdtempSync(join(tmpdir(), "ct-cleanup-safety-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  try {
    // A project whose .crosstalk is a link to somewhere else: an old, UUID-named file there must survive.
    const outside = join(dir, "outside");
    mkdirSync(join(outside, "uploads"), { recursive: true });
    const victim = join(outside, "uploads", `${crypto.randomUUID()}_precious.txt`);
    writeFileSync(victim, "keep me");
    utimesSync(victim, old, old);
    const project = join(dir, "linked-project");
    mkdirSync(project);
    symlinkSync(outside, join(project, ".crosstalk"));
    expect(cleanupUploads({ cwd: project }, [])).toBe(0);
    expect(existsSync(victim)).toBe(true);

    // Two rooms on one folder: a file sent in room B must not be swept by room A.
    const a = app.createRoom({ name: "A", mode: "direct" });
    const b = app.createRoom({ name: "B", mode: "direct", cwd: a.cwd });
    const { saveUpload } = await import("../src/uploads");
    const sentInB = await saveUpload(b, new Request("http://x/", { method: "POST", body: "b" }), "b.txt");
    const unsent = await saveUpload(a, new Request("http://x/", { method: "POST", body: "a" }), "a.txt");
    app.engine.postHumanMessage(b.id, `Attachments:\\n- [b.txt](${sentInB.url})`, "Mac");
    const uploads = join(realpathSync(a.cwd), ".crosstalk/uploads");
    for (const f of [sentInB.filename, unsent.filename]) utimesSync(join(uploads, f), old, old);
    expect(app.cleanupUploads()).toBe(1);
    expect(readdirSync(uploads)).toEqual([sentInB.filename]);
  } finally { await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("images an agent links in its reply are copied into the chat, from anywhere on the hub; code and non-images are left alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-share-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  try {
    const room = app.createRoom({ name: "Share", mode: "direct" });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfsoAAAAASUVORK5CYII=", "base64");
    // Outside the room's folder, in a folder with a space in its name.
    const elsewhere = join(dir, "other project");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "shot.png"), png);
    writeFileSync(join(room.cwd, "local.png"), png);
    writeFileSync(join(room.cwd, "fake.png"), "not an image at all");
    writeFileSync(join(room.cwd, "notes.txt"), "text");
    const uploads = join(realpathSync(room.cwd), ".crosstalk", "uploads");
    const urlOf = (name: string) => new RegExp(`/api/rooms/${room.id}/uploads/[a-f0-9-]{36}_${name.replace(".", "\\.")}`);

    const out = shareImages(room, `Here:\n\n![Main screen](${elsewhere}/shot.png)\n\nAnd [the local one](local.png) again ![](./local.png).`);
    expect(out).toMatch(new RegExp(`^Here:\\n\\n!\\[Main screen\\]\\(${urlOf("shot.png").source}\\)`));
    expect(out).toMatch(new RegExp(`\\[the local one\\]\\(${urlOf("local.png").source}\\)`));
    // Unnamed images get the file's name; the same file linked twice is copied once.
    expect(out).toMatch(new RegExp(`!\\[local\\.png\\]\\(${urlOf("local.png").source}\\)`));
    const copies = readdirSync(uploads);
    expect(copies.length).toBe(2);
    for (const f of copies) expect(readFileSync(join(uploads, f))).toEqual(png);
    // The chat keeps its copy when the original changes.
    writeFileSync(join(elsewhere, "shot.png"), "changed");
    expect(readFileSync(join(uploads, copies.find((f) => f.endsWith("_shot.png"))!))).toEqual(png);

    // Already in this chat's uploads (or linked by its chat URL): used as it is, nothing copied.
    const inUploads = join(uploads, copies[0]);
    expect(shareImages(room, `![x](${inUploads})`)).toBe(`![x](/api/rooms/${room.id}/uploads/${copies[0]})`);
    const chatUrl = `![x](/api/rooms/${room.id}/uploads/${copies[0]})`;
    expect(shareImages(room, chatUrl)).toBe(chatUrl);
    expect(readdirSync(uploads).length).toBe(2);

    // Left as written: code, missing files, files that aren't really images, other files, web images, file:// outside code is shared.
    const untouched = [
      "```\n![a](local.png)\n```",
      "`![a](local.png)`",
      "![gone](missing.png)",
      "![fake](fake.png)",
      "[notes](notes.txt)",
      "![web](https://example.com/a.png)",
      "[![build](https://example.com/badge.png)](https://example.com/ci)",
    ];
    for (const t of untouched) expect(shareImages(room, t)).toBe(t);
    expect(shareImages(room, `![f](file://${room.cwd}/local.png)`)).toMatch(urlOf("local.png"));
    // An image wrapped in a link to itself shows once, as the image.
    expect(shareImages(room, "[![a](local.png)](local.png)")).toMatch(new RegExp(`^!\\[a\\]\\(${urlOf("local.png").source}\\)$`));
  } finally { await app.engine.shutdown(); app.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
