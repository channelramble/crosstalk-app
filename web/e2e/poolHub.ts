// The model pool's controller, run from the hub's own code (hub/src/pool/pool.ts) for e2e/modelPool.spec.ts. The
// browser test answers each /api/pool request by running this once with Bun (about 75 ms), in its own Crosstalk home,
// so the views, the checks of what the page sends, the machine checks, the Tailscale peers, the Hugging Face file list
// and the helper commands are exactly the hub's. Only the network is played: a linked hub is a local server answering
// /api/pool/node with what the test says it reports, Tailscale is the hub tests' fake CLI, Hugging Face a local
// listing, and a PC's helper answers when the test says so. Everything listens on 127.0.0.1 and is gone when it ends.
//
// stdin: { op, hub, … } (see Hub below). stdout: { ok: true, result, events, hub } with the events the hub sent and its
// state after the call, or { ok: false, status, error, code? } as the hub would answer.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolMachineState, PoolNodeInfo, PoolStatus, ServerEvent } from "@crosstalk/shared";

/** What the test plays: the hub's saved settings and what it last learned, and the machines around it. */
interface Hub {
  /** This hub's name (Settings → Machines). */
  name: string;
  kv: Record<string, string>;
  states: PoolMachineState[];
  infos: Record<string, PoolNodeInfo>;
  status: PoolStatus | null;
  /** The linked hubs, and what each answers at /api/pool/node (null: it doesn't answer). */
  links: { id: string; name: string; scope: "full" | "peer"; node: PoolNodeInfo | null }[];
  /** What this hub says about itself as a pool machine. */
  self: PoolNodeInfo;
  /** `tailscale ping` answers, by address ("pong from … via DERP(nyc) in 41ms"). */
  pings: Record<string, string>;
  /** `tailscale status --json`. */
  tailscale: unknown;
  /** Helpers on PCs that answer, as "address:port". */
  helpers: string[];
  /** Hugging Face repos: whether they're gated and their files with sizes. */
  hf: Record<string, { gated: false | "auto" | "manual"; files: { path: string; size: number }[] }>;
}

const input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as {
  op: string;
  hub: Hub;
  body?: unknown;
  query?: string;
  repo?: string;
  /** For "loading": the main machine's newest server lines, how long it's been loading, where, and whether helpers take part. */
  loading?: { lines: string[]; elapsedMs: number; where: string; helpers: boolean };
  /** For "metrics": llama-server's /metrics. */
  metrics?: string;
};
const hub = input.hub;
const home = process.env.CROSSTALK_HOME!;
mkdirSync(home, { recursive: true });

// The hub tests' fake Tailscale, with this test's answers.
process.env.CROSSTALK_TAILSCALE_BIN = join(import.meta.dir, "../../hub/test/fixtures/fake-tailscale");
process.env.CROSSTALK_TAILSCALE_APP_DIR = join(home, "no-tailscale-app");
const pings = join(home, "tailscale-pings");
writeFileSync(pings, Object.entries(hub.pings).map(([ip, line]) => `${ip} ${line}`).join("\n") + "\n");
process.env.FAKE_TAILSCALE_PINGS = pings;
const status = join(home, "tailscale-status.json");
writeFileSync(status, JSON.stringify(hub.tailscale));
process.env.FAKE_TAILSCALE_STATUS = status;
process.env.FAKE_TAILSCALE_IP = hub.self.address ?? "";

const { Pool, loadingDetail, parseMetrics } = await import("../../hub/src/pool/pool");
const { HttpError } = await import("../../hub/src/engine/engine");

