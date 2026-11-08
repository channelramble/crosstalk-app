import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./db";
import { HOME } from "./config";
import { logger } from "./util/log";

const log = logger("push");

/**
 * Web Push (VAPID) without payload encryption: the push itself carries no data, and the service worker
 * fetches the notification text from the hub using its subscription endpoint as a capability.
 * Works for installed web apps on iOS 16.4+, Android and desktop browsers.
 *
 * Each notification waits for its device's service worker until taken (take), so two sent close together are both
 * shown, each with its own text and tag; older service workers ask for the latest one only (latest).
 */
export interface PushNote {
  title: string;
  body: string;
  url: string;
  tag: string;
}

interface Keys {
  publicKey: string; // base64url raw (65 bytes)
  privateJwk: Record<string, unknown>;
}

const b64url = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

export class Push {
  private keys: Keys | null = null;
  private signingKey: CryptoKey | null = null;
  private visible = new Map<string, number>(); // deviceId -> visible socket count

  /**
   * `contact`: the hub's https address, the push services' way to reach whoever sends its notifications (the JWT's
   * `sub`). Apple refuses an address it can't reach (BadJwtToken, so an iPhone never gets one); others accept the
   * mailto placeholder used without one.
   */
  constructor(
    private store: Store,
    private contact: () => string | null = () => null,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_ok_at INTEGER,
      latest TEXT
    )`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS push_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      taken_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS push_notes_endpoint ON push_notes(endpoint, id)`);
  }

  async init() {
    const path = join(HOME, "vapid.json");
    if (existsSync(path)) {
      this.keys = JSON.parse(readFileSync(path, "utf8"));
    } else {
      const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
      this.keys = { publicKey: b64url(raw), privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Record<string, unknown> };
      writeFileSync(path, JSON.stringify(this.keys), { mode: 0o600 });
    }
    this.signingKey = await crypto.subtle.importKey("jwk", this.keys!.privateJwk as never, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }

  publicKey(): string {
    return this.keys?.publicKey ?? "";
  }

  subscribe(deviceId: string, endpoint: string) {
    if (!/^https:\/\//.test(endpoint)) throw new Error("bad endpoint");
    if (!this.store.getDevice(deviceId)) throw new Error("This device has been signed out.");
    this.store.db
      .query("INSERT INTO push_subs (endpoint, device_id, created_at) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id")
      .run(endpoint, deviceId, Date.now());
  }

  unsubscribe(endpoint: string) {
    this.store.db.query("DELETE FROM push_notes WHERE endpoint = ?").run(endpoint);
    this.store.db.query("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint);
  }

  removeDevice(deviceId: string) {
    this.store.db.query("DELETE FROM push_notes WHERE endpoint IN (SELECT endpoint FROM push_subs WHERE device_id = ?)").run(deviceId);
    this.store.db.query("DELETE FROM push_subs WHERE device_id = ?").run(deviceId);
    this.visible.delete(deviceId);
  }

  hasSubscription(deviceId: string): boolean {
    return !!this.store.getDevice(deviceId) && !!this.store.db.query("SELECT 1 FROM push_subs WHERE device_id = ?").get(deviceId);
  }

  /**
   * For the setup checklist: how many of people's devices (other machines' sign-ins left out, a linking hub's full one
   * too: it's tied to its hub only once the link is two-way) get notifications, how many through Apple (they need an
   * https contact), and when one was last delivered. The endpoints never leave here.
   */
  summary(): { devices: number; apple: number; lastOkAt: number | null } {
    const rows = this.store.db
      .query("SELECT s.endpoint, s.device_id, s.last_ok_at FROM push_subs s JOIN devices d ON d.id = s.device_id WHERE d.revoked = 0 AND d.scope = 'full' AND d.hub_id IS NULL AND d.platform != 'Crosstalk hub'")
      .all() as { endpoint: string; device_id: string; last_ok_at: number | null }[];
    const apple = new Set(rows.filter((r) => /^https:\/\/[^/]*\.push\.apple\.com\//.test(r.endpoint)).map((r) => r.device_id));
    const lastOkAt = rows.reduce<number | null>((max, r) => (r.last_ok_at && (!max || r.last_ok_at > max) ? r.last_ok_at : max), null);
    return { devices: new Set(rows.map((r) => r.device_id)).size, apple: apple.size, lastOkAt };
  }

  latest(endpoint: string): PushNote | null {
    const r = this.store.db.query("SELECT s.latest FROM push_subs s JOIN devices d ON d.id = s.device_id WHERE s.endpoint = ? AND d.revoked = 0").get(endpoint) as { latest: string | null } | null;
    return r?.latest ? JSON.parse(r.latest) : null;
  }

  /** An older service worker asked for the latest notification only: the waiting ones were shown as that one. */
  takeLatest(endpoint: string): PushNote | null {
    this.store.db.query("UPDATE push_notes SET taken_at = ? WHERE endpoint = ? AND taken_at IS NULL").run(Date.now(), endpoint);
    return this.latest(endpoint);
  }

  /**
   * A notification that no longer applies (its approval was answered): a phone that comes online later doesn't show it.
   * Where it's a device's latest (what a push shows when nothing waits), its text becomes `text` instead ("Already
   * answered") under the same chat name and tag, so a push still shows something and never the request again.
   */
  drop(tag: string, text = "Already answered") {
    this.store.db.query("DELETE FROM push_notes WHERE taken_at IS NULL AND json_extract(note, '$.tag') = ?").run(tag);
    const rows = this.store.db.query("SELECT endpoint, latest FROM push_subs WHERE latest IS NOT NULL AND json_extract(latest, '$.tag') = ?").all(tag) as { endpoint: string; latest: string }[];
    for (const r of rows) {
      let note: PushNote;
      try {
        note = JSON.parse(r.latest);
      } catch {
        continue;
      }
      // Saved before notifications led with the chat, the request was its title ("@codex needs approval").
      const old = /^@[\w-]+ (needs approval|has a question)$/.test(note.title);
      this.store.db.query("UPDATE push_subs SET latest = ? WHERE endpoint = ?").run(JSON.stringify((old ? { ...note, title: text } : { ...note, body: text }) satisfies PushNote), r.endpoint);
    }
  }

  /**
   * The notifications waiting for a device's service worker, oldest first, each taken once. A push whose notification
   * an earlier push's service worker already took finds none: it shows `latest` again (same tag, so it only replaces
   * itself), since a push must always show something.
   */
  take(endpoint: string): { notes: PushNote[]; latest: PushNote | null } {
    const latest = this.latest(endpoint);
    if (!latest) return { notes: [], latest: null }; // not a live subscription (or its device was signed out)
    const rows = this.store.db
      .query("SELECT id, note FROM push_notes WHERE endpoint = ? AND taken_at IS NULL AND created_at > ? ORDER BY id LIMIT 8")
      .all(endpoint, Date.now() - NOTE_TTL_MS) as { id: number; note: string }[];
    if (rows.length) this.store.db.query(`UPDATE push_notes SET taken_at = ? WHERE id IN (${rows.map(() => "?").join(",")})`).run(Date.now(), ...rows.map((r) => r.id));
    return { notes: rows.map((r) => JSON.parse(r.note) as PushNote), latest };
  }

  /** Track which devices have the app open and visible, so we don't buzz a phone you're looking at. */
  setVisible(deviceId: string, delta: number) {
    const n = Math.max(0, (this.visible.get(deviceId) ?? 0) + delta);
    if (n) this.visible.set(deviceId, n);
    else this.visible.delete(deviceId);
  }

  anyVisible(): boolean {
    return this.visible.size > 0;
  }

  /** Also hands each notification to hubs that show this one's chats (see machines.ts). */
  onSend: ((note: PushNote) => void) | null = null;

  /** `relayed`: it came from another machine's hub, so it isn't passed on again. */
  /** Sends a note to every signed-in device (but those showing the app, with skipVisible): how many took it, and failed. */
  async send(note: PushNote, opts: { skipVisible?: boolean; relayed?: boolean } = {}): Promise<{ sent: number; failed: number }> {
    if (!opts.relayed) this.onSend?.(note);
    const tally = { sent: 0, failed: 0 };
    if (!this.signingKey || !this.keys) return tally;
    const subs = this.store.db.query("SELECT s.endpoint, s.device_id FROM push_subs s JOIN devices d ON d.id = s.device_id WHERE d.revoked = 0").all() as { endpoint: string; device_id: string }[];
    const now = Date.now();
    this.store.db.query("DELETE FROM push_notes WHERE created_at < ? OR taken_at < ?").run(now - NOTE_TTL_MS, now - 3600_000);
    await Promise.all(
      subs.map(async (s) => {
        if (opts.skipVisible && this.visible.has(s.device_id)) return;
        this.store.db.query("UPDATE push_subs SET latest = ? WHERE endpoint = ?").run(JSON.stringify(note), s.endpoint);
        this.store.db.query("INSERT INTO push_notes (endpoint, note, created_at) VALUES (?,?,?)").run(s.endpoint, JSON.stringify(note), now);
        try {
          const jwt = await this.jwt(new URL(s.endpoint).origin);
          // A sign-out can happen while signing the request.
          if (!this.store.getDevice(s.device_id)) return;
          const res = await fetch(s.endpoint, {
            method: "POST",
            headers: {
              authorization: `vapid t=${jwt}, k=${this.keys!.publicKey}`,
              ttl: "86400",
              urgency: "high",
              // A push service keeps only the newest undelivered push of a topic: one per tag, never two tags sharing one.
              topic: pushTopic(note.tag),
              "content-length": "0",
            },
          });
          if (res.status === 404 || res.status === 410) this.unsubscribe(s.endpoint);
          else if (res.ok) {
            this.store.db.query("UPDATE push_subs SET last_ok_at = ? WHERE endpoint = ?").run(Date.now(), s.endpoint);
            tally.sent++;
          } else {
            tally.failed++;
            log.warn(`push to ${new URL(s.endpoint).host} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
          }
        } catch (e) {
          tally.failed++;
          log.warn(`push failed: ${e instanceof Error ? e.message : e}`);
        }
      }),
    );
    return tally;
  }

  private async jwt(aud: string): Promise<string> {
    const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const head = enc({ typ: "JWT", alg: "ES256" });
    const url = this.contact()?.trim().replace(/\/+$/, "");
    const sub = url && /^https:\/\/[^/\s]+/.test(url) ? url : "mailto:hub@crosstalk.invalid";
    const body = enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub });
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.signingKey!, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(sig)}`;
  }
}

/** How long a notification waits for its device to come online and take it. */
const NOTE_TTL_MS = 24 * 3600_000;

/**
 * A tag as a push topic (at most 32 URL-safe characters): the same tag always gives the same topic, so a push service
 * holding a phone's pushes while it's offline replaces only an older push of that tag (a chat's "finished"), never
 * another notification (an approval) whose tag happened to start the same way.
 */
export function pushTopic(tag: string): string {
  return createHash("sha256").update(tag || "crosstalk").digest("base64url").slice(0, 32);
}
