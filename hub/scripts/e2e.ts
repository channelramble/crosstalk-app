// End-to-end check of a compiled hub binary, driven only through its public HTTP API, the way the apps use it.
//   bun run scripts/e2e.ts [path/to/crosstalk-hub]   (defaults to out/crosstalk-hub-<this platform>)
// Uses a throwaway data folder and port, and the built-in test agent, so it never touches a real hub.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bin = resolve(process.argv[2] ?? join(import.meta.dir, "..", "out", `crosstalk-hub-${process.platform}-${process.arch}`));
if (!existsSync(bin)) throw new Error(`no hub binary at ${bin}; build it first (bun run scripts/build.ts)`);
const home = mkdtempSync(join(tmpdir(), "ct-e2e-"));
const port = 7600 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// Both the service and pairing CLI must use only this throwaway hub's settings. A home of its own and a bare PATH: a
// served hub checks the agent CLIs it can find (versions, sign-in, plan usage), and these must never be the real ones.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CROSSTALK_|CLAUDE_|CODEX_|GEMINI_|ANTHROPIC_|OPENAI_|GOOGLE_)/.test(k)));
mkdirSync(join(home, "home"), { recursive: true });
const env = {
  ...inherited,
  HOME: join(home, "home"),
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  CROSSTALK_HOME: join(home, "data"),
  CROSSTALK_WORKSPACES: join(home, "ws"),
  CROSSTALK_PORT: String(port),
  CROSSTALK_HOST: "127.0.0.1",
  CROSSTALK_NO_AGENT_CLIS: "1",
  // No price list is fetched, no model server on this machine is looked for, Anthropic isn't asked for a key's models,
  // and Featherless's catalogue isn't asked for its 22,406 either.
  CROSSTALK_PRICES_URL: "http://127.0.0.1:9/prices.json",
  CROSSTALK_FEATHERLESS_URL: "http://127.0.0.1:9",
  // and NanoGPT's model list, prices and balances aren't asked for either.
  CROSSTALK_NANOGPT_URL: "http://127.0.0.1:9",
  // nor Refuseless's balances.
  CROSSTALK_REFUSELESS_URL: "http://127.0.0.1:9",
  CROSSTALK_ANTHROPIC_API_URL: "http://127.0.0.1:9",
  CROSSTALK_LOCAL_SERVER_PORTS: "",
  // Nor is this Mac's own Tailscale read: neither its command nor the Tailscale app's local API under /Library.
  CROSSTALK_TAILSCALE_BIN: join(home, "no-tailscale"),
  CROSSTALK_TAILSCALE_APP_DIR: join(home, "no-tailscale-app"),
};
function startHub() {
  const proc = Bun.spawn([bin, "serve"], { env, stdout: "pipe", stderr: "pipe" });
  return proc;
}
async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not yet */ }
    await Bun.sleep(100);
  }
  throw new Error("hub didn't start");
}
const sleep = (ms: number) => Bun.sleep(ms);

