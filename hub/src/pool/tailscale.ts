// What the model pool asks this hub's Tailscale (docs/MODEL-POOL.md): the round trip to a machine (`tailscale ping`,
// direct or through a relay) and the devices on the tailnet (`tailscale status --json`), for adding a computer by
// picking it. Nothing here opens a connection to another machine itself: tailscaled does the pinging.

import { HttpError } from "../engine/engine";
import { askTailscale, isTailscaleIPv4, runTailscaleCli, tailscaleBin } from "../tailscale";

/** A device on this hub's tailnet (GET /api/pool/tailscale). */
export interface TailscalePeer {
  name: string;
  /** Its Tailscale IPv4. */
  address: string;
  /** As Tailscale says it: "windows", "linux", "macOS", "iOS"… */
  os: string;
  online: boolean;
  /** Reached directly rather than through a relay (null while it's offline). */
  direct: boolean | null;
}

/** The round trip to a machine over Tailscale, and whether it goes direct (null: unknown). */
export interface TailscaleLink {
  ms: number | null;
  direct: boolean | null;
}

/** The CLI, through the shared runner (tailscale.ts): without its shell hint the macOS app's CLI opens the GUI instead. */
async function run(args: string[], timeoutMs: number): Promise<{ code: number | null; out: string } | null> {
  const bin = tailscaleBin();
  return bin ? runTailscaleCli(bin, args, timeoutMs) : null;
}

/** A Go duration as `tailscale ping` prints it ("45ms", "1.234s", "512µs", "1m2s"), in milliseconds. */
export function goDurationMs(text: string): number | null {
  if (!/^(?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|s|m|h))+$/.test(text)) return null;
  const unit: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, μs: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let ms = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/g)) ms += Number(m[1]) * unit[m[2]];
  return Math.round(ms * 10) / 10;
}

/**
 * The pong line of `tailscale ping`: "pong from linux-box (100.64.0.2) via DERP(nyc) in 45ms" goes through a relay,
 * "… via 192.168.1.20:41641 in 3ms" (or "[2001:db8::1]:41641") goes direct. Null when there was no pong.
 */
export function parsePing(text: string): TailscaleLink | null {
  const m = /^pong from .*? via (\S+) in (\S+?)\s*$/m.exec(text);
  if (!m) return null;
  const via = m[1];
  const direct = /^DERP\(/i.test(via) ? false : /^(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\]):\d+$/i.test(via) ? true : null;
  return { ms: goDurationMs(m[2]), direct };
}

/**
 * The round trip from this hub to a Tailscale address (`tailscale ping --c 1 --timeout 3s`): null when Tailscale isn't
 * on this hub (unknown), `{ ms: null, direct: null }` when there was no answer. The pong line counts whatever the exit
 * code: with one ping, a relayed answer still exits 1 ("direct connection not established").
 */
export async function tailscalePing(ip: string): Promise<TailscaleLink | null> {
  if (!isTailscaleIPv4(ip)) return null;
  const r = await run(["ping", "--c", "1", "--timeout", "3s", ip], 8000);
  if (!r) return null;
  return parsePing(r.out) ?? { ms: null, direct: null };
}

interface StatusPeer {
  HostName?: unknown;
  DNSName?: unknown;
  OS?: unknown;
  TailscaleIPs?: unknown;
  Online?: unknown;
  CurAddr?: unknown;
}

/** The other devices in `tailscale status --json` (its Peer map; this hub's own entry left out), online ones first. */
export function parseStatus(status: unknown): TailscalePeer[] {
  const s = (status && typeof status === "object" ? status : {}) as { Self?: StatusPeer; Peer?: Record<string, StatusPeer> | null };
  const ips = (p: StatusPeer | undefined) => (Array.isArray(p?.TailscaleIPs) ? p!.TailscaleIPs.filter((x): x is string => typeof x === "string") : []);
  const own = new Set(ips(s.Self));
  const peers: TailscalePeer[] = [];
  for (const p of Object.values(s.Peer && typeof s.Peer === "object" ? s.Peer : {})) {
    if (!p || typeof p !== "object") continue;
    const list = ips(p);
    if (list.some((ip) => own.has(ip))) continue;
    const address = list.find(isTailscaleIPv4);
    if (!address) continue;
    const dns = typeof p.DNSName === "string" ? p.DNSName.split(".")[0] : "";
    const name = (typeof p.HostName === "string" && p.HostName.trim()) || dns || address;
    const online = p.Online === true;
    peers.push({
      name: name.replace(/[\u0000-\u001f]/g, "").slice(0, 63),
      address,
      os: typeof p.OS === "string" ? p.OS.slice(0, 20) : "",
      online,
      direct: online ? typeof p.CurAddr === "string" && p.CurAddr !== "" : null,
    });
  }
  return peers.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/**
 * The devices on this hub's tailnet, for picking a computer to add (GET /api/pool/tailscale). Asked the shared way
 * (tailscale.ts): the CLI, else the macOS app's own API.
 */
export async function tailscalePeers(): Promise<TailscalePeer[]> {
  const { tried, status } = await askTailscale({ peers: true }, { timeoutMs: 10_000 });
  if (!tried.length) throw new HttpError(503, "Tailscale isn't installed on this hub: install it from tailscale.com and sign in, then try again. You can also type the computer's address.", "no_tailscale");
  if (!status || (typeof status.BackendState === "string" && status.BackendState !== "Running")) {
    throw new HttpError(503, "Tailscale isn't running on this hub: open Tailscale and sign in, then try again. You can also type the computer's address.", "no_tailscale");
  }
  return parseStatus(status);
}
