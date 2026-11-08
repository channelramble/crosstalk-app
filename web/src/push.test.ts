import { afterEach, expect, test } from "bun:test";
import { keepPushWorking, rememberPushOff } from "./push";

const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(key: string, value: unknown) {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
afterEach(() => {
  for (const [key, d] of originals) {
    if (d) Object.defineProperty(globalThis, key, d);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  originals.clear();
});

const key = (fill: number) => Buffer.from(new Uint8Array(65).fill(fill)).toString("base64url");
const HUB_KEY = key(4);

/**
 * A browser with push, and a hub, played here: `permission` given or not, the subscription the browser still has (and
 * the key it was made with), and whether the hub sends notifications to this device.
 */
function setup(opts: { permission: NotificationPermission; has: { endpoint: string; key: string } | null; subscribed: boolean; refuse?: boolean }) {
  const storage = new Map<string, string>();
  replace("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) });
  replace("window", globalThis);
  replace("PushManager", class {});
  replace("Notification", { permission: opts.permission });
  replace("navigator", { userAgent: "test", serviceWorker: {} });
  const sub = (endpoint: string, made: string) => ({ endpoint, options: { applicationServerKey: Uint8Array.from(Buffer.from(made, "base64url")).buffer }, unsubscribe: async () => ((current = null), true) });
  let current: ReturnType<typeof sub> | null = opts.has ? sub(opts.has.endpoint, opts.has.key) : null;
  const subscribed: string[] = [];
  const reg = {
    pushManager: {
      getSubscription: async () => current,
      subscribe: async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
        if (opts.refuse) throw new Error("The push service refused.");
        subscribed.push(Buffer.from(applicationServerKey).toString("base64url"));
        return (current = sub("https://push.example/new", Buffer.from(applicationServerKey).toString("base64url")));
      },
    },
  } as unknown as ServiceWorkerRegistration;
  const asked: { path: string; body: unknown }[] = [];
  replace("fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url, "http://hub.test").pathname;
    asked.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(path === "/api/push/key" ? { publicKey: HUB_KEY, subscribed: opts.subscribed } : { ok: true }), { status: 200 });
  });
  const home = { baseUrl: "http://hub.test", token: "t", deviceName: "Phone" };
  return { run: () => keepPushWorking(home, reg), asked, subscribed, sent: () => asked.filter((a) => a.path === "/api/push/subscribe").map((a) => a.body) };
}

test("each start sends this device's subscription to the hub again", async () => {
  const s = setup({ permission: "granted", has: { endpoint: "https://push.example/kept", key: HUB_KEY }, subscribed: true });
  expect(await s.run()).toBe("on");
  expect(s.sent()).toEqual([{ endpoint: "https://push.example/kept" }]);
  expect(s.subscribed).toEqual([]);
});

test("a subscription the browser lost is made again, with the hub's key", async () => {
  const s = setup({ permission: "granted", has: null, subscribed: true });
  expect(await s.run()).toBe("on");
  expect(s.subscribed).toEqual([HUB_KEY]);
  expect(s.sent()).toEqual([{ endpoint: "https://push.example/new" }]);
  // One made with keys the hub no longer has is made again too.
  const old = setup({ permission: "granted", has: { endpoint: "https://push.example/old", key: key(7) }, subscribed: true });
  expect(await old.run()).toBe("on");
  expect(old.subscribed).toEqual([HUB_KEY]);
  expect(old.sent()).toEqual([{ endpoint: "https://push.example/new" }]);
});

test("notifications the browser can no longer show are said to have stopped", async () => {
  // Permission taken back in the phone's settings, while the hub still sends here.
  const taken = setup({ permission: "denied", has: { endpoint: "https://push.example/kept", key: HUB_KEY }, subscribed: true });
  expect(await taken.run()).toBe("stopped");
  expect(taken.sent()).toEqual([]);
  // Lost, and it can't be made again.
  const refused = setup({ permission: "granted", has: null, subscribed: true, refuse: true });
  expect(await refused.run()).toBe("stopped");
});

test("notifications never turned on, or turned off here, stay off", async () => {
  const never = setup({ permission: "granted", has: null, subscribed: false });
  expect(await never.run()).toBe("off");
  expect(never.subscribed).toEqual([]);
  expect(never.sent()).toEqual([]);
  const off = setup({ permission: "granted", has: { endpoint: "https://push.example/kept", key: HUB_KEY }, subscribed: false });
  rememberPushOff(true);
  expect(await off.run()).toBe("off");
  // Not even the hub is asked.
  expect(off.asked).toEqual([]);
});
