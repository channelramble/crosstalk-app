// Price lists (hub/src/prices.ts) against a fake price server on a port of its own: a match, a miss, once a day, offline,
// the setting off, an in-memory hub. Nothing here reaches the internet.
import { afterEach, describe, expect, test } from "bun:test";
import { Prices, priceTokens } from "../src/prices";

/** models.dev's shape: providers with models and `cost` per million tokens. A free tier lists the same model at zero first. */
const MODELS_DEV = {
  freebie: { id: "freebie", models: { "gpt-5": { id: "gpt-5", cost: { input: 0, output: 0 } } } },
  openai: { id: "openai", models: { "gpt-5": { id: "gpt-5", cost: { input: 1.25, output: 10, cache_read: 0.125 } }, "no-price": { id: "no-price", name: "No price" } } },
  anthropic: {
    id: "anthropic",
    models: {
      "claude-sonnet-4-5": { id: "claude-sonnet-4-5", cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
      "claude-haiku-4-5": { id: "claude-haiku-4-5", cost: { input: 1, output: 5 } },
    },
  },
};
const OPENROUTER = {
  data: [
    { id: "anthropic/claude-sonnet-4.5", pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" } },
    { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
  ],
};

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

function priceServer() {
  const seen = { modelsDev: 0, openrouter: 0 };
  const mode = { failing: false, body: MODELS_DEV as unknown };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/openrouter") seen.openrouter++;
      else seen.modelsDev++;
      if (mode.failing) return new Response("down", { status: 500 });
      return Response.json(path === "/openrouter" ? OPENROUTER : mode.body);
    },
  });
  servers.push(server);
  return { seen, mode, url: `http://127.0.0.1:${server.port}/api.json`, openRouterUrl: `http://127.0.0.1:${server.port}/openrouter`, host: `127.0.0.1:${server.port}` };
}

function kv(start: Record<string, string> = {}) {
  const map = new Map(Object.entries(start));
  return { map, kvGet: (k: string) => map.get(k) ?? null, kvSet: (k: string, v: string) => void map.set(k, v) };
}

