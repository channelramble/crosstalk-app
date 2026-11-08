#!/usr/bin/env bun
// Stand-in for the image editor's ComfyUI server, enough of it to drive the real editor page
// (editor/phone_editor/editor.html) in a browser: web/e2e/editorSession.spec.ts.
//
// Shapes come from the live server's own source (ComfyUI 0.42.0), not from guesses:
//   /editor                     custom_nodes/phone_editor/__init__.py (FileResponse, Cache-Control: no-store)
//   /ws?clientId=               server.py websocket_handler: one socket per client id, the old one dropped;
//                               "status" and "execution_interrupted" are broadcast, other execution events go to
//                               the submitting client's id only
//   POST /prompt                server.py post_prompt: a client-supplied prompt_id must be a canonical lowercase
//                               UUID (comfy_execution/jobs.py validate_job_id) or it answers 400 invalid_prompt_id;
//                               the graph is checked as validate_prompt would for what the page sends (known node
//                               types, links to nodes that exist, LoadImage's file there -- with its subfolder)
//   GET /queue                  [number, prompt_id, prompt, extra_data, outputs] per item
//   GET /history/{prompt_id}    { <id>: { prompt, outputs, status: { status_str, completed, messages } } }, messages
//                               [name, { prompt_id, timestamp, ... }] as execution.py add_message keeps them
//   POST /api/jobs/{id}/cancel  server.py cancel_job_by_id: a running job is interrupted (its history gets
//                               status_str "error" and an execution_interrupted message), a pending one dequeued;
//                               { cancelled } is false for a finished or unknown id (200, idempotent)
//   POST /interrupt             with { prompt_id }: only that job, and only while it runs
//   POST /upload/image          { name, subfolder, type }; a subfolder is created
//   GET|HEAD /view?filename&subfolder&type
//   SaveImage                   folder_paths.get_save_image_path: a prefix "a/b" saves output/a/b_00001_.png, the
//                               counter one past the highest already there
//   /userdata/{file}            app/user_manager.py: GET 404/attachment+nosniff, POST ?overwrite=false -> 409,
//                               DELETE 204/404, GET /userdata?dir=... lists, POST /userdata/{file}/move/{dest}
//                               (?overwrite=false -> 409 when dest exists, 404 when file doesn't; checked and
//                               moved with nothing awaited in between, as the real handler does)
// Every route also answers under /api, as server.py add_routes does.
//
// What it does is read for every request from its config file (default fake-comfy-editor.json beside its cwd):
//   editMs: how long an edit takes (300)         editError: the edit fails with this
//   steps: how many steps an edit is (4). A stop is honoured only once the step it lands in is done -- ComfyUI
//          checks its interrupt flag as it queues each layer, and on a GPU a step's layers are queued well before
//          they run -- while a "restart" (lose) ends it at once.
//   holdStop: a stop isn't honoured at all while this is set -- the step it landed in is taking minutes, as one can
//             on a slow Mac -- and is at the end of the next step once it isn't
//   The edit itself makes, at the size the model works at, the picture it was given -- scaled up, its red and green
//   kept, its blue set to editBlue (default 0). So every pixel of the result says which pixel of the photo it came
//   from: a result put back at the wrong place or scale shows, pixel by pixel.
//   editColor: [r, g, b] paints the whole picture that one colour instead
//   reject: POST /prompt refuses with this       userdataWrite: answer POST /userdata/{file} with this status
//   uploadFail: answer 500 to an upload whose name contains this
//   emptyOnce: keep the first upload of each name containing this as an empty file and answer 200, as the server does
//              when WebKit sends the form with the picture left out (seen in the tests, under load)
//   lose: forget every job, as a restart would (pictures stay, as they do on disk)
//   stallMs: wait this long before answering POST /userdata/{file} (stallFile: only for that file) -- the
//            window in which two writes cross
//   noMoveRoute / noCancelRoute: answer 405 / 404 there, as a ComfyUI older than those routes would
//   oldInterrupt: POST /interrupt ignores its prompt_id and interrupts whatever runs, as ComfyUI did before
//                 targeted interrupts
// GET /__fake/log lists the uploads, /view reads, queued jobs, cancels and userdata writes it has seen.
// Usage: bun fake-comfy-editor.ts --port 8199 [--config path] [--editor path/to/editor.html]
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { ServerWebSocket } from "bun";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const port = Number(arg("port", "0"));
const configPath = resolve(arg("config", "fake-comfy-editor.json")!);
const editorPath = resolve(arg("editor", join(dirname(import.meta.dir), "..", "..", "editor", "phone_editor", "editor.html"))!);

