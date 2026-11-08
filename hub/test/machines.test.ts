import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineInfo, MachineInvite, MachineInviteStatus } from "@crosstalk/shared";
import { App } from "../src/app";
import { startServer } from "../src/server";
import type { PushNote } from "../src/push";
import { hubAddress } from "../src/machines";

async function hub(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `ct-machine-${name}-`));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: dir, maxHopsDefault: 6 } });
  app.setHubSettings({ machineName: name });
  const server = startServer(app);
  const base = `http://127.0.0.1:${server.port}`;
  app.config.publicUrl = base;
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, `${name} phone`, "Web"))!;
  const sent: { note: PushNote; opts?: { skipVisible?: boolean; relayed?: boolean } }[] = [];
  const realSend = app.push.send.bind(app.push);
  app.push.send = async (note, opts) => {
    sent.push({ note, opts });
    return realSend(note, opts);
  };
  const api = async <T>(method: string, path: string, body?: unknown, token = device.token): Promise<{ status: number; data: T }> => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: res.status, data: data as T };
  };
  const close = async () => {
    server.stop(true);
    await app.engine.shutdown();
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { app, base, device, api, sent, close };
}

const settle = () => new Promise((r) => setTimeout(r, 150));

test("addresses are normalized", () => {
  expect(hubAddress("linux-box.tail1234.ts.net")).toBe("https://linux-box.tail1234.ts.net");
  expect(hubAddress(" https://linux-box.tail1234.ts.net/some/path ")).toBe("https://linux-box.tail1234.ts.net");
  expect(hubAddress("http://192.168.1.20:7420/")).toBe("http://192.168.1.20:7420");
  expect(() => hubAddress("")).toThrow("Enter the machine's address");
  expect(() => hubAddress("https://user:pw@host")).toThrow("isn't a web address");
});

