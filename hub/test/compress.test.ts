// Smaller answers (hub/src/compress.ts): the app's files and big JSON go out compressed where the browser takes it,
// and exactly as before where it doesn't.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { App } from "../src/app";
import { compressedFile, compressedJson, compressible, pickEncoding } from "../src/compress";
import { startServer } from "../src/server";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

test("what a request can take: brotli first, then gzip, else nothing", () => {
  expect(pickEncoding("gzip, deflate, br")).toBe("br");
  expect(pickEncoding("gzip, deflate")).toBe("gzip");
  expect(pickEncoding("identity")).toBeNull();
  expect(pickEncoding(null)).toBeNull();
  // "br" inside another word isn't brotli.
  expect(pickEncoding("zebra")).toBeNull();
});

test("only text is compressed, once per file and encoding, and it reads back the same", async () => {
  expect([".js", ".css", ".html", ".svg", ".json", ".webmanifest"].every((e) => compressible(`/assets/x${e}`))).toBe(true);
  expect([".png", ".woff2", ".ico"].some((e) => compressible(`/x${e}`))).toBe(false);
  const text = "const hello = 'crosstalk';\n".repeat(400);
  let reads = 0;
  const read = async () => (reads++, new TextEncoder().encode(text));
  const br = (await compressedFile("k1", "/assets/app.js", read, "br, gzip"))!;
  expect(br.encoding).toBe("br");
  expect(br.bytes.length).toBeLessThan(text.length / 10);
  expect(brotliDecompressSync(br.bytes).toString()).toBe(text);
  const gz = (await compressedFile("k1", "/assets/app.js", read, "gzip"))!;
  expect(gunzipSync(gz.bytes).toString()).toBe(text);
  await compressedFile("k1", "/assets/app.js", read, "br");
  expect(reads).toBe(2); // once for brotli, once for gzip, never again
  expect(await compressedFile("k2", "/icon.png", read, "br")).toBeNull();
  expect(await compressedFile("k3", "/tiny.js", async () => new Uint8Array(20), "br")).toBeNull();
  expect(await compressedFile("k1", "/assets/app.js", read, null)).toBeNull();
});

test("a small JSON answer is left alone; a big one is compressed and reads back the same", () => {
  expect(compressedJson(JSON.stringify({ ok: true }), "br, gzip")).toBeNull();
  const big = JSON.stringify({ messages: Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, text: "The login page hangs after I tap Sign in." })) });
  const packed = compressedJson(big, "gzip")!;
  expect(packed.encoding).toBe("gzip");
  expect(packed.body.length).toBeLessThan(big.length / 4);
  expect(gunzipSync(packed.body).toString()).toBe(big);
  expect(compressedJson(big, "identity")).toBeNull();
});

test("over the API: a big answer comes compressed when asked for, plain when not, and says it varies", async () => {
  const work = mkdtempSync(join(tmpdir(), "ct-compress-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: work, maxHopsDefault: 6 } });
  const server = startServer(app);
  cleanups.push(async () => {
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
    rmSync(work, { recursive: true, force: true });
  });
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Phone", "Web"))!;
  for (let i = 0; i < 40; i++) app.chats.create({ provider: "claude", name: `A chat with a name long enough to matter ${i}`, model: "claude-test" });
  const base = `http://127.0.0.1:${server.port}`;
  const get = (enc: string) => fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${device.token}`, "accept-encoding": enc }, decompress: false } as RequestInit);
  const plain = await get("identity");
  expect(plain.headers.get("content-encoding")).toBeNull();
  const plainBody = await plain.text();
  const packed = await get("gzip");
  expect(packed.headers.get("content-encoding")).toBe("gzip");
  expect(packed.headers.get("vary")).toBe("accept-encoding");
  const bytes = new Uint8Array(await packed.arrayBuffer());
  expect(bytes.length).toBeLessThan(plainBody.length / 3);
  expect(JSON.parse(gunzipSync(bytes).toString()).rooms).toHaveLength(40);
  // A small answer isn't touched.
  const small = await fetch(`${base}/api/health`, { headers: { "accept-encoding": "gzip" }, decompress: false } as RequestInit);
  expect(small.headers.get("content-encoding")).toBeNull();
});