const servers: { stop(force?: boolean): void }[] = [];
// A linked hub: its /api/pool/node answers with what the test says it reports.
const urls: Record<string, string> = {};
for (const l of hub.links) {
  if (!l.node) {
    urls[l.id] = "http://127.0.0.1:9";
    continue;
  }
  const node = l.node;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => (new URL(req.url).pathname === "/api/pool/node" ? Response.json(node) : Response.json({ error: "not found" }, { status: 404 })) });
  servers.push(server);
  urls[l.id] = `http://127.0.0.1:${server.port}`;
}
// Hugging Face's model info and file list (no downloads).
const hf = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const info = /^\/api\/models\/([^/]+\/[^/]+)$/.exec(path);
    const tree = /^\/api\/models\/([^/]+\/[^/]+)\/tree\/main$/.exec(path);
    const repo = hub.hf[(info ?? tree)?.[1] ?? ""];
    if (!repo) return Response.json({ error: "Repository Not Found" }, { status: 401 });
    if (info) return Response.json({ id: info[1], gated: repo.gated, private: false });
    // As Hugging Face lists a repo: big files are in Git LFS.
    return Response.json(repo.files.map((f, i) => ({ type: "file", oid: i.toString(16).padStart(40, "0"), size: f.size, path: f.path, ...(f.size > 10_000_000 ? { lfs: { oid: i.toString(16).padStart(64, "0"), size: f.size, pointerSize: 135 } } : {}) })));
  },
});
servers.push(hf);
process.env.CROSSTALK_HF_URL = `http://127.0.0.1:${hf.port}`;
process.env.CROSSTALK_GITHUB_API = "http://127.0.0.1:9";
process.env.CROSSTALK_LLAMA_RELEASES = "http://127.0.0.1:9";

const kv = new Map(Object.entries(hub.kv));
const events: ServerEvent[] = [];
const notHere = () => {
  throw new HttpError(500, "Not part of this browser test.");
};
const app = {
  store: { kvGet: (k: string) => kv.get(k) ?? null, kvSet: (k: string, v: string) => void kv.set(k, v), listRooms: () => [], listMembers: () => [] },
  machines: {
    list: () => hub.links.map((l) => ({ id: l.id, name: l.name, scope: l.scope })),
    linked: () => hub.links.map((l) => ({ id: l.id, name: l.name, url: urls[l.id], token: "browser-test", agents: "two-way" })),
    noteName() {},
    signedOut() {},
  },
  hubId: () => hub.self.hubId,
  machineName: () => hub.name,
  bus: { emit: (e: ServerEvent) => void events.push(e) },
  providers: { endpointOf: () => null, accounts: () => [], setEndpointAccount: notHere },
  poolNode: { info: async () => hub.self, snapshot: () => hub.self, handle: notHere },
  engine: { memberChanged() {} },
  config: { port: 8451 },
};
const pool = new Pool(app as never);
// What it last learned and is doing, as the test left it (the hub keeps these in memory).
const inside = pool as unknown as { states: Map<string, PoolMachineState>; infos: Map<string, PoolNodeInfo>; status: PoolStatus; probe: (host: string, port: number) => Promise<boolean> };
inside.states = new Map(hub.states.map((s) => [s.id, s]));
inside.infos = new Map(Object.entries(hub.infos));
if (hub.status) inside.status = hub.status;
inside.probe = async (host, port) => hub.helpers.includes(`${host}:${port}`);

let out: unknown;
try {
  let result: unknown;
  if (input.op === "view") result = pool.view();
  // The routes, as hub/src/server.ts calls them.
  else if (input.op === "update") result = pool.update((input.body as { config?: unknown } | null)?.config);
  else if (input.op === "hfToken") result = pool.setHfToken(input.body);
  // The hub's https address on the tailnet (Tailscale's, as the live hub has): the short command fetches from there.
  else if (input.op === "helperCommand") result = pool.helperCommand(new URLSearchParams(input.query ?? ""), "https://mac-mini.tail4f2a1.ts.net");
  else if (input.op === "models") result = await pool.models(input.repo ?? "");
  else if (input.op === "tailscale") result = await pool.tailscale();
  else if (input.op === "check") result = await pool.check();
  // What a start says while the model loads, and the speed it reads, in the hub's words.
  else if (input.op === "loading") result = loadingDetail(input.loading!.lines, input.loading!.elapsedMs, input.loading!.where, input.loading!.helpers);
  else if (input.op === "metrics") result = parseMetrics(input.metrics ?? "");
  else throw new Error(`poolHub.ts: no such op ${input.op}`);
  out = { ok: true, result, events, hub: { ...hub, kv: Object.fromEntries(kv), states: [...inside.states.values()], infos: Object.fromEntries(inside.infos), status: inside.status } };
} catch (e) {
  if (!(e instanceof HttpError)) throw e;
  out = { ok: false, status: e.status, error: e.message, ...(e.code ? { code: e.code } : {}) };
} finally {
  for (const s of servers) s.stop(true);
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