test("linking a machine: one-tap add on other devices, notifications come through, unlinking signs out", async () => {
  const mac = await hub("Mac mini");
  const linux = await hub("Linux box");
  try {
    // Each hub has its own id and name.
    const macInfo = mac.app.hubInfo();
    expect(macInfo.name).toBe("Mac mini");
    expect(macInfo.id).toMatch(/^h_/);
    expect(mac.app.hubInfo().id).toBe(macInfo.id);

    // A wrong code, and linking a hub with itself, are refused.
    expect((await mac.api("POST", "/api/machines/link", { url: linux.base, code: "WRONG-CODE" })).status).toBe(401);
    const own = await mac.app.auth.createPairingCode();
    expect((await mac.api<{ error: string }>("POST", "/api/machines/link", { url: mac.base, code: own.code })).data.error).toContain("That's this machine");

    const code = (await linux.app.auth.createPairingCode()).code;
    const linked = await mac.api<MachineInfo>("POST", "/api/machines/link", { url: linux.base, code });
    expect(linked.status).toBe(200);
    expect(linked.data).toMatchObject({ id: linux.app.hubInfo().id, name: "Linux box", url: linux.base });
    expect((await mac.api<MachineInfo[]>("GET", "/api/machines")).data.map((m) => m.name)).toEqual(["Linux box"]);
    // The Mac hub signed in on the Linux hub as a device of its own.
    expect(linux.app.store.listDevices().map((d) => d.name)).toContain("Mac mini (hub)");

    // Another device paired with the Mac adds the Linux machine with one tap: the Mac fetches a code from it.
    const pc = await mac.api<{ url: string; code: string }>("POST", `/api/machines/${linked.data.id}/pair-code`);
    expect(pc.data.url).toBe(linux.base);
    const phone = await (await fetch(`${linux.base}/api/pair`, { method: "POST", body: JSON.stringify({ code: pc.data.code, name: "Phone", platform: "iPhone" }) })).json() as { token: string };
    expect((await linux.api("GET", "/api/state", undefined, phone.token)).status).toBe(200);

    // The Linux hub's notifications reach the Mac's devices, their title saying where they came from; never sent back again.
    await linux.app.push.send({ title: "Side project", body: "Codex finished: Done.", url: "./#/room/r_abc", tag: "done-r_abc" }, { skipVisible: true });
    await settle();
    const relayed = mac.sent.find((s) => s.note.title === "Side project · Linux box")!;
    expect(relayed.note.body).toBe("Codex finished: Done.");
    expect(relayed.note.url).toBe("./#/room/r_abc");
    expect(relayed.opts).toMatchObject({ skipVisible: true, relayed: true });
    expect(linux.sent.filter((s) => s.note.title === "Side project")).toHaveLength(1);
    // A made-up relay key is refused, and links can only point inside the app.
    const fake = await fetch(`${mac.base}/api/push/relay`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(fake.status).toBe(401);
    await linux.app.push.send({ title: "Odd", body: "", url: "https://evil.example", tag: "x" });
    await settle();
    expect(mac.sent.find((s) => s.note.title === "Odd · Linux box")!.note).toMatchObject({ url: "./", body: "" });

    // Unlinking signs the Mac out there and stops the notifications.
    expect((await mac.api("DELETE", `/api/machines/${linked.data.id}`)).status).toBe(200);
    expect(linux.app.store.listDevices().map((d) => d.name)).not.toContain("Mac mini (hub)");
    expect((await mac.api<MachineInfo[]>("GET", "/api/machines")).data).toEqual([]);
    const before = mac.sent.length;
    await linux.app.push.send({ title: "After", body: "", url: "./", tag: "y" });
    await settle();
    expect(mac.sent.length).toBe(before);
  } finally {
    await mac.close();
    await linux.close();
  }
});

/**
 * EXPECTED TO FAIL on 0.6.1 (a found defect, not a regression): machines.ts `link()` pairs first and only then looks at
 * what the other hub said about itself. The "That's this machine" branch below it signs the fresh sign-in out again; the
 * older-Crosstalk branch throws without doing that, so the person is left with a "<Mac mini> (hub)" device on the other
 * machine, paired just now and active now, that nothing can ever use (this hub threw its token away) and only they can
 * clear. Every retry adds another.
 */
test("a link refused because that machine runs an older Crosstalk signs out again there", async () => {
  const mac = await hub("Mac mini");
  const deleted: string[] = [];
  // A hub from before machine links: it pairs, but says nothing about itself.
  const older = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/pair" && req.method === "POST") return Response.json({ token: "older-hub-token", device: { id: "d_left_behind" }, hub: { hostname: "old-box" } });
      const device = /^\/api\/devices\/(.+)$/.exec(url.pathname);
      if (device && req.method === "DELETE") {
        deleted.push(decodeURIComponent(device[1]));
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const res = await mac.api<{ error: string }>("POST", "/api/machines/link", { url: `http://127.0.0.1:${older.port}`, code: "ABCD-EFGH" });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("runs an older Crosstalk");
    expect(deleted).toEqual(["d_left_behind"]);
  } finally {
    older.stop(true);
    await mac.close();
  }
});

/**
 * EXPECTED TO FAIL on 0.6.1 (a found defect, not a regression): machines.ts `relay()` keeps the other machine's deep
 * link as it is, and the app has no way to tell which machine a settings link is for (web/src/store.ts only re-routes
 * `#/room/<id>`, by looking the chat up on every machine). So "The hub is low on storage · Linux box" opens the *Mac's*
 * Settings → Storage, which may have plenty of room, and nothing says the note was about another machine. Same for the
 * memory guard, This Mac and the setup checklist. Either the link names its machine or it should fall back to "./",
 * which is what this asserts (it doesn't say which fix).
 */
test("a notification relayed from a linked machine doesn't send the phone to this machine's own settings", async () => {
  const mac = await hub("Mac mini");
  const linux = await hub("Linux box");
  try {
    const code = (await linux.app.auth.createPairingCode()).code;
    expect((await mac.api("POST", "/api/machines/link", { url: linux.base, code })).status).toBe(200);
    await linux.app.push.send({ title: "The hub is low on storage", body: "1.2 GB free on linux-box.", url: "./#/settings/storage", tag: "storage-low" });
    await settle();
    const note = mac.sent.find((s) => s.note.title === "The hub is low on storage · Linux box")!.note;
    expect(note.url).not.toBe("./#/settings/storage");
  } finally {
    await mac.close();
    await linux.close();
  }
});

test("the Linux setup command: a script with its token, the installer, and the new hub reporting back", async () => {
  const mac = await hub("Mac mini");
  const linux = await hub("Linux box");
  try {
    const inv = (await mac.api<MachineInvite>("POST", "/api/machines/invite")).data;
    expect(inv.command).toBe(`curl -fsSL '${mac.base}/api/machines/install/${inv.token}' | bash`);
    const script = await (await fetch(`${mac.base}/api/machines/install/${inv.token}`)).text();
    expect(script).toStartWith("#!/usr/bin/env bash");
    expect(script).toContain(`TOKEN='${inv.token}'`);
    expect(script).toContain(`HUB='${mac.base}'`);
    expect(script).toContain('CODE="$("$HOME/.local/bin/crosstalk-hub" pair 30 | sed -n \'s/^Pairing code: \\([A-Za-z0-9-]*\\).*/\\1/p\')"');
    expect(script.trimEnd()).toEndWith('main "$@"');
    expect(await (await fetch(`${mac.base}/api/machines/install/${inv.token}/install.sh`)).text()).toContain("Crosstalk hub installer for Linux");
    expect((await mac.api<MachineInviteStatus>("GET", `/api/machines/invites/${inv.token}`)).data.status).toBe("waiting");

    // The installed hub reports its address and a pairing code: the Mac links it.
    const code = (await linux.app.auth.createPairingCode()).code;
    const claim = await fetch(`${mac.base}/api/machines/install/${inv.token}/claim`, { method: "POST", body: JSON.stringify({ url: linux.base, code }) });
    expect(claim.status).toBe(200);
    const status = (await mac.api<MachineInviteStatus>("GET", `/api/machines/invites/${inv.token}`)).data;
    expect(status).toMatchObject({ status: "done", machine: { name: "Linux box", url: linux.base } });

    // Unknown tokens get nothing.
    expect((await fetch(`${mac.base}/api/machines/install/AAAAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(401);
    expect((await mac.api<MachineInviteStatus>("GET", "/api/machines/invites/AAAAAAAAAAAAAAAAAAAAAAAA")).data.status).toBe("expired");
  } finally {
    await mac.close();
    await linux.close();
  }
});

test("a failed claim keeps its reason in the invite status, and three failures use the command up", async () => {
  const mac = await hub("Mac mini");
  try {
    const inv = (await mac.api<MachineInvite>("POST", "/api/machines/invite")).data;
    const claim = (url: string) => fetch(`${mac.base}/api/machines/install/${inv.token}/claim`, { method: "POST", body: JSON.stringify({ url, code: "ABCD-EFGH" }) });
    const status = async () => (await mac.api<MachineInviteStatus>("GET", `/api/machines/invites/${inv.token}`)).data;
    // Refused before anything is contacted: the command prints the reason and what to do on the machine…
    const first = await claim("http://plain.example");
    expect(first.status).toBe(400);
    expect(await first.text()).toBe("The machine's address must be https. Fix that, then run the same command again.\n");
    // …and the app, still waiting, can show why the last try failed.
    expect(await status()).toEqual({ status: "waiting", error: "The machine's address must be https." });
    await claim("http://plain.example");
    const third = await claim("http://plain.example");
    expect(await third.text()).toContain("This command was tried 3 times, so it no longer works: make a new one in Crosstalk (Settings → Machines).");
    expect(await status()).toEqual({ status: "failed", error: "The machine's address must be https." });
    // Used up: running it again only says so.
    const again = await claim("https://linux-box.example");
    expect(again.status).toBe(401);
    expect(await again.text()).toContain("This setup command has expired. Make a new one in Crosstalk: Settings → Machines.");
  } finally {
    await mac.close();
  }
});

test("the setup script prints the hub's error when linking fails, not curl's", async () => {
  const mac = await hub("Mac mini");
  try {
    const inv = (await mac.api<MachineInvite>("POST", "/api/machines/invite")).data;
    const script = await (await fetch(`${mac.base}/api/machines/install/${inv.token}`)).text();
    // The claim step, as the script runs it once the machine is installed (everything but main itself).
    expect(script).toContain(`ask "Linking failed" "$TMP/claim" -X POST "$HUB/api/machines/install/$TOKEN/claim"`);
    // Every request to the hub goes through ask (only the wait for the new hub's own health check keeps curl -f).
    expect(script.match(/curl -f[^\n]*/g)).toEqual(['curl -fsS -o /dev/null "https://$DNS/api/health" 2>/dev/null && break; sleep 2; done']);
    const run = (claimBody: string, hubUrl = mac.base) => {
      const steps = script.replace(/main "\$@"\s*$/, `HUB='${hubUrl}'; TOKEN='${inv.token}'; TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ask "Linking failed" "$TMP/claim" -X POST "$HUB/api/machines/install/$TOKEN/claim" -H 'content-type: application/json' --data '${claimBody}'
echo linked`);
      // Not spawnSync: the hub answering it runs in this process.
      const p = Bun.spawn(["bash", "-c", steps], { stdout: "pipe", stderr: "pipe" });
      return Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]).then(([code, out, err]) => ({ code, out, err }));
    };
    const refused = await run(JSON.stringify({ url: "http://plain.example", code: "ABCD-EFGH" }));
    expect(refused.code).toBe(1);
    expect(refused.out).toBe("Linking failed: The machine's address must be https. Fix that, then run the same command again.\n");
    expect(refused.err).toBe("");
    // A hub it can't reach at all: said in words, with what to do.
    const unreachable = await run("{}", "http://127.0.0.1:9");
    expect(unreachable.code).toBe(1);
    expect(unreachable.out).toContain("Linking failed: couldn't reach Crosstalk at http://127.0.0.1:9. Check this machine's network, then run the same command again.");
  } finally {
    await mac.close();
  }
});
