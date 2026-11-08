// Fakes for the model pool's tests (docs/MODEL-POOL.md), on 127.0.0.1 only: a fake GitHub (release JSON with sha256
// digests, release files behind a redirect like the real one), a fake Hugging Face (model info, the file tree in pages,
// downloads redirected to a separate storage origin that honours Range, gated repos that need the token), and fake
// llama.cpp release tarballs (made with tar -czf) holding the fake llama-server and ggml-rpc-server.
//
// Point the hub at them before calling it (the pool reads these when it runs, not at import):
//   process.env.CROSSTALK_GITHUB_API = gh.api; process.env.CROSSTALK_LLAMA_RELEASES = gh.releases;
//   process.env.CROSSTALK_HF_URL = hf.url; process.env.CROSSTALK_TAILSCALE_BIN = <copy of fake-tailscale>.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = import.meta.dir;

/** A free TCP port on 127.0.0.1 (never the live hub's 7420). */
export function freePort(): number {
  for (;;) {
    const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = l.port;
    l.stop(true);
    if (port !== 7420 && port >= 1024) return port;
  }
}

/** A copy of one of the fake scripts, run by this Bun (its shebang names it), executable. */
export function installScript(fixture: string, dest: string): string {
  const text = readFileSync(join(FIXTURES, fixture), "utf8");
  writeFileSync(dest, fixture.endsWith("tailscale") ? text : text.replace(/^#!.*\n/, `#!${process.execPath}\n`));
  chmodSync(dest, 0o755);
  return dest;
}

export const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function tar(out: string, cwd: string, entry: string) {
  // No AppleDouble files on macOS.
  const p = Bun.spawn(["tar", "-czf", out, "-C", cwd, entry], { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdout: "ignore", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`tar failed: ${err}`);
}

/**
 * A fake llama.cpp release tarball laid out like the macOS one: llama-<build>/ with the programs and a library at its
 * top. `rpcName: "rpc-server"` makes one like the builds before June 2026.
 */
export async function llamaTarball(dir: string, build: string, opts: { rpcName?: string } = {}): Promise<Uint8Array> {
  const src = join(dir, `src-${build}-${crypto.randomUUID().slice(0, 6)}`);
  const top = join(src, `llama-${build}`);
  mkdirSync(top, { recursive: true });
  installScript("fake-llama-server", join(top, "llama-server"));
  installScript("fake-ggml-rpc-server", join(top, opts.rpcName ?? "ggml-rpc-server"));
  writeFileSync(join(top, "libggml-rpc.dylib"), "fake library");
  writeFileSync(join(top, "LICENSE"), "MIT");
  const out = join(dir, `llama-${build}-${crypto.randomUUID().slice(0, 6)}.tar.gz`);
  await tar(out, src, `llama-${build}`);
  return new Uint8Array(readFileSync(out));
}

/** A fake CUDA runtime companion: libraries in a folder of their own, which the install moves next to the programs. */
export async function cudartTarball(dir: string): Promise<Uint8Array> {
  const src = join(dir, `src-cudart-${crypto.randomUUID().slice(0, 6)}`);
  mkdirSync(join(src, "cudart", "lib"), { recursive: true });
  writeFileSync(join(src, "cudart", "lib", "libcudart.so.12"), "fake cudart");
  writeFileSync(join(src, "cudart", "lib", "libcublas.so.12"), "fake cublas");
  const out = join(dir, `cudart-${crypto.randomUUID().slice(0, 6)}.tar.gz`);
  await tar(out, src, "cudart");
  return new Uint8Array(readFileSync(out));
}

/** A release file; `digest` undefined: its real sha256; null: GitHub lists none; a string: that (a wrong one). */
export interface FakeAsset {
  bytes: Uint8Array;
  digest?: string | null;
}

/** GitHub's release API and downloads for ggml-org/llama.cpp. */
export function fakeGitHub(releases: Record<string, Record<string, FakeAsset>>) {
  const hits: string[] = [];
  let base = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const url = new URL(req.url);
      hits.push(url.pathname);
      let m = /^\/api\/repos\/ggml-org\/llama\.cpp\/releases\/tags\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const assets = releases[m[1]];
        if (!assets) return Response.json({ message: "Not Found", status: "404" }, { status: 404 });
        return Response.json({
          tag_name: m[1],
          name: m[1],
          assets: Object.entries(assets).map(([name, a]) => ({
            name,
            size: a.bytes.length,
            digest: a.digest === undefined ? `sha256:${sha256(a.bytes)}` : a.digest,
            browser_download_url: `${base}/download/${m![1]}/${name}`,
          })),
        });
      }
      // Downloads redirect to GitHub's storage, as the real ones do.
      m = /^\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (m) return releases[m[1]]?.[m[2]] ? Response.redirect(`${base}/objects/${m[1]}/${m[2]}`, 302) : new Response("Not Found", { status: 404 });
      m = /^\/objects\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      const asset = m ? releases[m[1]]?.[m[2]] : undefined;
      if (asset) return new Response(asset.bytes, { headers: { "content-type": "application/octet-stream" } });
      return new Response("Not Found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  return { api: `${base}/api`, releases: `${base}/download`, hits, stop: () => server.stop(true) };
}

export interface FakeRepo {
  gated?: false | "auto" | "manual";
  files: Record<string, Uint8Array>;
  /** Its newest commit (made up from its name when not given). */
  sha?: string;
  /** Earlier commits' files, which /resolve/<commit>/ still serves (a file uploaded again keeps its old bytes there). */
  history?: Record<string, Record<string, Uint8Array>>;
  /** What a search (/api/models?search=) says about it: its downloads, and the parameters and context of its GGUF files. */
  downloads?: number;
  params?: number;
  contextLength?: number;
}

interface Seen {
  path: string;
  range: string | null;
  auth: string | null;
}

/**
 * Hugging Face: /api/models/<repo> (gated, its newest commit as `sha`), /api/models/<repo>/tree/main?recursive=true (in
 * pages of `pageSize`, with a Link header), and /<repo>/resolve/<main or a commit>/<file>, redirected to a storage
 * server on another origin that honours Range; an unknown commit or file is a 404 with X-Error-Code RevisionNotFound or
 * EntryNotFound, as on Hugging Face. A gated repo's files need `Authorization: Bearer <token>` (401 without one, 403
 * with a wrong one). A file named in `cutOnce` ("<repo>/<file>") stops halfway the next time it's sent; one in `slow`
 * comes 32 KB every 40 ms.
 */
export function fakeHuggingFace(repos: Record<string, FakeRepo>, opts: { token?: string; pageSize?: number } = {}) {
  const requests: Seen[] = [];
  const storageRequests: Seen[] = [];
  const cutOnce = new Set<string>();
  const slow = new Set<string>();
  const seen = (req: Request, list: Seen[]) => {
    const url = new URL(req.url);
    list.push({ path: url.pathname + url.search, range: req.headers.get("range"), auth: req.headers.get("authorization") });
  };
  const decode = (path: string) => path.split("/").map(decodeURIComponent).join("/");
  for (const [name, repo] of Object.entries(repos)) repo.sha ??= new Bun.CryptoHasher("sha1").update(`commit of ${name}`).digest("hex");
  /** A repo's files at a commit ("main" or its newest: its files now). */
  const filesAt = (repo: FakeRepo, rev: string) => (rev === "main" || rev === repo.sha ? repo.files : repo.history?.[rev]);

  const storage = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen(req, storageRequests);
      const url = new URL(req.url);
      const m = /^\/files\/([^/]+\/[^/]+)\/([0-9a-f]{40}|main)\/(.+)$/.exec(url.pathname);
      const repo = m ? m[1] : "";
      const file = m ? decode(m[3]) : "";
      const bytes = repos[repo] ? filesAt(repos[repo], m![2])?.[file] : undefined;
      if (!bytes) return new Response("Not Found", { status: 404 });
      if (url.searchParams.get("sig") !== "ok") return new Response("Forbidden", { status: 403 });
      const range = req.headers.get("range");
      let start = 0;
      let end = bytes.length - 1;
      if (range) {
        // "bytes=N-" (the rest, to pick a download up) or "bytes=N-M" (a header's first bytes).
        const r = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!r) return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.length}` } });
        start = Number(r[1]);
        if (r[2]) end = Math.min(end, Number(r[2]));
        if (start >= bytes.length || end < start) return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.length}` } });
      }
      const body = bytes.subarray(start, end + 1);
      const status = range ? 206 : 200;
      const headers: Record<string, string> = { "content-length": String(body.length), "accept-ranges": "bytes", "content-type": "application/octet-stream" };
      if (range) headers["content-range"] = `bytes ${start}-${end}/${bytes.length}`;
      if (cutOnce.delete(`${repo}/${file}`)) {
        const half = body.subarray(0, Math.floor(body.length / 2));
        let sent = false;
        const stream = new ReadableStream<Uint8Array>({
          async pull(c) {
            if (!sent) {
              sent = true;
              c.enqueue(half);
              return;
            }
            await Bun.sleep(50);
            c.close(); // the connection ends early: fewer bytes than its Content-Length
          },
        });
        return new Response(stream, { status, headers });
      }
      if (slow.has(`${repo}/${file}`)) {
        let at = 0;
        const stream = new ReadableStream<Uint8Array>({
          async pull(c) {
            if (at >= body.length) return c.close();
            if (at) await Bun.sleep(40);
            c.enqueue(body.subarray(at, at + 32 * 1024));
            at += 32 * 1024;
          },
        });
        return new Response(stream, { status, headers });
      }
      return new Response(body, { status, headers });
    },
  });

  const hf = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen(req, requests);
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      // A search, as Settings → Local models asks it: GGUF repos whose names match, most downloaded first.
      if (url.pathname === "/api/models") {
        const q = (url.searchParams.get("search") ?? "").toLowerCase();
        const hits = Object.entries(repos)
          .filter(([name]) => name.toLowerCase().includes(q))
          .sort((a, b) => (b[1].downloads ?? 0) - (a[1].downloads ?? 0))
          .slice(0, Number(url.searchParams.get("limit") ?? 20))
          .map(([name, r]) => ({ _id: name, id: name, downloads: r.downloads ?? 0, gated: r.gated ?? false, gguf: { total: r.params ?? null, architecture: "qwen3", context_length: r.contextLength ?? null } }));
        return Response.json(hits);
      }
      let m = /^\/api\/models\/([^/]+\/[^/]+)$/.exec(url.pathname);
      if (m) {
        const repo = repos[m[1]];
        // Like Hugging Face: a repo that isn't there looks like one that needs signing in.
        if (!repo) return Response.json({ error: "Repository Not Found" }, { status: 401 });
        return Response.json({ id: m[1], sha: repo.sha, gated: repo.gated ?? false, private: false, siblings: Object.keys(repo.files).map((rfilename) => ({ rfilename })) });
      }
      m = /^\/api\/models\/([^/]+\/[^/]+)\/tree\/main$/.exec(url.pathname);
      if (m) {
        const repo = repos[m[1]];
        if (!repo) return Response.json({ error: "Repository Not Found" }, { status: 401 });
        const all = Object.entries(repo.files).map(([path, bytes]) => ({
          type: "file",
          oid: sha256(bytes).slice(0, 40),
          size: bytes.length,
          path,
          ...(path.endsWith(".gguf") ? { lfs: { oid: sha256(bytes), size: bytes.length, pointerSize: 134 } } : {}),
        }));
        const folders = [...new Set(Object.keys(repo.files).filter((p) => p.includes("/")).map((p) => p.split("/")[0]))].map((path) => ({ type: "directory", oid: "0".repeat(40), size: 0, path }));
        const list = [...folders, ...all];
        const size = opts.pageSize ?? 1000;
        const cursor = Number(url.searchParams.get("cursor") ?? 0);
        const headers: Record<string, string> = {};
        if (cursor + size < list.length) headers.link = `<${base}/api/models/${m[1]}/tree/main?recursive=true&cursor=${cursor + size}>; rel="next"`;
        return Response.json(list.slice(cursor, cursor + size), { headers });
      }
      m = /^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (m) {
        const repo = repos[m[1]];
        const rev = m[2];
        const file = decode(m[3]);
        const files = repo ? filesAt(repo, rev) : undefined;
        if (repo && !files) return Response.json({ error: "Revision Not Found" }, { status: 404, headers: { "x-error-code": "RevisionNotFound" } });
        if (!files?.[file]) return Response.json({ error: "Entry not found" }, { status: 404, headers: { "x-error-code": "EntryNotFound" } });
        if (repo!.gated && auth !== `Bearer ${opts.token}`) {
          return Response.json({ error: auth ? `Access to model ${m[1]} is restricted and you are not in the authorized list.` : `Access to model ${m[1]} is restricted. You must have access to it and be authenticated to access it. Please log in.` }, { status: auth ? 403 : 401 });
        }
        // Like Hugging Face: the file's size on the way (the storage's streamed answers don't say it).
        return new Response(null, { status: 302, headers: { location: `${storageBase}/files/${m[1]}/${rev === "main" ? repo!.sha : rev}/${m[3]}?sig=ok`, "x-linked-size": String(files[file].length) } });
      }
      return Response.json({ error: "Not Found" }, { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${hf.port}`;
  const storageBase = `http://127.0.0.1:${storage.port}`;
  return {
    url: base,
    requests,
    storageRequests,
    cutOnce,
    slow,
    stop() {
      hf.stop(true);
      storage.stop(true);
    },
  };
}
