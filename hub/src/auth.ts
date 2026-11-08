import type { Device } from "@crosstalk/shared";
import type { Store } from "./db";
import { newId, pairingCode, secretToken, sha256 } from "./util/ids";

const PAIRING_TTL_MS = 30 * 60_000;

export class Auth {
  private revocations = new Set<(deviceId: string) => void>();

  constructor(private store: Store) {}

  onRevoked(listener: (deviceId: string) => void): () => void {
    this.revocations.add(listener);
    return () => { this.revocations.delete(listener); };
  }

  revoke(deviceId: string) {
    this.store.revokeDevice(deviceId);
    for (const listener of this.revocations) listener(deviceId);
  }

  hasDevices(): boolean {
    return this.store.listDevices().length > 0;
  }

  /**
   * A one-time code that pairs a device. `scope: "peer"` makes a sign-in for another machine's hub, limited to what
   * its agents need, and `hubId` ties it to that hub. The scope comes only from here, never from the device.
   */
  async createPairingCode(ttlMs = PAIRING_TTL_MS, opts: { scope?: "full" | "peer"; hubId?: string | null } = {}): Promise<{ code: string; expiresAt: number }> {
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
      platform: platform.slice(0, 40),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
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

export function tokenFromRequest(req: Request, url: URL): string | null {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  const q = url.searchParams.get("token");
  if (q) return q;
  return null;
}