type Config = {
  editMs?: number;
  steps?: number;
  editError?: string;
  editBlue?: number;
  editColor?: [number, number, number];
  reject?: string;
  userdataWrite?: number;
  uploadFail?: string;
  emptyOnce?: string;
  lose?: boolean;
  stallMs?: number;
  stallFile?: string;
  noMoveRoute?: boolean;
  noCancelRoute?: boolean;
  oldInterrupt?: boolean;
  holdStop?: boolean;
};
let lastLose = false;
function config(): Config {
  try {
    return existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf8")) as Config) : {};
  } catch {
    return {};
  }
}

/** Pictures and the session store live on disk beside the config, as the real server's input/, output/ and user/ do. */
const root = dirname(configPath);
const userdataDir = join(root, "userdata");
const filesDir = join(root, "files");
for (const d of [userdataDir, filesDir]) mkdirSync(d, { recursive: true });
/** One path segment only: ComfyUI's own routes reject anything that could leave the folder. */
const safe = (part: string) => part.replace(/[^A-Za-z0-9._-]/g, "_");

type Ref = { filename: string; subfolder: string; type: string };
type Node = { class_type: string; inputs: Record<string, unknown> };
type Job = {
  id: string;
  number: number;
  prompt: Record<string, Node>;
  extra: Record<string, unknown>;
  at: number;
  client: string | null;
  started: boolean;
  startedAt?: number;
  interrupted?: boolean;
};

const read = (path: string): Uint8Array | null => {
  try {
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  } catch {
    return null;
  }
};
/** Uploaded and produced pictures, as ComfyUI's input/ and output/ folders. */
const files = {
  dir: (type: string, subfolder: string) => join(filesDir, safe(type || "input"), safe(subfolder || "_")),
  path: (r: { filename: string; subfolder?: string; type?: string }) => join(files.dir(r.type || "input", r.subfolder || ""), safe(r.filename)),
  get(r: { filename: string; subfolder?: string; type?: string }) {
    return read(files.path(r));
  },
  set(r: { filename: string; subfolder?: string; type?: string }, body: Uint8Array) {
    const p = files.path(r);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  },
  names(type: string, subfolder: string) {
    try {
      return readdirSync(files.dir(type, subfolder));
    } catch {
      return [];
    }
  },
};
/** The session store, as ComfyUI's user/default folder. */
const userdata = {
  path: (name: string) => join(userdataDir, safe(name)),
  get: (name: string) => read(userdata.path(name)),
  has: (name: string) => existsSync(userdata.path(name)),
  set: (name: string, body: Uint8Array) => writeFileSync(userdata.path(name), body),
  delete: (name: string) => rmSync(userdata.path(name), { force: true }),
  names: () => {
    try {
      return readdirSync(userdataDir);
    } catch {
      return [];
    }
  },
};
const pending: Job[] = [];
let running: Job | null = null;
/** Names emptyOnce has already kept empty. */
const emptied = new Set<string>();
const history = new Map<string, { prompt: unknown[]; outputs: Record<string, { images: Ref[] }>; status: { status_str: string; completed: boolean; messages: unknown[] } }>();
const sockets = new Map<string, ServerWebSocket<{ sid: string }>>();
let number = 0;
const log: Record<string, unknown>[] = [];
const note = (entry: Record<string, unknown>) => {
  log.push({ at: Date.now(), ...entry });
  if (log.length > 2000) log.splice(0, log.length - 2000);
};

