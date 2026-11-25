import type { Device } from "@crosstalk/shared";
import type { Store } from "./db";
import { newId, pairingCode, secretToken, sha256 } from "./util/ids";

const PAIRING_TTL_MS = 30 * 60_000;
/** How long the pairing code a hub prints at its first start lasts (it stays in the service's log): an hour. */
export const FIRST_CODE_TTL_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
/** Why a sign-in ended, when it was for saying nothing for too long (devices.revoked_why, and the 401's `code`). */
export const IDLE = "idle";
export const SIGNED_OUT_IDLE = "signed_out_idle";
/** What another machine's hub signs in as (Device.platform). A code made for a machine gives it this by itself. */
export const HUB_PLATFORM = "Crosstalk hub";

export class Auth {
  private revocations = new Set<(deviceId: string) => void>();

  constructor(private store: Store) {}

  onRevoked(listener: (deviceId: string) => void): () => void {
    this.revocations.add(listener);
    return () => { this.revocations.delete(listener); };
  }

  /** `why`: set when Crosstalk ends the sign-in by itself ("idle"), so the device can be told why. */
  revoke(deviceId: string, why: string | null = null) {
    this.store.revokeDevice(deviceId, why);
    for (const listener of this.revocations) listener(deviceId);
  }

  /** The device said something to an agent (a message, an answer to a request): its month without one starts again. */
  spoke(deviceId: string) {
    this.store.deviceSpoke(deviceId);
  }

  /**
   * Signs out every person's device that has said nothing for `days` (0: none). Linked machines aren't people's devices
   * and stay. Returns the ones it signed out.
   */
  signOutIdle(days: number, now = Date.now()): Device[] {
    if (!(days > 0)) return [];
    const idle = this.store.idleDevices(now - days * DAY_MS);
    for (const d of idle) this.revoke(d.id, IDLE);
    return idle;
  }

  /** Why the sign-in this token belonged to ended, when Crosstalk ended it by itself: "idle", or null. */
  async endedWhy(token: string | null | undefined): Promise<string | null> {
    return token ? this.store.revokedWhy(await sha256(token)) : null;
  }

  hasDevices(): boolean {
    return this.store.listDevices().length > 0;
  }

  /**
   * A one-time code that pairs a device. `scope: "peer"` makes a sign-in for another machine's hub, limited to what
   * its agents need, and `hubId` ties it to that hub. The scope comes only from here, never from the device.
   * `kind: "hub"` makes a code for linking a machine: the sign-in it makes is a machine's whatever it calls itself.
   */
  async createPairingCode(ttlMs = PAIRING_TTL_MS, opts: { scope?: "full" | "peer"; hubId?: string | null; kind?: "hub" | null } = {}): Promise<{ code: string; expiresAt: number }> {
    const code = pairingCode();
    const expiresAt = Date.now() + ttlMs;
    this.store.insertPairingCode(await sha256(normalize(code)), expiresAt, opts);
    return { code, expiresAt };
  }

  async pair(code: string, name: string, platform: string): Promise<{ token: string; device: Device } | null> {
    const granted = this.store.consumePairingCode(await sha256(normalize(code)));
    if (!granted) return null;
    const token = secretToken();
    const device: Device = {
      id: newId("d"),
      name: name.trim().slice(0, 60) || "Device",
      // A code made for a machine makes a machine's sign-in: what the caller calls itself can't make it a person's.
      platform: granted.kind === "hub" || granted.scope === "peer" || granted.hubId ? HUB_PLATFORM : platform.slice(0, 40),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      lastMessageAt: Date.now(),
      scope: granted.scope,
      hubId: granted.hubId,
    };
    this.store.insertDevice(device, await sha256(token));
    return { token, device };
  }

  async verify(token: string | null | undefined): Promise<Device | null> {
    if (!token) return null;
    const d = this.store.deviceByTokenHash(await sha256(token));
    if (d) this.store.touchDevice(d.id);
    return d;
  }
}

function normalize(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** How a pairing code is kept (only its hash is stored). */
export function pairingCodeHash(code: string): Promise<string> {
  return sha256(normalize(code));
}

/** The live sockets: the only addresses where a sign-in may come any other way than the Authorization header. */
const SOCKET_PATHS = new Set(["/api/ws", "/api/screen/ws"]);
/** The subprotocol the app's sockets speak; its sign-in is offered beside it as `bearer.<token>`. */
export const SOCKET_PROTOCOL = "crosstalk";
const SOCKET_BEARER = "bearer.";

/** The subprotocols a socket's request offers (Sec-WebSocket-Protocol). */
export function socketProtocols(req: Request): string[] {
  return (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
}

/**
 * A request's device token: the Authorization header. A browser can't set that header on a WebSocket, so the two
 * sockets also take it as a subprotocol (`Sec-WebSocket-Protocol: crosstalk, bearer.<token>`) and, for older apps, as
 * `?token=`. No other route reads a token from its address: addresses end up in logs and histories.
 */
export function tokenFromRequest(req: Request, url: URL): string | null {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  if (!SOCKET_PATHS.has(url.pathname)) return null;
  const offered = socketProtocols(req).find((p) => p.startsWith(SOCKET_BEARER) && p.length > SOCKET_BEARER.length);
  if (offered) return offered.slice(SOCKET_BEARER.length);
  return url.searchParams.get("token") || null;
}
