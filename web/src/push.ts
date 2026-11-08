/**
 * Push notifications on this device (web app only). They always go through the machine this app opens from: its
 * service worker asks that hub for each notification's text (public/sw.js), and linked machines' notifications come
 * through it (hub machines.ts relay).
 */
import { api, isNative, type Connection } from "./api";

export const pushSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && !isNative;

/** Turned off on this device by you: never turned back on by itself. */
const OFF_KEY = "crosstalk.push.off";
export function rememberPushOff(off: boolean) {
  try {
    if (off) localStorage.setItem(OFF_KEY, "1");
    else localStorage.removeItem(OFF_KEY);
  } catch {
    // storage unavailable: nothing to remember it in
  }
}
const turnedOff = () => {
  try {
    return localStorage.getItem(OFF_KEY) === "1";
  } catch {
    return false;
  }
};

export function b64ToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Made with the hub's key as it is now (a hub that made new keys can't send to a subscription made with old ones). */
function madeWith(sub: PushSubscription, publicKey: string): boolean {
  const key = sub.options?.applicationServerKey;
  if (!key || !publicKey) return true;
  const a = new Uint8Array(key);
  const b = b64ToBytes(publicKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function subscribe(reg: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) as BufferSource });
}

/**
 * On each start: keeps this device's notifications working. With permission given, its subscription goes to the hub
 * again (the hub keeps one per subscription, so this only refreshes it), and one the browser lost (or that was made
 * with the hub's old keys) is made again. "stopped": the hub sends notifications here, but this browser can't show
 * them any more (permission was taken back, or a new subscription couldn't be made).
 */
export async function keepPushWorking(home: Connection, reg: ServiceWorkerRegistration): Promise<"on" | "off" | "stopped"> {
  if (!pushSupported() || turnedOff()) return "off";
  const k = await api<{ publicKey: string; subscribed: boolean }>("GET", "/api/push/key", undefined, home);
  if (Notification.permission !== "granted") return k.subscribed ? "stopped" : "off";
  let sub = await reg.pushManager.getSubscription();
  if (sub && !madeWith(sub, k.publicKey)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  // Lost by the browser while the hub still sends here: made again.
  if (!sub && k.subscribed) sub = await subscribe(reg, k.publicKey).catch(() => null);
  if (!sub) return k.subscribed ? "stopped" : "off";
  await api("POST", "/api/push/subscribe", { endpoint: sub.endpoint }, home);
  return "on";
}
