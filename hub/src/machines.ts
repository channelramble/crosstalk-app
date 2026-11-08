// Other machines running Crosstalk (say, a Linux box beside the Mac). The app talks to every machine's hub
// directly, so each keeps working on its own. This hub keeps a link to the others:
// - A person links a machine with a code they typed (or the Linux setup command): this hub gets a full sign-in
//   there, so devices paired here can add that machine with one tap, and its notifications come through here.
// - When agents may reach other chats (Settings → Teamwork), links become two-way and linked machines are introduced
//   to each other. Those sign-ins are "peer" sign-ins: only for what agents need (finding, reading and messaging
//   chats), never a terminal, approvals, settings or pairing, and each is tied to the hub it belongs to.
// A Linux machine can be set up from here with one command that installs the hub and links it.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Device, MachineAgentLink, MachineInfo, MachineInvite, MachineInviteStatus } from "@crosstalk/shared";
import { HOME, HUB_VERSION } from "./config";
import { HttpError } from "./engine/engine";
import type { PushNote } from "./push";
import { secretToken, sha256 } from "./util/ids";
import { logger } from "./util/log";
// The Linux installer, handed out as is by the one-command setup.
import INSTALL_SH from "../../deploy/install.sh" with { type: "text" };

const log = logger("machines");

const INVITE_TTL = 60 * 60_000;
/** Codes hubs hand each other to make a link two-way, or to introduce a machine: used within seconds. */
const PEER_CODE_TTL = 2 * 60_000;
/** Retries of a link or an introduction that failed (the machine was off, say): then hourly. */
const BACKOFF = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/** What the machines need from the app. */
export interface MachinesDeps {
  kvGet: (key: string) => string | null;
  kvSet: (key: string, value: string) => void;
  /** This hub's id and name, as the others will show it, and its https address (null without Tailscale). */
  self: () => { id: string; name: string; url: string | null };
  /** Sends a notification to this hub's own devices. */
  notify: (note: PushNote) => Promise<void>;
  /** Whether agents here may reach other chats: links become two-way only then. */
  agentsOn: () => boolean;
  /** A one-time code that pairs with this hub. */
  pairingCode: (ttlMs: number, opts: { scope: "full" | "peer"; hubId?: string | null }) => Promise<{ code: string; expiresAt: number }>;
  getDevice: (id: string) => Device | null;
  revokeDevice: (id: string) => void;
  setDeviceHub: (id: string, hubId: string | null) => void;
  devicesOfHub: (hubId: string) => Device[];
  /** Where Linux builds of the hub are kept for the one-command setup. */
  distDir?: string;
  /** A machine is about to be unlinked from here: what uses it lets go first, while this hub can still sign in there. */
  beforeUnlink?: (id: string) => Promise<void>;
  /** The linked machines changed (one was linked, unlinked or renamed). */
  changed?: () => void;
}

interface Link extends MachineInfo {
  /** This hub's sign-in on the other hub. */
  token: string;
  deviceId: string;
  /** "full": a person linked it from here; "peer": it linked back, or was introduced. */
  scope: "full" | "peer";
  /** Notifications from there come here (full links only). */
  relayId: string | null;
  /** The other hub's sign-in here: how requests from its agents are recognized. */
  inboundDeviceId: string | null;
  agents: MachineAgentLink;
  error: string | null;
  introducedBy: string | null;
  retryAt: number | null;
  retries: number;
  /** Install claims need an explicit Connect tap, even after a restart. */
  autoConnect?: boolean;
}

interface Relay {
  id: string;
  name: string;
  hash: string;
  createdAt: number;
}

interface Forward {
  url: string;
  token: string;
  name: string;
}

interface Invite {
  expiresAt: number;
  status: MachineInviteStatus["status"];
  machine?: MachineInfo;
  error?: string;
  failures: number;
  claiming?: boolean;
}

/** An introduction this hub made between two of its machines (so their agents can reach each other directly). */
interface Intro {
  a: string;
  b: string;
  state: "pending" | "done" | "failed" | "needs-update";
  error: string | null;
  retryAt: number | null;
  retries: number;
}

/** How a linked hub describes itself. */
export interface PeerHub {
  id: string;
  name: string;
  url: string | null;
  version?: string;
}

/** "linux-box.tailnet.ts.net", "https://linux-box.tailnet.ts.net/" → "https://linux-box.tailnet.ts.net" */
export function hubAddress(input: string): string {
  let raw = String(input ?? "").trim();
  if (!raw) throw new HttpError(400, "Enter the machine's address");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, "That isn't a web address");
  }
  if (u.username || u.password) throw new HttpError(400, "That isn't a web address");
  return `${u.protocol}//${u.host}`;
}

/** https, or a loopback address (tests, and hubs on one machine): codes and keys never cross a network in the clear. */
export function secureAddress(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

interface CallInit {
  method?: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
  /** Keep the other hub's status and reason code (otherwise anything but 401 becomes 502). */
  raw?: boolean;
  /** Stops the request when it aborts (the caller gave up: the other hub sees the connection close). */
  signal?: AbortSignal;
}

/** A request to another machine's hub. Redirects are refused, so a code or key can't be bounced elsewhere. */
export async function hubCall<T>(url: string, path: string, init: CallInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url + path, {
      method: init.method ?? "GET",
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs ?? 20_000)]) : AbortSignal.timeout(init.timeoutMs ?? 20_000),
      redirect: "error",
    });
  } catch (e) {
    throw new HttpError(502, `Couldn't reach ${host(url)}: ${String(e instanceof Error ? e.message : e).replace(/[.\s]+$/, "")}`, "unreachable");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const d = data as { error?: string; code?: string } | null;
    const msg = d?.error ?? `${res.status} ${text.slice(0, 120)}`;
    if (init.raw) throw new HttpError(res.status, `${host(url)}: ${msg}`, d?.code ?? (res.status === 404 ? "not_found" : undefined));
    throw new HttpError(res.status === 401 ? 401 : 502, `${host(url)}: ${msg}`);
  }
  return data as T;
}