const json = (data: unknown, status = 200) => Response.json(data, { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function send(sid: string | null, type: string, data: unknown) {
  const message = JSON.stringify({ type, data });
  if (sid === null) for (const ws of sockets.values()) ws.send(message);
  else sockets.get(sid)?.send(message);
}
/** server.py queue_updated(): a "status" to every socket. */
const queueUpdated = () => send(null, "status", { status: { exec_info: { queue_remaining: pending.length + (running ? 1 : 0) } } });

/** Forgets every job, the way a restarted server would. */
function lose() {
  pending.length = 0;
  running = null;
  history.clear();
  queueUpdated();
}

// ---- pictures, as PNG files (enough of the format for a canvas to read) ----
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A PNG of w×h from its RGBA pixels, row by row. */
function encodePng(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
/** One colour all over, w×h. */
function solidPng(w: number, h: number, [r, g, b]: [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([r, g, b, 255], i * 4);
  return encodePng(w, h, rgba);
}
/**
 * A PNG's pixels as RGBA: 8-bit grey, grey+alpha, RGB or RGBA, not interlaced -- what a browser's canvas.toBlob makes.
 * Anything else throws, and the edit fails saying so.
 */
function decodePng(bytes: Uint8Array): { w: number; h: number; rgba: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let w = 0, h = 0, depth = 0, kind = 0, interlace = 0;
  const data: Uint8Array[] = [];
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
      [w, h, depth, kind, interlace] = [v.getUint32(0), v.getUint32(4), body[8], body[9], body[12]];
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[kind];
  if (depth !== 8 || !channels || interlace) throw new Error(`the stand-in can't read this PNG (depth ${depth}, colour type ${kind}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(data));
  const stride = w * channels;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predict = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter] ?? 0;
      px[y * stride + x] = (line[x] + predict) & 0xff;
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = px.subarray(i * channels, (i + 1) * channels);
    const [r, g, b, alpha] = channels === 4 ? o : channels === 3 ? [o[0], o[1], o[2], 255] : channels === 2 ? [o[0], o[0], o[0], o[1]] : [o[0], o[0], o[0], 255];
    rgba.set([r, g, b, alpha], i * 4);
  }
  return { w, h, rgba };
}
/**
 * The stand-in's edit: the picture it was given, scaled (nearest pixel) to w×h, its red and green kept and its blue
 * set to `blue`. Put back where it came from and at its size, every pixel of it lands on the pixel of the photo it was
 * made from, so its red and green there are the photo's own.
 */
function editedPng(given: Uint8Array, w: number, h: number, blue: number): Uint8Array {
  const src = decodePng(given);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.h - 1, Math.floor(((y + 0.5) * src.h) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.w - 1, Math.floor(((x + 0.5) * src.w) / w));
      const o = (sy * src.w + sx) * 4;
      rgba.set([src.rgba[o], src.rgba[o + 1], blue, 255], (y * w + x) * 4);
    }
  }
  return encodePng(w, h, rgba);
}
/** A PNG's own width and height, from its IHDR. */
function pngSize(bytes: Uint8Array | null): { w: number; h: number } | null {
  if (!bytes || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: view.getUint32(16), h: view.getUint32(20) };
}
/** The size TextEncodeQwenImage21 makes a picture of w×h at `resolution`: about resolution², at multiples of 32. */
function modelSize(w: number, h: number, resolution: number) {
  const ratio = w / h;
  // Python's round(): a half goes to the even neighbour.
  const round = (x: number) => {
    const r = Math.round(x);
    return Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 ? r - 1 : r;
  };
  return {
    w: Math.max(32, round(Math.sqrt(resolution * resolution * ratio) / 32) * 32),
    h: Math.max(32, round(Math.sqrt(resolution * resolution / ratio) / 32) * 32),
  };
}
/** Where SaveImage puts a picture for this prefix: folder_paths.get_save_image_path. */
function saveName(prefix: string): Ref {
  const slash = prefix.lastIndexOf("/");
  const subfolder = slash >= 0 ? prefix.slice(0, slash) : "";
  const base = slash >= 0 ? prefix.slice(slash + 1) : prefix;
  const used = files
    .names("output", subfolder)
    .filter((n) => n.startsWith(`${base}_`) && n.endsWith("_.png"))
    .map((n) => Number(n.slice(base.length + 1).split("_")[0]) || 0);
  const counter = (used.length ? Math.max(...used) : 0) + 1;
  return { filename: `${base}_${String(counter).padStart(5, "0")}_.png`, subfolder, type: "output" };
}
/** "sub/name.png" as LoadImage reads it, into a reference to the uploaded file. */
function inputRef(image: string): Ref {
  const slash = image.lastIndexOf("/");
  return { filename: slash >= 0 ? image.slice(slash + 1) : image, subfolder: slash >= 0 ? image.slice(0, slash) : "", type: "input" };
}

async function work() {
  for (;;) {
    const c = config();
    if (c.lose && !lastLose) lose();
    lastLose = !!c.lose;
    if (!running && pending.length) {
      const job = pending.shift()!;
      running = job;
      job.started = true;
      job.startedAt = Date.now();
      queueUpdated();
      const ms = c.editMs ?? 300;
      send(job.client, "execution_start", { prompt_id: job.id, timestamp: job.startedAt });
      send(job.client, "executing", { node: "6", prompt_id: job.id });
      // A stop is honoured once the step it lands in is done, as it is in practice on a GPU; a "restart" ends it at once.
      const steps = Math.max(1, Math.round(c.steps ?? 4));
      run: for (let step = 1; step <= steps; step++) {
        const until = Date.now() + Math.max(1, Math.round(ms / steps));
        while (Date.now() < until) {
          await Bun.sleep(Math.min(40, Math.max(1, until - Date.now())));
          if (running !== job) break run;
        }
        if (job.interrupted && !config().holdStop) break;
        send(job.client, "progress", { value: step, max: steps, prompt_id: job.id });
      }
      // Lost (a "restart") while it ran: nothing is recorded, as nothing would be.
      if (running === job) {
        const start = ["execution_start", { prompt_id: job.id, timestamp: job.startedAt }];
        const item = [job.number, job.id, job.prompt, job.extra, ["8"]];
        let err = config().editError;
        let out: Ref | null = null;
        if (!job.interrupted && !err) {
          // The edit: the picture it was given, at the size the model works at (see editedPng), or one colour.
          try {
            const loaded = files.get(inputRef(String(job.prompt["4"]?.inputs?.image ?? "")));
            const size = pngSize(loaded) ?? { w: 64, h: 64 };
            const resolution = Number(job.prompt["5"]?.inputs?.resolution ?? 1024) || 1024;
            const made = modelSize(size.w, size.h, resolution);
            const now = config();
            const picture = now.editColor || !loaded ? solidPng(made.w, made.h, now.editColor ?? [0, 200, 0]) : editedPng(loaded, made.w, made.h, now.editBlue ?? 0);
            out = saveName(String(job.prompt["8"]?.inputs?.filename_prefix ?? "ComfyUI"));
            files.set(out, picture);
          } catch (e) {
            err = String((e as Error)?.message ?? e);
          }
        }
        if (job.interrupted) {
          const mes = { prompt_id: job.id, node_id: "6", node_type: "KSampler", executed: ["1", "2", "3", "4", "5"], timestamp: Date.now() };
          history.set(job.id, { prompt: item, outputs: {}, status: { status_str: "error", completed: false, messages: [start, ["execution_interrupted", mes]] } });
          send(null, "execution_interrupted", mes);
        } else if (err || !out) {
          const mes = { prompt_id: job.id, node_id: "6", node_type: "KSampler", exception_message: err || "nothing made", exception_type: "RuntimeError", traceback: [], timestamp: Date.now() };
          history.set(job.id, { prompt: item, outputs: {}, status: { status_str: "error", completed: false, messages: [start, ["execution_error", mes]] } });
          send(job.client, "execution_error", mes);
        } else {
          const done = Date.now();
          history.set(job.id, { prompt: item, outputs: { "8": { images: [out] } }, status: { status_str: "success", completed: true, messages: [start, ["execution_success", { prompt_id: job.id, timestamp: done }]] } });
          send(job.client, "executed", { node: "8", output: { images: [out] }, prompt_id: job.id });
          send(job.client, "execution_success", { prompt_id: job.id, timestamp: done });
        }
        running = null;
        queueUpdated();
      }
    }
    await Bun.sleep(40);
  }
}

const KNOWN = new Set(["UnetLoaderGGUF", "CLIPLoaderGGUF", "VAELoader", "LoadImage", "TextEncodeQwenImage21", "KSampler", "VAEDecode", "SaveImage"]);
/** What validate_prompt would refuse in the page's graph, as node_errors. */
function invalid(prompt: Record<string, Node>) {
  const errors: Record<string, { errors: { type: string; message: string; details: string }[]; class_type: string }> = {};
  const fail = (id: string, node: Node, message: string, details: string) => {
    errors[id] = { errors: [...(errors[id]?.errors ?? []), { type: "custom_validation_failed", message, details }], class_type: node.class_type };
  };
  for (const [id, node] of Object.entries(prompt)) {
    if (!node || typeof node !== "object" || !KNOWN.has(node.class_type)) {
      fail(id, node, "Node type not found", String(node?.class_type));
      continue;
    }
    for (const [name, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && !(value[0] in prompt)) fail(id, node, "Required input is missing", `${name} links to node ${value[0]}, which isn't there`);
    }
    if (node.class_type === "LoadImage" && !files.get(inputRef(String(node.inputs?.image ?? "")))) fail(id, node, "Custom validation failed for node", `image - Invalid image file: ${node.inputs?.image}`);
    if (node.class_type === "SaveImage" && typeof node.inputs?.filename_prefix !== "string") fail(id, node, "Required input is missing", "filename_prefix");
  }
  return Object.keys(errors).length ? errors : null;
}

const server = Bun.serve<{ sid: string }>({
  port,
  hostname: "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);
    // server.py add_routes: every route is also served under /api; the jobs routes only there.
    const api = url.pathname.startsWith("/api/");
    const path = api ? url.pathname.slice(4) : url.pathname;
    const c = config();
    if (c.lose && !lastLose) {
      lose();
      lastLose = true;
    } else if (!c.lose) lastLose = false;

    if (path === "/__fake/log") return json(log);

    if (path === "/ws") {
      // server.py: a clientId already in use drops the old socket rather than sharing it.
      const sid = url.searchParams.get("clientId") || crypto.randomUUID();
      if (srv.upgrade(req, { data: { sid } })) return new Response(null, { status: 101 });
      return new Response("expected a websocket", { status: 400 });
    }

    if (req.method === "GET" && path === "/editor") {
      return new Response(readFileSync(editorPath), { headers: { "content-type": "text/html", "cache-control": "no-store" } });
    }
    if (req.method === "GET" && path === "/system_stats") {
      return json({ system: { os: "darwin", comfyui_version: "0.42.0-fake", ram_total: 64 * 2 ** 30, ram_free: 8 * 2 ** 30 }, devices: [{ name: "mps", type: "mps", index: 0, vram_total: 0, vram_free: 0 }] });
    }

    // ---- the session store (app/user_manager.py) ----
    if (path === "/userdata" && req.method === "GET") {
      const dir = url.searchParams.get("dir");
      if (!dir) return new Response("Directory not provided", { status: 400 });
      return json(userdata.names());
    }
    const move = /^\/userdata\/([^/]+)\/move\/([^/]+)$/.exec(path);
    if (move && req.method === "POST") {
      if (c.noMoveRoute) return new Response("Method Not Allowed", { status: 405 });
      const from = decodeURIComponent(move[1]);
      const to = decodeURIComponent(move[2]);
      note({ kind: "move", from, to });
      // As the real handler: source checked, destination checked, moved -- nothing awaited in between.
      if (!userdata.has(from)) return new Response(null, { status: 404 });
      if (url.searchParams.get("overwrite") === "false" && userdata.has(to)) return new Response("File already exists", { status: 409 });
      renameSync(userdata.path(from), userdata.path(to));
      return json(to);
    }
    const file = /^\/userdata\/([^/]+)$/.exec(path);
    if (file) {
      const name = decodeURIComponent(file[1]);
      if (req.method === "GET") {
        const body = userdata.get(name);
        if (!body) return new Response(null, { status: 404 });
        // The real one forces a download and refuses sniffing; fetch() reads it all the same.
        return new Response(body, { headers: { "content-type": "application/json", "content-disposition": "attachment", "x-content-type-options": "nosniff" } });
      }
      if (req.method === "POST") {
        if (c.stallMs && (!c.stallFile || c.stallFile === name)) await Bun.sleep(c.stallMs);
        if (c.userdataWrite) return new Response("no", { status: c.userdataWrite });
        if (url.searchParams.get("overwrite") === "false" && userdata.has(name)) return new Response("File already exists", { status: 409 });
        const body = new Uint8Array(await req.arrayBuffer());
        userdata.set(name, body);
        note({ kind: "userdata", name });
        return json(name);
      }
      if (req.method === "DELETE") {
        if (!userdata.has(name)) return new Response(null, { status: 404 });
        userdata.delete(name);
        note({ kind: "userdata-delete", name });
        return new Response(null, { status: 204 });
      }
    }

    // ---- pictures ----
    if (req.method === "POST" && path === "/upload/image") {
      const form = await req.formData();
      const image = form.get("image");
      if (!(image instanceof File) || !image.name) return new Response(null, { status: 400 });
      const ref: Ref = { filename: image.name, subfolder: String(form.get("subfolder") ?? ""), type: String(form.get("type") ?? "input") };
      if (c.uploadFail && ref.filename.includes(c.uploadFail)) {
        note({ kind: "upload-refused", ...ref });
        return new Response("no room", { status: 500 });
      }
      if (c.emptyOnce && ref.filename.includes(c.emptyOnce) && !emptied.has(ref.filename)) {
        emptied.add(ref.filename);
        files.set(ref, new Uint8Array(0));
        note({ kind: "upload-emptied", ...ref });
        return json({ name: ref.filename, subfolder: ref.subfolder, type: ref.type });
      }
      const bytes = new Uint8Array(await image.arrayBuffer());
      files.set(ref, bytes);
      note({ kind: "upload", ...ref, size: bytes.byteLength });
      return json({ name: ref.filename, subfolder: ref.subfolder, type: ref.type });
    }
    if ((req.method === "GET" || req.method === "HEAD") && path === "/view") {
      const ref = { filename: url.searchParams.get("filename") ?? "", subfolder: url.searchParams.get("subfolder") ?? "", type: url.searchParams.get("type") ?? "output" };
      const body = files.get(ref);
      note({ kind: "view", method: req.method, ...ref, found: !!body });
      if (!body) return new Response(null, { status: 404 });
      const headers = { "content-type": "image/png", "x-content-type-options": "nosniff", "content-length": String(body.byteLength) };
      return new Response(req.method === "HEAD" ? null : body, { headers });
    }

    // ---- the queue ----
    if (req.method === "POST" && path === "/prompt") {
      const body = (await req.json()) as { prompt?: Record<string, Node>; client_id?: string; prompt_id?: string };
      if (!body.prompt) return json({ error: { type: "no_prompt", message: "No prompt provided", details: "No prompt provided", extra_info: {} }, node_errors: {} }, 400);
      if (body.prompt_id != null && (typeof body.prompt_id !== "string" || !UUID.test(body.prompt_id))) {
        return json({ error: { type: "invalid_prompt_id", message: "prompt_id must be a valid UUID", details: "prompt_id must be a UUID string in canonical lowercase hyphenated form; omit it to let the server generate one", extra_info: {} }, node_errors: {} }, 400);
      }
      if (c.reject) return json({ error: { type: "prompt_outputs_failed_validation", message: c.reject, details: "", extra_info: {} }, node_errors: {} }, 400);
      const errors = invalid(body.prompt);
      if (errors) return json({ error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation", details: "", extra_info: {} }, node_errors: errors }, 400);
      const id = body.prompt_id ?? crypto.randomUUID();
      const job: Job = { id, number: ++number, prompt: body.prompt, extra: { client_id: body.client_id ?? null, create_time: Date.now() }, at: Date.now(), client: body.client_id ?? null, started: false };
      pending.push(job);
      note({ kind: "prompt", id, image: body.prompt["4"]?.inputs?.image, prefix: body.prompt["8"]?.inputs?.filename_prefix, resolution: body.prompt["5"]?.inputs?.resolution });
      queueUpdated();
      return json({ prompt_id: id, number: job.number, node_errors: {} });
    }
    if (req.method === "GET" && path === "/queue") {
      const item = (j: Job) => [j.number, j.id, j.prompt, j.extra, ["8"]];
      return json({ queue_running: running ? [item(running)] : [], queue_pending: pending.map(item) });
    }
    const cancel = /^\/jobs\/([^/]+)\/cancel$/.exec(path);
    if (api && cancel && req.method === "POST") {
      if (c.noCancelRoute) return new Response("Not Found", { status: 404 });
      const id = decodeURIComponent(cancel[1]);
      note({ kind: "cancel", id });
      if (running?.id === id && !running.interrupted) {
        running.interrupted = true;
        return json({ cancelled: true });
      }
      const i = pending.findIndex((j) => j.id === id);
      if (i >= 0) {
        pending.splice(i, 1);
        queueUpdated();
        return json({ cancelled: true });
      }
      return json({ cancelled: false });
    }
    if (req.method === "POST" && path === "/interrupt") {
      const body = (await req.json().catch(() => ({}))) as { prompt_id?: string };
      note({ kind: "interrupt", id: body.prompt_id ?? null, running: running?.id ?? null });
      // An older ComfyUI reads no prompt_id: whatever runs is interrupted.
      if (running && (c.oldInterrupt || !body.prompt_id || running.id === body.prompt_id)) running.interrupted = true;
      return new Response(null, { status: 200 });
    }
    const one = /^\/history\/(.+)$/.exec(path);
    if (req.method === "GET" && one) {
      const id = decodeURIComponent(one[1]);
      const entry = history.get(id);
      return json(entry ? { [id]: entry } : {});
    }
    if (req.method === "GET" && path === "/history") return json(Object.fromEntries(history));
    if (req.method === "POST" && path === "/history") {
      const body = (await req.json()) as { clear?: boolean; delete?: string[] };
      if (body.clear) history.clear();
      for (const id of body.delete ?? []) history.delete(id);
      return new Response(null, { status: 200 });
    }
    if (req.method === "POST" && path === "/queue") {
      const body = (await req.json()) as { clear?: boolean; delete?: string[] };
      note({ kind: "queue-delete", ids: body.delete ?? [], clear: !!body.clear });
      if (body.clear) pending.length = 0;
      for (const id of body.delete ?? []) {
        const i = pending.findIndex((j) => j.id === id);
        if (i >= 0) pending.splice(i, 1);
      }
      queueUpdated();
      return new Response(null, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws: ServerWebSocket<{ sid: string }>) {
      sockets.get(ws.data.sid)?.close();
      sockets.set(ws.data.sid, ws);
      ws.send(JSON.stringify({ type: "status", data: { status: { exec_info: { queue_remaining: pending.length + (running ? 1 : 0) } }, sid: ws.data.sid } }));
    },
    message() {
      // The real one only reads feature flags; nothing here needs them.
    },
    close(ws: ServerWebSocket<{ sid: string }>) {
      if (sockets.get(ws.data.sid) === ws) sockets.delete(ws.data.sid);
    },
  },
});
console.log(`fake-comfy-editor on http://127.0.0.1:${server.port}/editor`);
void work();