describe("price lookup", () => {
  test("matches by model id: a match, a dated or prefixed name, a free tier's zero, a miss", async () => {
    const s = priceServer();
    const prices = new Prices({ ...kv(), url: s.url });
    expect(await prices.refresh()).toBe(true);
    expect(prices.lookup("claude-sonnet-4-5")).toEqual([3, 15, 0.3]);
    expect(prices.lookup("claude-sonnet-4-5-20250929")).toEqual([3, 15, 0.3]); // a date at the end
    expect(prices.lookup("anthropic/claude-haiku-4-5")).toEqual([1, 5, null]); // a vendor in front
    expect(prices.lookup("claude-sonnet-4-5[1m]")).toEqual([3, 15, 0.3]); // Claude Code's long-context mark
    expect(prices.lookup("GPT-5")).toEqual([1.25, 10, 0.125]); // the priced entry, not the free tier's zero listed before it
    expect(prices.lookup("some-new-model")).toBeNull(); // no match is unknown, never a guess
    expect(prices.lookup("no-price")).toBeNull(); // listed without a cost
    expect(prices.lookup(null)).toBeNull();
    expect(prices.status()).toMatchObject({ source: s.host });
  });

  test("works out what tokens cost, cached input at the cache price", () => {
    expect(priceTokens([3, 15, 0.3], 1500, 80, 300)).toBe(0.00489); // 1200 x 3 + 300 x 0.3 + 80 x 15, per million
    expect(priceTokens([1, 5, null], 1000, 100, 400)).toBe(0.0015); // no cache price: all input at the input price
    expect(priceTokens([3, 15, 0.3], 0, 0, 0)).toBe(0);
  });

  test("fetches at most once a day, and keeps the list with its date", async () => {
    const s = priceServer();
    let clock = Date.parse("2026-10-27T09:00:00Z");
    const store = kv();
    const prices = new Prices({ ...store, url: s.url, now: () => clock });
    await prices.refresh();
    expect(s.seen.modelsDev).toBe(1);
    clock += 3600_000;
    expect(await prices.refresh()).toBe(false); // an hour later: nothing is a day old
    prices.lookup("claude-sonnet-4-5");
    expect(s.seen.modelsDev).toBe(1);
    clock += 25 * 3600_000;
    prices.lookup("claude-sonnet-4-5"); // a list a day old is fetched again, in the background
    expect(await prices.refresh()).toBe(true);
    expect(s.seen.modelsDev).toBe(2);
    expect(prices.status()?.fetchedAt).toBe(clock);
    // Kept in kv with its date: a new Prices object starts from it with no request.
    const again = new Prices({ ...store, url: s.url, enabled: () => false, now: () => clock });
    expect(again.lookup("claude-sonnet-4-5")).toEqual([3, 15, 0.3]);
    expect(again.status()?.fetchedAt).toBe(clock);
    expect(s.seen.modelsDev).toBe(2);
  });

  test("offline, the last copy is used however old, and a failed fetch waits before it tries again", async () => {
    const s = priceServer();
    let clock = Date.parse("2026-10-27T09:00:00Z");
    const store = kv();
    const prices = new Prices({ ...store, url: s.url, now: () => clock });
    await prices.refresh();
    const fetchedAt = clock;
    s.mode.failing = true;
    clock += 3 * 24 * 3600_000;
    expect(prices.lookup("claude-sonnet-4-5")).toEqual([3, 15, 0.3]); // stale, still used
    await prices.refresh();
    expect(s.seen.modelsDev).toBe(2);
    expect(prices.status()?.fetchedAt).toBe(fetchedAt); // the old date, so it shows how old the prices are
    for (let i = 0; i < 5; i++) prices.lookup("claude-sonnet-4-5"); // a reply each: not a request each
    expect(s.seen.modelsDev).toBe(2);
    clock += 31 * 60_000;
    prices.lookup("claude-sonnet-4-5");
    await prices.refresh();
    expect(s.seen.modelsDev).toBe(3);
    // A server that's gone entirely, and a copy from before: the same.
    servers.pop()!.stop(true);
    const later = new Prices({ ...store, url: s.url, now: () => clock });
    expect(await later.refresh()).toBe(false);
    expect(later.lookup("gpt-5")).toEqual([1.25, 10, 0.125]);
  });

  test("a page with no prices in it (an error page, a changed format) leaves the copy kept", async () => {
    const s = priceServer();
    let clock = Date.parse("2026-10-27T09:00:00Z");
    const prices = new Prices({ ...kv(), url: s.url, now: () => clock });
    await prices.refresh();
    s.mode.body = { error: "maintenance" };
    clock += 2 * 24 * 3600_000;
    expect(await prices.refresh()).toBe(false);
    expect(prices.lookup("claude-sonnet-4-5")).toEqual([3, 15, 0.3]);
  });

  test("the setting off: no request at all, but a copy already kept is still used", async () => {
    const s = priceServer();
    const kept = kv({ "prices.cache": JSON.stringify({ "models.dev": { fetchedAt: 1, table: { "gpt-5": [1.25, 10, 0.125] } } }) });
    const prices = new Prices({ ...kept, url: s.url, enabled: () => false });
    expect(await prices.refresh()).toBe(false);
    expect(prices.lookup("gpt-5")).toEqual([1.25, 10, 0.125]);
    expect(prices.lookup("claude-sonnet-4-5")).toBeNull();
    expect(s.seen.modelsDev).toBe(0);
    // Back on, it fetches.
    let on = false;
    const toggled = new Prices({ ...kv(), url: s.url, enabled: () => on });
    expect(await toggled.refresh()).toBe(false);
    on = true;
    expect(await toggled.refresh()).toBe(true);
    expect(s.seen.modelsDev).toBe(1);
  });

  test("an in-memory hub never fetches unless it's told where; CROSSTALK_PRICES_URL says where for any other", async () => {
    const s = priceServer();
    const before = process.env.CROSSTALK_PRICES_URL;
    process.env.CROSSTALK_PRICES_URL = s.url;
    try {
      const memory = new Prices({ ...kv(), inMemory: true });
      expect(await memory.refresh()).toBe(false);
      memory.lookup("gpt-5");
      expect(s.seen.modelsDev).toBe(0);
      expect(await new Prices({ ...kv(), inMemory: true, url: s.url }).refresh()).toBe(true); // a test names the address
      const real = new Prices(kv()); // no option: the environment's address
      expect(await real.refresh()).toBe(true);
      expect(real.lookup("gpt-5")).toEqual([1.25, 10, 0.125]);
      expect(s.seen.modelsDev).toBe(2);
    } finally {
      if (before === undefined) delete process.env.CROSSTALK_PRICES_URL;
      else process.env.CROSSTALK_PRICES_URL = before;
    }
  });

  test("an account on OpenRouter uses OpenRouter's own list; nobody else asks for it", async () => {
    const s = priceServer();
    const on = new Prices({ ...kv(), url: s.url, openRouterUrl: s.openRouterUrl, hosts: () => ["openrouter.ai"] });
    await on.refresh();
    expect(s.seen.openrouter).toBe(1);
    expect(on.lookup("anthropic/claude-sonnet-4.5", "openrouter.ai")).toEqual([3, 15, 0.3]); // dollars per token, as per million
    expect(on.lookup("anthropic/claude-sonnet-4.5", "api.anthropic.com")).toBeNull(); // not that service's model
    expect(on.lookup("openrouter/auto", "openrouter.ai")).toBeNull(); // "-1": priced some other way
    expect(on.lookup("gpt-5", "openrouter.ai")).toEqual([1.25, 10, 0.125]); // models.dev still covers the rest
    const off = new Prices({ ...kv(), url: s.url, openRouterUrl: s.openRouterUrl, hosts: () => ["api.moonshot.ai"] });
    await off.refresh();
    expect(s.seen.openrouter).toBe(1);
  });
});