let hub = startHub();
try {
  await waitUp();
  ok("hub starts and answers /api/health", true);
  ok("serves the web app", (await (await fetch(base)).text()).includes("<title>Crosstalk"));

  // Pair a device with a code from the CLI, like the README tells people to.
  const pairOut = Bun.spawnSync([bin, "pair", "5"], { env }).stdout.toString();
  const code = pairOut.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0];
  ok("`crosstalk-hub pair` prints a code", !!code, pairOut.slice(0, 200));
  const paired = (await (await fetch(`${base}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "E2E", platform: "Test" }) })).json()) as { token: string };
  ok("device pairs with that code", !!paired.token);
  const H = { authorization: `Bearer ${paired.token}`, "content-type": "application/json" };
  const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, { method, headers: H, body: body === undefined ? undefined : body instanceof Blob || typeof body === "string" ? body : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text) as T; } catch { return text as T; }
  };

  // It never found the real agent CLIs on this computer: only the built-in test agent is there, and Crosstalk's own
  // agent, which is part of the hub rather than a program it found (agents/builtin.ts).
  const start = await api<{ providers?: { provider: string; installed: boolean }[] }>("GET", "/api/state");
  const found = (start.providers ?? []).filter((p) => p.installed && p.provider !== "mock" && p.provider !== "builtin").map((p) => p.provider);
  ok("no real agent CLI was found or checked", found.length === 0, found.join(", "));

  // Defaults apply to new rooms and agents.
  await api("PUT", "/api/settings/defaults", { mode: "review", maxHops: 5, agent: { mock: { permissionMode: "auto", model: null, effort: null } } });
  const room = await api("POST", "/api/rooms", { name: "E2E room" });
  ok("new room uses the default mode (Build & review)", room.mode === "review", room.mode);
  const builder = await api("POST", `/api/rooms/${room.id}/members`, { provider: "mock", handle: "builder", config: { delayMs: 50, replies: ["Built it.", "Fixed it."] } });
  await api("POST", `/api/rooms/${room.id}/members`, { provider: "mock", handle: "checker", config: { delayMs: 50, replies: ["Bug in a.ts:1.", "APPROVED: all good."] } });
  ok("new agent gets its default permission", builder.permissionMode === "auto", builder.permissionMode);

  // A Build & review loop runs to approval by itself.
  await api("POST", `/api/rooms/${room.id}/messages`, { text: "Build the thing" });
  let history: any;
  for (let i = 0; i < 100; i++) {
    history = await api("GET", `/api/rooms/${room.id}/history`);
    if (history.messages.some((m: any) => m.authorKind === "system" && m.text.includes("approved"))) break;
    await sleep(100);
  }
  const agentTurns = history.messages.filter((m: any) => m.authorKind === "agent").map((m: any) => m.authorName);
  ok("Build & review loops builder → checker until approved", JSON.stringify(agentTurns) === JSON.stringify(["builder", "checker", "builder", "checker"]), JSON.stringify(agentTurns));
  ok("approval is announced", history.messages.some((m: any) => m.text.includes("approved @builder's work after 2 review rounds")));

  // Attachments: a file and a zipped folder.
  const up = await api("POST", `/api/rooms/${room.id}/uploads?name=notes.txt`, new Blob(["hello"]));
  const fileBack = await (await fetch(base + up.url, { headers: H })).text();
  ok("file upload round-trips", fileBack === "hello");
  const { makeZip } = await import(String(join(import.meta.dir, "../../web/src/zip.ts")));
  const zip = await makeZip([{ rel: "proj/README.md", file: new File(["# hi"], "README.md") }, { rel: "proj/src/a.ts", file: new File(["x"], "a.ts") }]);
  const folder = await api("POST", `/api/rooms/${room.id}/uploads?unzip=1&name=proj.zip`, zip);
  ok("zipped folder unpacks with every file", folder.files === 2, JSON.stringify(folder));
  const sent = await api("POST", `/api/rooms/${room.id}/messages`, { text: "@builder see attached", attachments: [up.filename, `folder:${folder.folder}`] });
  ok("message lists the file and the folder", sent.text.includes("notes.txt") && sent.text.includes("proj/"), sent.text);
  const listing = await api("GET", `/api/rooms/${room.id}/folders/${folder.folder.split("/").map(encodeURIComponent).join("/")}`);
  ok("folder can be browsed from chat", listing.total === 2);

  // Agents' file links download from the project folder, and only from there.
  writeFileSync(join(room.cwd, "result.zip"), "zipdata");
  ok("agent file link downloads", (await (await fetch(`${base}/api/rooms/${room.id}/files?path=${encodeURIComponent(join(room.cwd, "result.zip"))}`, { headers: H })).text()) === "zipdata");
  ok("files outside the project are refused", (await fetch(`${base}/api/rooms/${room.id}/files?path=${encodeURIComponent("/etc/hosts")}`, { headers: H })).status === 403);

  // Approvals: a command waits for the human, then continues.
  const asker = await api("POST", `/api/rooms/${room.id}/members`, { provider: "mock", handle: "asker", permissionMode: "ask", config: { delayMs: 50, approval: true, reply: "Ran the tests." } });
  await api("PATCH", `/api/rooms/${room.id}`, { mode: "direct" });
  await api("POST", `/api/rooms/${room.id}/messages`, { text: "@asker run tests" });
  let pending: any;
  for (let i = 0; i < 50 && !pending; i++) {
    pending = (await api("GET", `/api/rooms/${room.id}/history`)).approvals.find((a: any) => a.status === "pending" && a.memberId === asker.id);
    await sleep(100);
  }
  ok("an approval card appears", !!pending);
  if (pending) await api("POST", `/api/approvals/${pending.id}`, { decision: "approve" });
  let replied = false;
  for (let i = 0; i < 50 && !replied; i++) {
    replied = (await api("GET", `/api/rooms/${room.id}/history`)).messages.some((m: any) => m.authorName === "asker" && m.text.includes("Ran the tests.") && m.status === "done");
    await sleep(100);
  }
  ok("approving lets the agent finish", replied);

  // Computers: a one-time connect command, served without a pairing.
  const invite = await api("POST", "/api/computers/invite");
  const scriptUrl = invite.command.match(/'([^']+)'/)[1];
  const scriptRes = await fetch(scriptUrl);
  const script = await scriptRes.text();
  if (!scriptRes.ok) console.log("  script fetch:", scriptRes.status, scriptUrl, script.slice(0, 200));
  ok("computer connect script is served", script.includes("authorized_keys"));
  ok("computer connect script is valid shell", Bun.spawnSync(["sh", "-n"], { stdin: new TextEncoder().encode(script) }).exitCode === 0);

  // A restart mid-turn resumes interrupted work once, then returns to idle.
  const slow = await api("POST", `/api/rooms/${room.id}/members`, { provider: "mock", handle: "slow", config: { delayMs: 5000 } });
  const slowRequest = await api("POST", `/api/rooms/${room.id}/messages`, { text: "@slow take your time" });
  await sleep(300);
  hub.kill();
  await hub.exited;
  hub = startHub();
  await waitUp();
  let after: any;
  for (let i = 0; i < 150; i++) {
    after = await api("GET", `/api/rooms/${room.id}/history`);
    if (!after.turns.some((t: any) => t.status === "running" || t.status === "queued")) break;
    await sleep(100);
  }
  const resumed = after.turns.filter((t: any) => t.memberId === slow.id && t.triggerMessageId === slowRequest.id);
  ok("restart resumes interrupted work exactly once", resumed.length === 2 && resumed.some((t: any) => t.status === "stopped") && resumed.some((t: any) => t.status === "done"), JSON.stringify(resumed.map((t: any) => t.status)));
  ok("resumed work finishes without a stuck turn", !after.turns.some((t: any) => t.status === "running" || t.status === "queued"));
  ok("data survives a restart", after.messages.length > 5);
  // ---- 0.4: what the compiled hub itself answers for spend and limits, ask others and AI services. There are no agent CLIs
  // here, so nothing is asked or run: these are the routes and their refusals.
  const raw = async (method: string, path: string, body?: unknown, headers: Record<string, string> = H) => {
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  };
  const spend = await raw("GET", "/api/spend");
  ok("spend: GET /api/spend answers accounts, updatedAt and prices", spend.status === 200 && Array.isArray(spend.json?.accounts) && typeof spend.json?.updatedAt === "number" && "prices" in (spend.json ?? {}), spend.text.slice(0, 200));
  ok("spend: the mock agent's replies are in the ledger", (spend.json?.accounts ?? []).some((a: any) => a.provider === "mock" && a.month?.replies >= 1), spend.text.slice(0, 300));
  const roomSpend = await raw("GET", `/api/rooms/${room.id}/spend`);
  ok("spend: a room's spend answers roomId, usd and replies", roomSpend.status === 200 && roomSpend.json?.roomId === room.id && typeof roomSpend.json?.usd === "number" && roomSpend.json?.replies >= 1, roomSpend.text.slice(0, 200));
  const noAccount = await raw("PUT", "/api/spend/budgets/claude/nope", { limitUsd: 5 });
  ok("spend: a limit on an account that isn't there is refused", noAccount.status === 404, `${noAccount.status} ${noAccount.text.slice(0, 120)}`);
  const lookupOff = await raw("PUT", "/api/settings/hub", { priceLookup: false });
  const lookupNow = await raw("GET", "/api/settings/hub");
  ok("spend: looking up prices online can be switched off", lookupOff.status === 200 && lookupNow.json?.priceLookup === false, `${lookupOff.status} ${JSON.stringify(lookupNow.json?.priceLookup)}`);
  await raw("PUT", "/api/settings/hub", { priceLookup: true });

  const asksList = await raw("GET", `/api/rooms/${room.id}/asks`);
  ok("ask others: a room's asks list is empty", asksList.status === 200 && Array.isArray(asksList.json) && asksList.json.length === 0, asksList.text.slice(0, 120));
  const asksMissing = await raw("GET", "/api/rooms/nope/asks");
  ok("ask others: an unknown room is a 404", asksMissing.status === 404, `${asksMissing.status} ${asksMissing.text.slice(0, 120)}`);
  const asksSignedOut = await raw("POST", "/api/asks", { roomId: room.id, messageId: "x", targets: [] }, { "content-type": "application/json" });
  ok("ask others: asking without a sign-in is refused", asksSignedOut.status === 401, String(asksSignedOut.status));
  // Group chats can be asked about since 0.5, so this names a message that isn't there.
  const asksGroupRoom = await raw("POST", "/api/asks", { roomId: room.id, messageId: "x", targets: [{ provider: "codex", account: "default", model: null, effort: null }] });
  ok("ask others: a message that isn't in the chat is refused", asksGroupRoom.status === 404, `${asksGroupRoom.status} ${asksGroupRoom.text.slice(0, 120)}`);

  // 0.5: search across chats and Markdown export, and Local models (nothing is running on this machine in the test hub).
  const searched = await raw("GET", "/api/search?q=zzqxnothing");
  ok("search: a search answers results, chats and truncated", searched.status === 200 && Array.isArray(searched.json?.results) && Array.isArray(searched.json?.chats) && typeof searched.json?.truncated === "boolean" && searched.json.results.length === 0, searched.text.slice(0, 160));
  const searchedBuilt = await raw("GET", "/api/search?q=" + encodeURIComponent("Built it"));
  ok("search: finds what an agent said", searchedBuilt.status === 200 && Array.isArray(searchedBuilt.json?.results), searchedBuilt.text.slice(0, 160));
  const searchedOut = await raw("GET", "/api/search?q=ab", undefined, { "content-type": "application/json" });
  ok("search: searching without a sign-in is refused", searchedOut.status === 401, String(searchedOut.status));
  const exportMissing = await raw("GET", "/api/chats/r_nope/export.md");
  ok("export: an unknown chat is a 404", exportMissing.status === 404, `${exportMissing.status} ${exportMissing.text.slice(0, 100)}`);
  const localModels = await raw("GET", "/api/local-models");
  ok("local models: nothing runs in the test hub", localModels.status === 200 && Array.isArray(localModels.json?.servers) && localModels.json.servers.length === 0 && typeof localModels.json?.scannedAt === "number", localModels.text.slice(0, 160));
  const switchEmpty = await raw("POST", "/api/local-models/switch", {});
  ok("local models: a switch must say which server and model", switchEmpty.status === 400, `${switchEmpty.status} ${switchEmpty.text.slice(0, 120)}`);
  const switchOut = await raw("POST", "/api/local-models/switch", {}, { "content-type": "application/json" });
  ok("local models: switching without a sign-in is refused", switchOut.status === 401, String(switchOut.status));

  // AI services, against a stand-in server that speaks Responses and Chat Completions but not Messages.
  const stand = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/v1/models") return Response.json({ data: [{ id: "m1" }] });
      if (path === "/v1/responses" || path === "/v1/chat/completions") return Response.json({ error: "bad request" }, { status: 400 });
      return new Response("no", { status: 404 });
    },
  });
  try {
    const standUrl = `http://127.0.0.1:${stand.port}`;
    const tested = await raw("POST", "/api/services/test", { baseUrl: standUrl });
    ok("services: Test finds what a server speaks, without a model request", tested.status === 200 && tested.json?.reachable === true && tested.json?.protocols?.responses === "yes" && tested.json?.protocols?.messages === "no" && (tested.json?.works ?? []).some((w: any) => w.provider === "codex" && w.via === "responses"), tested.text.slice(0, 300));
    const added = await raw("POST", "/api/accounts/endpoint", { provider: "codex", label: "E2E server", baseUrl: standUrl, models: ["m1"], protocol: "chat", chatPath: "/v1/chat/completions", contexts: { m1: 16384 } });
    ok("services: a Chat Completions-only server can be added for Codex, with its path and context", added.status === 200 && added.json?.endpoint?.protocol === "chat" && added.json?.endpoint?.contexts?.m1 === 16384, `${added.status} ${added.text.slice(0, 200)}`);
    const refreshed = await raw("POST", `/api/accounts/codex/${added.json?.id}/refresh-models`);
    ok("services: an account's model list can be refreshed live", refreshed.status === 200, `${refreshed.status} ${refreshed.text.slice(0, 160)}`);
    await raw("DELETE", `/api/accounts/codex/${added.json?.id}`);
  } finally {
    stand.stop(true);
  }
  const claudeChat = await raw("POST", "/api/accounts/endpoint", { provider: "claude", baseUrl: "http://127.0.0.1:9", models: ["m"], protocol: "chat" });
  ok("services: a Chat Completions-only server can't be added for Claude Code", claudeChat.status === 400, `${claudeChat.status} ${claudeChat.text.slice(0, 120)}`);
  const localScan = await raw("GET", "/api/local-servers");
  ok("services: the test hub looks for no model servers on this machine", localScan.status === 200 && Array.isArray(localScan.json?.servers) && localScan.json.servers.length === 0 && typeof localScan.json?.scannedAt === "number", localScan.text.slice(0, 160));

  const state = await api("GET", "/api/state");
  ok("no agent is left marked busy", state.members.every((m: any) => m.status === "idle"));
} catch (e) {
  ok("e2e run", false, e instanceof Error ? e.message : String(e));
} finally {
  hub.kill();
  await hub.exited;
  rmSync(home, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll end-to-end checks passed");
process.exit(failures ? 1 : 0);