export class Machines {
  private invites = new Map<string, Invite>();
  /** One link operation per machine at a time (a tap and a retry must not both pair). */
  private busy = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: MachinesDeps) {}

  // ---- links ----

  private links(): Link[] {
    let list: Partial<Link>[];
    try {
      const raw = JSON.parse(this.deps.kvGet("machines.links") ?? "[]");
      list = Array.isArray(raw) ? raw : [];
    } catch {
      list = [];
    }
    // Links from before two-way links: a person made them, one way.
    return list.map((l) => ({
      ...(l as Link),
      scope: l.scope === "peer" ? "peer" : "full",
      relayId: l.relayId ?? null,
      inboundDeviceId: l.inboundDeviceId ?? null,
      agents: l.agents ?? "one-way",
      error: l.error ?? null,
      introducedBy: l.introducedBy ?? null,
      retryAt: l.retryAt ?? null,
      retries: l.retries ?? 0,
    }));
  }

  private saveLinks(links: Link[]) {
    this.deps.kvSet("machines.links", JSON.stringify(links));
    this.deps.changed?.();
  }

  private getLink(id: string): Link | null {
    return this.links().find((l) => l.id === id) ?? null;
  }

  private putLink(link: Link) {
    this.saveLinks([...this.links().filter((l) => l.id !== link.id), link]);
  }

  private updateLink(id: string, patch: Partial<Link>): Link | null {
    const cur = this.getLink(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.putLink(next);
    return next;
  }

  private info(l: Link): MachineInfo {
    return { id: l.id, name: l.name, url: l.url, addedAt: l.addedAt, scope: l.scope, agents: l.agents, error: l.error, introducedBy: l.introducedBy };
  }

  list(): MachineInfo[] {
    return this.links().map((l) => this.info(l));
  }

  /** A linked machine, by id: its address and this hub's sign-in there (for calls to it). */
  linkOf(id: string): { id: string; name: string; url: string; token: string; agents: MachineAgentLink } | null {
    const l = this.getLink(id);
    return l ? { id: l.id, name: l.name, url: l.url, token: l.token, agents: l.agents } : null;
  }

  /** Every machine this one is linked with (for calls to them). */
  linked(): { id: string; name: string; url: string; token: string; agents: MachineAgentLink }[] {
    return this.links().map((l) => ({ id: l.id, name: l.name, url: l.url, token: l.token, agents: l.agents }));
  }

  /** The machine a sign-in here belongs to, if it's another machine's hub (how its agents' requests are recognized). */
  hubOfDevice(device: Device): { id: string; name: string } | null {
    const l = this.links().find((x) => x.agents !== "removing" && x.inboundDeviceId === device.id);
    return l ? { id: l.id, name: l.name } : null;
  }

  /** A refused sign-in is no longer a usable two-way link. */
  signedOut(id: string) {
    this.updateLink(id, { agents: "signed-out", error: "This machine no longer accepts this hub's sign-in: link it again.", retryAt: null });
  }

  private bindInbound(hubId: string, deviceId: string) {
    this.deps.setDeviceHub(deviceId, hubId);
    for (const d of this.deps.devicesOfHub(hubId)) if (d.id !== deviceId) this.deps.revokeDevice(d.id);
    this.updateLink(hubId, { inboundDeviceId: deviceId, agents: "two-way", error: null, retryAt: null, retries: 0 });
  }

  /** Keeps a linked machine's name current (other hubs send theirs with every answer). */
  noteName(id: string, name: string) {
    const clean = String(name ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60);
    const l = this.getLink(id);
    if (l && clean && l.name !== clean) this.updateLink(id, { name: clean });
  }

  private selfHub(): PeerHub {
    const s = this.deps.self();
    return { id: s.id, name: s.name, url: s.url, version: HUB_VERSION };
  }

  /** One operation per machine at a time. */
  private once<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const cur = this.busy.get(id) as Promise<T> | undefined;
    if (cur) return cur;
    const p = fn().finally(() => this.busy.delete(id));
    this.busy.set(id, p);
    return p;
  }

  /**
   * Links another machine's hub with this one, using a pairing code a person got from it: this hub signs in there
   * (a full sign-in), and asks it to send its notifications here. Making it two-way happens in the background.
   */
  async link(address: string, code: string, opts: { mesh?: boolean } = {}): Promise<MachineInfo> {
    const url = hubAddress(address);
    if (!String(code ?? "").trim()) throw new HttpError(400, "Enter the pairing code shown on that machine");
    const self = this.deps.self();
    const paired = await hubCall<{ token: string; device: { id: string; scope?: string }; hub?: { id?: string; name?: string; hostname?: string } }>(url, "/api/pair", {
      method: "POST",
      body: { code, name: `${self.name} (hub)`, platform: "Crosstalk hub" },
    });
    const remote = paired.hub ?? {};
    if (!remote.id || remote.id === self.id) {
      // Refused either way: the sign-in just made there goes again, or the person is left with a device on that machine
      // that nothing can use (its token is dropped here) and only they can sign out, one more with every retry.
      if (paired.device?.id) await hubCall(url, `/api/devices/${encodeURIComponent(paired.device.id)}`, { method: "DELETE", token: paired.token }).catch(() => {});
      throw new HttpError(400, !remote.id ? `${host(url)} runs an older Crosstalk: update it first` : "That's this machine");
    }
    const name = remote.name ?? remote.hostname ?? host(url);
    // Linking again: the old sign-ins (this hub's there, and that hub's here) go.
    const old = this.getLink(remote.id);
    if (old) {
      if (old.deviceId !== paired.device.id) await hubCall(url, `/api/devices/${encodeURIComponent(old.deviceId)}`, { method: "DELETE", token: paired.token }).catch(() => {});
      // Keep a person-created full sign-in in the opposite direction; replace old peer sign-ins.
      for (const d of this.deps.devicesOfHub(remote.id)) if (d.scope === "peer") this.deps.revokeDevice(d.id);
    }
    // Notifications from there come here with this key.
    const relayToken = secretToken();
    const relay: Relay = { id: secretToken().slice(0, 12), name, hash: await sha256(relayToken), createdAt: Date.now() };
    if (self.url) {
      try {
        await hubCall(url, "/api/push/forward", { method: "PUT", token: paired.token, body: { url: `${self.url}/api/push/relay`, token: relayToken, name: self.name } });
      } catch (e) {
        log.warn(`couldn't set up notifications from ${url}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.saveRelays([...this.relays().filter((r) => r.id !== old?.relayId), relay]);
    const link: Link = {
      id: remote.id,
      name,
      url,
      addedAt: Date.now(),
      token: paired.token,
      deviceId: paired.device.id,
      scope: "full",
      relayId: relay.id,
      inboundDeviceId: old?.inboundDeviceId ?? null,
      autoConnect: opts.mesh !== false,
      agents: "one-way",
      error: null,
      introducedBy: null,
      retryAt: null,
      retries: 0,
    };
    this.putLink(link);
    log.info(`linked ${name} (${url})`);
    if (opts.mesh !== false && this.deps.agentsOn()) void this.complete();
    return this.info(link);
  }

  /** The person's tap: make a link two-way now (when agents may reach other chats). */
  connect(id: string): MachineInfo {
    if (!this.deps.agentsOn()) throw new HttpError(409, "Turn on “Let agents reach your other chats” first (Settings → Teamwork).");
    const l = this.getLink(id);
    if (!l) throw new HttpError(404, "That machine isn't linked with this one");
    if (l.scope !== "full") throw new HttpError(400, "Connect it from the machine it was linked from.");
    const next = this.updateLink(id, { autoConnect: true, agents: l.agents === "two-way" ? "two-way" : "connecting", error: null, retryAt: null, retries: 0 })!;
    void this.once(id, () => this.connectLink(id)).then(() => this.introduceAll()).catch(() => {});
    return this.info(next);
  }

  /**
   * Makes every link this hub holds a full sign-in on two-way, then introduces linked machines to each other. Runs
   * in the background (never inside a request) and only while agents may reach other chats.
   */
  async complete(): Promise<void> {
    if (!this.deps.agentsOn()) return;
    for (const l of this.links()) {
      if (l.autoConnect === false || l.scope !== "full" || ["two-way", "needs-update", "signed-out", "removing"].includes(l.agents)) continue;
      await this.once(l.id, () => this.connectLink(l.id)).catch(() => {});
    }
    await this.introduceAll().catch((e) => log.debug(`introductions: ${e}`));
  }

  /**
   * Asks a linked hub to sign in here too (a peer sign-in, tied to it), so its agents can reach chats here. Uses this
   * hub's sign-in there; checks first that the same hub still answers at that address.
   */
  private async connectLink(id: string): Promise<boolean> {
    const l = this.getLink(id);
    if (!l || l.agents === "removing") return false;
    const self = this.deps.self();
    const fail = (agents: MachineAgentLink, error: string, retry: boolean) => {
      const retries = retry ? l.retries + 1 : l.retries;
      this.updateLink(id, { agents, error, retryAt: retry ? Date.now() + BACKOFF[Math.min(retries - 1, BACKOFF.length - 1)] : null, retries });
      log.info(`couldn't connect agents with ${l.name}: ${error}`);
      return false;
    };
    if (!self.url || !secureAddress(self.url)) return fail("one-way", "This machine has no https address (Tailscale isn't set up), so other machines can't reach it.", false);
    if (!secureAddress(l.url)) return fail("one-way", `${l.name} has no https address.`, false);
    this.updateLink(id, { agents: "connecting", error: null });
    let info: { hub: PeerHub };
    try {
      info = await hubCall<{ hub: PeerHub }>(l.url, "/api/machines/peer", { token: l.token, timeoutMs: 5_000, raw: true });
    } catch (e) {
      const err = e as HttpError;
      if (err.status === 401) return fail("signed-out", `${l.name} no longer accepts this machine's sign-in: link it again.`, false);
      if (err.status === 404) return fail("needs-update", `${l.name} runs an older Crosstalk: update it.`, false);
      return fail("failed", err.message, true);
    }
    if (info.hub?.id !== l.id) return fail("failed", `A different Crosstalk answers at ${l.url}.`, true);
    this.noteName(id, info.hub.name);
    const { code } = await this.deps.pairingCode(PEER_CODE_TTL, { scope: "peer", hubId: l.id });
    let res: { ok?: boolean; deviceId?: string };
    try {
      res = await hubCall(l.url, "/api/machines/peer", { method: "POST", token: l.token, body: { kind: "back", url: self.url, code, hub: { id: self.id, name: self.name } }, timeoutMs: 60_000, raw: true });
    } catch (e) {
      const err = e as HttpError;
      if (err.status === 401) return fail("signed-out", `${l.name} no longer accepts this machine's sign-in: link it again.`, false);
      if (err.status === 404) return fail("needs-update", `${l.name} runs an older Crosstalk: update it.`, false);
      return fail("failed", err.message, true);
    }
    // It may reuse a person-created hub sign-in when both people linked the machines. New peer sign-ins
    // must carry this exact hub id, as granted by our pairing code.
    const d = res.deviceId ? this.deps.getDevice(res.deviceId) : null;
    if (!res.ok || !d || (d.scope === "peer" ? d.hubId !== l.id : (d.hubId && d.hubId !== l.id) || d.platform !== "Crosstalk hub")) return fail("failed", `${l.name} didn't sign in here as expected.`, true);
    this.bindInbound(id, d.id);
    log.info(`agents connected with ${l.name}`);
    return true;
  }

  /** What this hub says about itself to another hub's sign-in (checked before making a link two-way). */
  peerInfo(device: Device, agentsOn: boolean) {
    return { hub: this.selfHub(), you: { deviceId: device.id, scope: device.scope ?? "full" }, agentsAcrossChats: agentsOn };
  }

  /** A short-lived peer code for a machine this hub is introducing to another one (full sign-ins only). */
  async peerCodeFor(device: Device, forHub: unknown): Promise<{ code: string; expiresAt: number }> {
    if (device.scope === "peer") throw new HttpError(403, "Only a person's device or the machine that linked this one can do this.", "peer_scope");
    const id = String(forHub ?? "").trim();
    if (!/^h_[\w-]{4,40}$/.test(id)) throw new HttpError(400, "Which machine is it for?");
    const code = await this.deps.pairingCode(PEER_CODE_TTL, { scope: "peer", hubId: id });
    const source = this.hubOfDevice(device);
    if (source) this.deps.kvSet(`machines.introducer.${id}`, JSON.stringify({ id: source.id, expiresAt: code.expiresAt }));
    return code;
  }

  private introducer(id: string): string | null {
    try {
      const intro = JSON.parse(this.deps.kvGet(`machines.introducer.${id}`) ?? "null");
      return intro && intro.expiresAt > Date.now() ? intro.id : null;
    } catch {
      return null;
    }
  }

  /**
   * Another hub asks this one to pair: "back" with itself (making its link two-way), or "introduce" with a third
   * machine (only a full sign-in may ask that). This hub pairs only with the hub the code and the caller are for.
   */
  async peer(caller: Device, body: unknown): Promise<{ ok: true; deviceId?: string; hub: PeerHub }> {
    const b = (body ?? {}) as { kind?: unknown; url?: unknown; code?: unknown; hub?: { id?: unknown; name?: unknown } };
    const kind = b.kind === "back" || b.kind === "introduce" ? b.kind : null;
    if (!kind) throw new HttpError(400, "Unknown request");
    const url = hubAddress(String(b.url ?? ""));
    if (!secureAddress(url)) throw new HttpError(400, "Machines link only over https.");
    const hubId = typeof b.hub?.id === "string" ? b.hub.id : "";
    const hubName = typeof b.hub?.name === "string" ? b.hub.name.replace(/[\u0000-\u001f]/g, "").slice(0, 60) : "";
    if (!/^h_[\w-]{4,40}$/.test(hubId)) throw new HttpError(400, "Which machine?");
    const code = String(b.code ?? "").trim();
    if (!code) throw new HttpError(400, "No pairing code");
    const self = this.selfHub();
    if (hubId === self.id) throw new HttpError(400, "That's this machine");
    if (kind === "introduce") {
      if (caller.scope === "peer") throw new HttpError(403, "Only the machine that linked this one can introduce others.", "peer_scope");
      if (caller.hubId && hubId === caller.hubId) throw new HttpError(400, "That's the machine asking");
    } else if (caller.hubId && caller.hubId !== hubId) {
      throw new HttpError(403, "This sign-in belongs to another machine.", "peer_scope");
    }
    return this.once(`peer:${kind}:${hubId}`, async () => {
      const existing = this.getLink(hubId);
      if (existing && existing.agents === "removing") throw new HttpError(409, "That machine is being unlinked.");
      if (kind === "back" && existing?.inboundDeviceId && existing.inboundDeviceId !== caller.id && caller.scope === "peer" && this.deps.getDevice(existing.inboundDeviceId)) {
        throw new HttpError(409, "That machine is already connected here through another sign-in.");
      }
      // A known machine at a new address: only that machine itself may say so (its sign-in here).
      if (existing && existing.url !== url && !(kind === "back" && existing.scope === "peer" && existing.inboundDeviceId === caller.id)) throw new HttpError(409, "That machine is linked at another address.");
      // Already linked there (a retry after a timeout): don't pair again.
      if (existing && existing.url === url) {
        try {
          const info = await hubCall<{ hub: PeerHub }>(url, "/api/machines/peer", { token: existing.token, timeoutMs: 5_000, raw: true });
          if (info.hub?.id === hubId) {
            if (kind === "back") {
              this.bindInbound(hubId, caller.id);
            } else if (existing.agents !== "two-way") {
              await this.connectIntroduced(hubId);
            }
            return { ok: true as const, deviceId: existing.deviceId, hub: self };
          }
        } catch (e) {
          if (e instanceof HttpError && e.code === "introduction_failed") throw e;
          /* the old sign-in doesn't work there anymore: pair again */
        }
      }
      const paired = await hubCall<{ token: string; device: { id: string; scope?: string }; hub?: { id?: string; name?: string } }>(url, "/api/pair", {
        method: "POST",
        body: { code, name: `${self.name} (hub)`, platform: "Crosstalk hub" },
        timeoutMs: 20_000,
        raw: true,
      }).catch((e: HttpError) => {
        throw new HttpError(502, `Couldn't pair with ${host(url)}: ${e.message}`, e.code === "unreachable" ? "unreachable" : "pair_failed");
      });
      if (paired.hub?.id !== hubId) {
        // Not the machine it said: sign straight out again.
        await hubCall(url, `/api/devices/${encodeURIComponent(paired.device.id)}`, { method: "DELETE", token: paired.token, timeoutMs: 5_000 }).catch(() => {});
        throw new HttpError(403, "A different machine answered at that address.");
      }
      const name = paired.hub.name ?? hubName ?? host(url);
      const base: Link = {
        id: hubId,
        name,
        url,
        addedAt: existing?.addedAt ?? Date.now(),
        token: paired.token,
        deviceId: paired.device.id,
        scope: "peer",
        relayId: null,
        inboundDeviceId: null,
        agents: "connecting",
        error: null,
        introducedBy: existing?.introducedBy ?? this.introducer(hubId),
        retryAt: null,
        retries: 0,
      };
      if (existing && existing.deviceId !== paired.device.id) await hubCall(url, `/api/devices/${encodeURIComponent(existing.deviceId)}`, { method: "DELETE", token: paired.token, timeoutMs: 5_000 }).catch(() => {});
      if (kind === "back") {
        this.putLink(base);
        this.bindInbound(hubId, caller.id);
        log.info(`agents connected with ${name} (it asked)`);
        return { ok: true as const, deviceId: paired.device.id, hub: self };
      }
      // Introduced: now ask the new machine to sign in here too.
      this.putLink({ ...base, introducedBy: this.hubOfDevice(caller)?.id ?? caller.hubId ?? null });
      await this.connectIntroduced(hubId);
      return { ok: true as const, hub: self };
    });
  }

  private async connectIntroduced(id: string) {
    if (await this.connectLink(id)) return;
    const link = this.getLink(id);
    throw new HttpError(link?.agents === "needs-update" ? 404 : 502, link?.error ?? "The introduced machines couldn't connect.", "introduction_failed");
  }

  private intros(): Intro[] {
    try {
      const raw = JSON.parse(this.deps.kvGet("machines.intros") ?? "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  private saveIntro(intro: Intro) {
    this.deps.kvSet("machines.intros", JSON.stringify([...this.intros().filter((i) => !(i.a === intro.a && i.b === intro.b)), intro]));
  }

  /**
   * Introduces every two of this hub's machines (both linked from here, both two-way) to each other, so their
   * agents reach each other's chats directly: the full mesh.
   */
  async introduceAll(): Promise<void> {
    if (!this.deps.agentsOn()) return;
    const full = this.links().filter((l) => l.scope === "full" && l.agents === "two-way");
    for (let i = 0; i < full.length; i++) {
      for (let j = i + 1; j < full.length; j++) {
        const [a, b] = [full[i], full[j]].sort((x, y) => x.id.localeCompare(y.id));
        const prior = this.intros().find((x) => x.a === a.id && x.b === b.id);
        if (prior?.state === "needs-update" || (prior?.retryAt && prior.retryAt > Date.now())) continue;
        try {
          const there = await hubCall<{ id: string; agents?: MachineAgentLink }[]>(a.url, "/api/machines", { token: a.token, timeoutMs: 5_000, raw: true });
          if (there.some((m) => m.id === b.id && m.agents === "two-way")) {
            this.saveIntro({ a: a.id, b: b.id, state: "done", error: null, retryAt: null, retries: 0 });
            continue;
          }
          const { code } = await hubCall<{ code: string }>(b.url, "/api/machines/peer-code", { method: "POST", token: b.token, body: { forHub: a.id }, timeoutMs: 10_000, raw: true });
          await hubCall(a.url, "/api/machines/peer", { method: "POST", token: a.token, body: { kind: "introduce", url: b.url, code, hub: { id: b.id, name: b.name } }, timeoutMs: 90_000, raw: true });
          this.saveIntro({ a: a.id, b: b.id, state: "done", error: null, retryAt: null, retries: 0 });
          log.info(`introduced ${a.name} and ${b.name}`);
        } catch (e) {
          const err = e as HttpError;
          const retries = (prior?.retries ?? 0) + 1;
          const update = err.status === 404;
          this.saveIntro({ a: a.id, b: b.id, state: update ? "needs-update" : "failed", error: err.message, retryAt: update ? null : Date.now() + BACKOFF[Math.min(retries - 1, BACKOFF.length - 1)], retries });
          log.info(`couldn't introduce ${a.name} and ${b.name}: ${err.message}`);
        }
      }
    }
  }

  /** Retries links and introductions that failed, every minute (with backoff). */
  start() {
    this.timer = setInterval(() => void this.retryTick(), 60_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async retryTick() {
    // An unlink a restart interrupted: finish it.
    for (const l of this.links()) if (l.agents === "removing") await this.remove(l.id, { cascade: false }).catch(() => {});
    if (!this.deps.agentsOn()) return;
    const now = Date.now();
    for (const l of this.links()) {
      if (l.scope === "full" && l.agents === "failed" && l.retryAt && l.retryAt <= now) await this.once(l.id, () => this.connectLink(l.id)).catch(() => {});
    }
    if (this.intros().some((i) => i.state === "failed" && i.retryAt && i.retryAt <= now)) await this.introduceAll().catch(() => {});
  }

  /** A pairing code from a linked machine, so a device paired here can add it with one tap. */
  async pairCode(id: string): Promise<{ url: string; code: string; expiresAt: number }> {
    const link = this.getLink(id);
    if (!link) throw new HttpError(404, "That machine isn't linked with this one");
    if (link.scope !== "full") throw new HttpError(400, "Add it from the machine it was linked from.");
    const r = await hubCall<{ code: string; expiresAt: number }>(link.url, "/api/pairing-codes", { method: "POST", token: link.token, body: {} });
    return { url: link.url, code: r.code, expiresAt: r.expiresAt };
  }

  /**
   * Unlinks a machine. Its sign-in here goes first, so this works with the machine off; then, best effort, this
   * hub signs out there. With `cascade`, machines this one introduced it to drop it too.
   */
  async remove(id: string, opts: { cascade?: boolean } = {}): Promise<void> {
    const link = this.getLink(id);
    if (!link) throw new HttpError(404, "That machine isn't linked with this one");
    const introducedTo = new Set(this.intros().flatMap((i) => i.a === id ? [i.b] : i.b === id ? [i.a] : []));
    // The model pool ends what it runs there while this hub's sign-in still works (it's capped: an unlink never waits long).
    if (link.agents !== "removing") await this.deps.beforeUnlink?.(id).catch(() => {});
    this.updateLink(id, { agents: "removing" });
    if (link.inboundDeviceId) this.deps.revokeDevice(link.inboundDeviceId);
    for (const d of this.deps.devicesOfHub(id)) this.deps.revokeDevice(d.id);
    this.saveRelays(this.relays().filter((r) => r.id !== link.relayId));
    const self = this.deps.self();
    const quick = { token: link.token, timeoutMs: 10_000, raw: true };
    if (link.relayId && self.url) await hubCall(link.url, "/api/push/forward", { ...quick, method: "DELETE", body: { url: `${self.url}/api/push/relay` } }).catch(() => {});
    // It drops this hub (and signs it out); then sign out directly too, for a one-way link (nothing to drop there)
    // or an older hub. Once the first worked, the second is simply refused.
    await hubCall(link.url, `/api/machines/${encodeURIComponent(self.id)}?peer=1`, { ...quick, method: "DELETE" }).catch(() => {});
    await hubCall(link.url, `/api/devices/${encodeURIComponent(link.deviceId)}`, { ...quick, method: "DELETE" }).catch(() => {});
    this.saveLinks(this.links().filter((l) => l.id !== id));
    this.deps.kvSet("machines.intros", JSON.stringify(this.intros().filter((i) => i.a !== id && i.b !== id)));
    log.info(`unlinked ${link.name}`);
    if (opts.cascade !== false) {
      for (const other of this.links().filter((l) => introducedTo.has(l.id) && l.scope === "full" && l.agents === "two-way")) {
        void hubCall(other.url, `/api/machines/${encodeURIComponent(id)}`, { method: "DELETE", token: other.token, timeoutMs: 10_000, raw: true }).catch(() => {});
      }
    }
  }

  /** A hub may remove only the peer link it introduced, and the cascade stops here. */
  async removeIntroduced(caller: Device, id: string) {
    const source = this.hubOfDevice(caller);
    const target = this.getLink(id);
    if (!source || caller.scope === "peer") throw new HttpError(403, "Only the machine that introduced this link can remove it.", "peer_scope");
    if (!target || target.scope === "full" || target.introducedBy !== source.id) return;
    await this.remove(id, { cascade: false });
  }

  /**
   * A linked machine unlinked this one: drop it here and sign it out, without calling back. Only that machine's own
   * sign-in may ask.
   */
  peerRemove(caller: Device, id: string) {
    const link = this.getLink(id);
    const bound = (link && link.inboundDeviceId === caller.id) || caller.hubId === id;
    if (!bound) throw new HttpError(403, "This sign-in can't unlink that machine.", "peer_scope");
    if (link && link.agents !== "removing") {
      this.saveLinks(this.links().filter((l) => l.id !== id));
      this.deps.kvSet("machines.forwards", JSON.stringify(this.forwards().filter((f) => !f.url.startsWith(link.url))));
      this.saveRelays(this.relays().filter((r) => r.id !== link.relayId));
      log.info(`${link.name} unlinked this machine`);
    }
    for (const d of this.deps.devicesOfHub(id)) this.deps.revokeDevice(d.id);
    this.deps.revokeDevice(caller.id);
  }

  // ---- notifications from linked machines (this hub's side) ----

  private relays(): Relay[] {
    try {
      const list = JSON.parse(this.deps.kvGet("machines.relays") ?? "[]");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private saveRelays(relays: Relay[]) {
    this.deps.kvSet("machines.relays", JSON.stringify(relays));
  }

  /**
   * A notification from a linked machine: shown on this hub's devices, its title saying where it came from ("Fix
   * login · Linux box"), so the end of a long text being cut off on a lock screen never hides it.
   */
  async relay(token: string | null, body: unknown): Promise<void> {
    const hash = token ? await sha256(token) : "";
    const relay = this.relays().find((r) => r.hash === hash);
    if (!token || !relay) throw new HttpError(401, "unauthorized");
    const b = (body ?? {}) as Record<string, unknown>;
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
    // As the machine is called now (it may have been renamed since it was linked).
    const name = this.links().find((l) => l.relayId === relay.id)?.name ?? relay.name;
    const url = str(b.url, 200);
    const note: PushNote = {
      title: `${str(b.title, 200) || "Crosstalk"} · ${name}`,
      body: str(b.body, 400),
      // A chat's link works from here too: the app finds which machine the chat is on (and Home is every machine's).
      // Any other screen is that machine's own (its storage, memory, costs, This Mac…), and the app opened from here
      // would show this machine's in its place, as if the note were about it: it opens Settings → Machines instead,
      // where that machine is (Show switches to it), and the title says which one the note is about.
      url: !/^\.\/(#\/[\w/-]*)?$/.test(url) ? "./" : /^\.\/(#\/(room\/[\w-]+)?)?$/.test(url) ? url : "./#/settings/machines",
      tag: `${relay.id}-${str(b.tag, 60)}`,
    };
    await this.deps.notify(note);
  }

  // ---- notifications to the hub that linked this one (the other machine's side) ----

  private forwards(): Forward[] {
    try {
      const list = JSON.parse(this.deps.kvGet("machines.forwards") ?? "[]");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  setForward(body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const url = typeof b.url === "string" ? b.url : "";
    if (!/^https?:\/\/[^/]+\/api\/push\/relay$/.test(url) || typeof b.token !== "string" || b.token.length < 16 || b.token.length > 200) throw new HttpError(400, "Invalid notification forwarding");
    const name = typeof b.name === "string" ? b.name.slice(0, 80) : host(url);
    this.deps.kvSet("machines.forwards", JSON.stringify([...this.forwards().filter((f) => f.url !== url), { url, token: b.token, name }]));
  }

  removeForward(body: unknown) {
    const url = typeof (body as { url?: unknown })?.url === "string" ? (body as { url: string }).url : "";
    this.deps.kvSet("machines.forwards", JSON.stringify(this.forwards().filter((f) => f.url !== url)));
  }

  /**
   * Passes a notification on to the hubs that linked this one (never one that came from another hub). A hub that
   * refuses the key (it unlinked this one) gets no more.
   */
  forward(note: PushNote) {
    for (const f of this.forwards()) {
      void fetch(f.url, {
        method: "POST",
        headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
        body: JSON.stringify(note),
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      })
        .then((r) => {
          if (r.status === 401) this.deps.kvSet("machines.forwards", JSON.stringify(this.forwards().filter((x) => x.url !== f.url || x.token !== f.token)));
          else if (!r.ok) log.debug(`notification to ${f.name} failed: ${r.status}`);
        })
        .catch((e) => log.debug(`notification to ${f.name} failed: ${e instanceof Error ? e.message : e}`));
    }
  }

  // ---- one-command setup on a Linux machine ----

  private get distDir() {
    return this.deps.distDir ?? join(HOME, "dist");
  }

  invite(hubUrl: string): MachineInvite {
    for (const [t, i] of this.invites) if (i.expiresAt < Date.now()) this.invites.delete(t);
    const token = secretToken().replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
    const expiresAt = Date.now() + INVITE_TTL;
    this.invites.set(token, { expiresAt, status: "waiting", failures: 0 });
    return { token, expiresAt, command: `curl -fsSL '${hubUrl}/api/machines/install/${token}' | bash` };
  }

  inviteStatus(token: string): MachineInviteStatus {
    const i = this.invites.get(token);
    if (!i) return { status: "expired" };
    if (i.status === "waiting" && i.expiresAt < Date.now()) return { status: "expired" };
    return { status: i.status, machine: i.machine, error: i.error };
  }

  private openInvite(token: string): Invite {
    const i = this.invites.get(token);
    if (!i || i.expiresAt < Date.now()) throw new HttpError(401, "This setup command has expired. Make a new one in Crosstalk: Settings → Machines.");
    if (i.status === "done") throw new HttpError(401, "This setup command was already used. Make a new one in Crosstalk: Settings → Machines.");
    return i;
  }

  /** The Linux hub program for the setup command. */
  binary(token: string, arch: string): string {
    this.openInvite(token);
    if (arch !== "x64" && arch !== "arm64") throw new HttpError(404, "Unsupported CPU");
    const path = join(this.distDir, `crosstalk-hub-linux-${arch}`);
    if (!existsSync(path)) throw new HttpError(404, `This hub has no Linux (${arch}) build to hand out yet.`);
    return path;
  }

  installer(token: string): string {
    this.openInvite(token);
    return INSTALL_SH;
  }

  /** The setup command, as a script: installs the hub, then links it with this one. */
  script(token: string, hubUrl: string): string {
    this.openInvite(token);
    const self = this.deps.self();
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    return `#!/usr/bin/env bash
# Installs the Crosstalk hub on this Linux machine and links it with ${self.name.replace(/[^\w .-]/g, "")}.
# Everything runs as you; the installer asks for your password once (to keep the hub running when you're
# logged out, and to publish it on your Tailscale network).
set -euo pipefail
# ask WHAT FILE CURL-ARGS…: asks Crosstalk, keeping its answer in FILE. When it refuses, this says what it said
# (not curl's "error: 400") and stops.
ask() {
  local what="$1" out="$2" status
  shift 2
  status="$(curl -sSL -o "$out" -w '%{http_code}' "$@")" || {
    echo "$what: couldn't reach Crosstalk at $HUB. Check this machine's network, then run the same command again."
    exit 1
  }
  if [ "$status" -ge 400 ]; then
    echo "$what: $(head -c 1000 "$out")"
    rm -f "$out"
    exit 1
  fi
}
main() {
  HUB=${q(hubUrl)}
  TOKEN=${q(token)}
  [ "$(uname -s)" = Linux ] || { echo "This command is for Linux."; exit 1; }
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;;
  esac
  command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1 || {
    echo "Tailscale isn't running here. Install it (https://tailscale.com/download/linux), run 'sudo tailscale up',"
    echo "and sign in with the same account as your other devices, then run this command again."
    exit 1
  }
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "Downloading the Crosstalk hub…"
  ask "Couldn't download the hub" "$TMP/crosstalk-hub-linux-$ARCH" "$HUB/api/machines/install/$TOKEN/crosstalk-hub-linux-$ARCH"
  ask "Couldn't download the installer" "$TMP/install.sh" "$HUB/api/machines/install/$TOKEN/install.sh"
  chmod +x "$TMP/crosstalk-hub-linux-$ARCH"
  if [ -r /dev/tty ]; then bash "$TMP/install.sh" "$TMP/crosstalk-hub-linux-$ARCH" </dev/tty; else bash "$TMP/install.sh" "$TMP/crosstalk-hub-linux-$ARCH" </dev/null; fi
  DNS="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  [ -n "$DNS" ] || { echo "Couldn't find this machine's Tailscale name."; exit 1; }
  for _ in $(seq 1 30); do curl -fsS -o /dev/null "https://$DNS/api/health" 2>/dev/null && break; sleep 2; done
  CODE="$("$HOME/.local/bin/crosstalk-hub" pair 30 | sed -n 's/^Pairing code: \\([A-Za-z0-9-]*\\).*/\\1/p')"
  echo "Linking with Crosstalk…"
  ask "Linking failed" "$TMP/claim" -X POST "$HUB/api/machines/install/$TOKEN/claim" -H 'content-type: application/json' \\
    --data "{\\"url\\":\\"https://$DNS\\",\\"code\\":\\"$CODE\\"}"
  echo
  echo "  Done. This machine now shows up in Crosstalk."
  echo "  Next: sign the agents in on this machine (Settings → AI services, with this machine picked at the top)."
}
main "$@"
`;
  }

  /**
   * The setup command reports back: link the new hub (and forward its notifications), nothing more. The command
   * works once: a success uses it up, and so do three failures. The address must be https, and on this hub's
   * tailnet when this hub is on one.
   */
  async claim(token: string, body: unknown): Promise<MachineInfo> {
    const invite = this.openInvite(token);
    if (invite.claiming) throw new HttpError(401, "This setup command is already being used.");
    invite.claiming = true;
    const b = (body ?? {}) as { url?: unknown; code?: unknown };
    try {
      const url = hubAddress(String(b.url ?? ""));
      if (!secureAddress(url)) throw new HttpError(400, "The machine's address must be https.");
      const self = this.deps.self();
      const tailnet = self.url && /\.ts\.net$/.test(new URL(self.url).hostname) ? new URL(self.url).hostname.split(".").slice(1).join(".") : null;
      if (tailnet && new URL(url).hostname.split(".").slice(1).join(".") !== tailnet) throw new HttpError(400, "The machine must be on the same Tailscale network.");
      // Connecting agents is a separate, explicit tap in Settings (a leaked command must not hand out more).
      const machine = await this.link(url, String(b.code ?? ""), { mesh: false });
      Object.assign(invite, { status: "done", machine, error: undefined });
      return machine;
    } catch (e) {
      invite.failures++;
      const reason = e instanceof Error ? e.message : String(e);
      const spent = invite.failures >= 3;
      // The app shows the reason with what to do there; the command prints it with what to do on the machine.
      Object.assign(invite, { status: spent ? "failed" : "waiting", error: reason });
      if (spent) invite.expiresAt = 0;
      const next = spent ? "This command was tried 3 times, so it no longer works: make a new one in Crosstalk (Settings → Machines)." : "Fix that, then run the same command again.";
      throw new HttpError(e instanceof HttpError ? e.status : 500, `${reason.replace(/[.\s]*$/, ".")} ${next}`, e instanceof HttpError ? e.code : undefined);
    } finally {
      invite.claiming = false;
    }
  }
}
