// AI services (docs/SPEC-0.4.md, track T5): checking a service before use (free probes, no model request), live model
// lists, and finding model servers running on this machine. The probing itself is in serviceProbes.ts.

import { DEFAULT_ACCOUNT, PROVIDER_INFO, SERVICE_AGENTS, SERVICE_MAX_MODELS, isServiceAgent, memberAccount, serviceAgentFor, serviceModelPick, serviceModelsKept, type AgentAccount, type CatalogSearch, type ChatProvider, type LocalServer, type Member, type Protocol, type Provider, type ServiceAgent, type ServicePlan, type ServiceTestRequest, type ServiceTestResult } from "@crosstalk/shared";
import type { App } from "./app";
import { HttpError } from "./engine/engine";
import { Featherless, KeyRefused, PLAN_TTL_MS, chatNotice, keyRef } from "./featherless";
import { NanoGpt, priceWords } from "./nanogpt";
import { Refuseless, challengeWords, refuselessAbout, refuselessFacts, refuselessOrder } from "./refuseless";
import { endpointAddress } from "./providers";
import { route, type Route } from "./routes";
import { CHAT_PATH, SERVER_NAMES, cleanChatPath, cleanKey, listPathFor, probeRoutes, protocolsOf, readServer, routePaths, supportOf, worksOf, type Answer, type Found, type ListedModel, type ServerKind } from "./serviceProbes";

/** The usual ports of model servers on a machine, with what a server there is taken for when it doesn't say what it is. */
const SCAN_PORTS: Record<number, ServerKind> = { 11434: "ollama", 1234: "lmstudio", 9931: "llamacpp", 8080: "mlx", 8000: "vllm" };
const SCAN_TIMEOUT_MS = 1000;
const SCAN_CACHE_MS = 10_000;
/** Where the plan each Featherless key was last read as being on is kept (by a hash of the key, never the key). */
const PLANS_KEY = "featherless.plans";
/** Where the Featherless notices already said in chats are kept, so a restart never says one again. */
const NOTICES_KEY = "featherless.notices";
/** Notices remembered at most (the oldest go first: a chat that old has had its say). */
const MAX_NOTICES = 500;

/**
 * CROSSTALK_LOCAL_SERVER_PORTS="11434:ollama,9931:llamacpp" replaces the usual ports (empty: look nowhere), read when a
 * look starts. The test hubs set it so they never look at the real machine they run on.
 */
function portsFromEnv(): Record<number, ServerKind> | undefined {
  const raw = process.env.CROSSTALK_LOCAL_SERVER_PORTS;
  if (raw === undefined) return undefined;
  const rows = raw.split(",").map((s) => s.trim().split(":")).filter(([port]) => port);
  return Object.fromEntries(rows.map(([port, kind]) => [Number(port), kind && kind in SERVER_NAMES ? (kind as ServerKind) : "other"]));
}

export interface ScanOptions {
  /** Where to look: this machine only (the default 127.0.0.1; tests pass fake servers). */
  host?: string;
  /** The ports to try, each with the kind a server there is taken for without other evidence (mlx-lm shares 8080 with llama.cpp: only llama.cpp answers /props). */
  ports?: Record<number, ServerKind>;
  timeoutMs?: number;
  /** Look again even when the last look is under 10 seconds old. */
  fresh?: boolean;
}

type Scanned = Omit<LocalServer, "accountIds">;

export class Services {
  /** How long each free probe waits for a server (the spec says 8 seconds; tests shorten it). */
  timeoutMs = 8000;
  /** What localServers() uses unless told otherwise. */
  scanOptions: ScanOptions = {};
  /** Ports looked at besides those: the servers Settings → Local models started (localRunners.ts), wherever they listen. */
  extraPorts: () => Record<number, ServerKind> = () => ({});
  /**
   * Featherless's catalogue (a model list searched on the service instead of read), which plan each key is on, and each
   * model's price (featherless.ts). The plans read are kept in kv, so a restart doesn't forget them.
   */
  readonly catalog = new Featherless({ get: () => this.app.store.kvGet(PLANS_KEY), set: (v) => this.app.store.kvSet(PLANS_KEY, v) });
  /** NanoGPT's catalogue, prices and funds: a list read whole and searched here (nanogpt.ts). */
  readonly nanogpt = new NanoGpt();
  /** Refuseless's balance, and what the hub knows of its models' names and prices (refuseless.ts). */
  readonly refuseless = new Refuseless();
  private scan: { key: string; at: number; job: Promise<Scanned[]> } | null = null;
  /** Chats and keys a Featherless notice was said for (kv NOTICES_KEY), loaded when first needed. */
  private notices: Record<string, number> | null = null;
  /** Chat members looked at for a notice lately, and when: a member's status changes many times a reply. */
  private readonly looked = new Map<string, number>();

  constructor(private readonly app: App) {
    // Featherless's terms where an agent starts running on it: a member put in a chat, or moved to another account.
    app.bus.on((e) => {
      if (e.t === "member") this.featherlessChat(e.member);
      // An account changed (its address or key, say): its chats are looked at again.
      else if (e.t === "account" || e.t === "account.deleted") this.looked.clear();
    });
  }

  /**
   * Checks a service with free requests only: its model list (with the saved key when `accountId` is given), then each
   * of the three addresses an agent could use, POSTed an empty `{}` (a server that has the address turns it down).
   */
  async test(req: ServiceTestRequest): Promise<ServiceTestResult> {
    const provider = req.provider === "codex" || req.provider === "claude" ? req.provider : undefined;
    const account = this.savedAccount(req.accountId, provider);
    const baseUrl = endpointAddress(String(req.baseUrl ?? "").trim() || account?.baseUrl || "");
    const typed = cleanKey(req.apiKey);
    // The saved key (and chat path) belong to the account's own server: an address somewhere else gets neither.
    const own = account && new URL(account.baseUrl).origin === new URL(baseUrl).origin ? account : null;
    const key = typed || own?.key || "";
    const chatPath = cleanChatPath(req.chatPath) ?? own?.chatPath ?? CHAT_PATH;
    // A catalogue service's list is every model on Hugging Face: reading it would be 7 MB, so the check only asks how
    // big it is and the model is found by name afterwards (featherless.ts, GET /api/services/catalog). NanoGPT's list is
    // several hundred models with a price each: too many to tick through, so it is searched the same way (nanogpt.ts).
    const nano = this.nanogpt.serves(baseUrl);
    const refuseless = this.refuseless.serves(baseUrl);
    const big = nano || this.catalog.serves(baseUrl);
    // Which plan a Featherless key is on: one free read with it, beside the probes. It decides what the sheet says about
    // agents (the Chat plan's terms don't allow them) and how much of a chat a model is saved with. A read that fails
    // leaves the check as it is: the plan is something to say, not something the service needs.
    const planJob: Promise<ServicePlan | null> = !nano && big && key ? this.catalog.planOf(key, true).catch(() => null) : Promise.resolve(null);
    const [list, answers] = await Promise.all([
      big ? this.catalogProbe(nano) : readServer(baseUrl, key, { listPath: listPathFor(chatPath), timeoutMs: this.timeoutMs }).then((found) => ({ found, total: null, error: null })),
      probeRoutes(baseUrl, key, chatPath, this.timeoutMs),
    ]);
    const found = list.found;
    const all: { status: number }[] = [found, ...Object.values(answers)];
    const reachable = all.some((a) => a.status > 0);
    let authOk = !reachable ? null : all.some((a) => a.status === 401 || a.status === 403) ? false : found.listed ? true : null;
    const protocols = protocolsOf(answers);
    // OpenCode and Crosstalk's own agent talk to a Refuseless or NanoGPT service themselves, on its Chat Completions address
    // (agents/opencode.ts, agents/builtin.ts): no Claude Code or Codex involved, and none of their refusal rules. Offered
    // first for those two, each in the order its preset prefers, and only where that address answered.
    const direct: ServiceAgent[] = protocols.chat !== "yes" ? [] : refuseless ? ["opencode", "builtin"] : nano ? ["builtin", "opencode"] : [];
    const works = [...direct.map((p) => ({ provider: p, via: "chat" as const })), ...worksOf(protocols)];
    // Sent whenever the service is a catalogue, even when its list couldn't be read this time (`total` 0): the app shows
    // the search box with its own Try again, rather than asking a person to type a name out of 22,406 by hand.
    const catalog = big ? { name: nano ? ("nanogpt" as const) : ("featherless" as const), total: list.total ?? 0 } : null;
    let problems = this.problems({ baseUrl, key, chatPath, provider, found, answers, reachable, authOk, works, big, listError: list.error });
    // What the key has to spend (NanoGPT): two free reads with the key, only once the addresses didn't refuse it. A read
    // that fails leaves the check as it is: the balance is something to show, not something the service needs.
    let funds = nano && key && authOk !== false ? await this.nanoFunds(key) : null;
    // Refuseless's credit: one free read with the key. Refuseless itself refuses a key with a 401; a 403 to every probe
    // is Cloudflare's browser check answering in its place, which this read tells apart — then it's the check that is
    // said, not the key. What the probes did prove (a 401, a list read with the key) stands whatever this read meets.
    if (refuseless && key && reachable) {
      this.refuseless.timeoutMs = this.timeoutMs;
      const walled = authOk === false && !all.some((a) => a.status === 401);
      try {
        funds = await this.refuseless.fundsOf(key, true);
        if (walled) {
          authOk = true;
          problems = ["Your key works (it read your balance), but Refuseless's Cloudflare check answered Crosstalk's other test requests instead of its API. Press Test again in a few minutes; if it keeps happening, tell Refuseless's support."];
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (walled && /Cloudflare/.test(msg)) {
          authOk = null;
          problems = [msg];
        }
      }
    }
    const plan = authOk !== false ? await planJob : null;
    return {
      reachable,
      authOk,
      server: found.kind ? SERVER_NAMES[found.kind] : null,
      protocols,
      // `tools` only where the service said something: a server that says nothing is never read as a no. Refuseless's
      // models come in its lineup's order, each with its name, price and whether it is uncensored (refuseless.ts).
      models: (refuseless ? refuselessOrder(found.models) : found.models).map(({ id, contextWindow, tools, uncensored }) => ({
        id,
        contextWindow,
        ...(tools === null ? {} : { tools }),
        ...(refuseless ? refuselessFacts(id, uncensored) : uncensored === undefined ? {} : { uncensored }),
      })),
      works,
      problems,
      ...(catalog ? { catalog } : {}),
      ...(funds ? { funds } : {}),
      ...(plan ? { plan } : {}),
    };
  }

  /** NanoGPT's balance and subscription for a key, or null when they couldn't be read (the check goes on without them). */
  private async nanoFunds(key: string) {
    this.nanogpt.timeoutMs = this.timeoutMs;
    try {
      return await this.nanogpt.fundsOf(key, true);
    } catch {
      return null;
    }
  }

  /**
   * The model-list part of a check for a catalogue service: how many models it has, without sending them anywhere —
   * one bounded page of Featherless's list, or NanoGPT's whole list, which the hub keeps for searching. No key is needed
   * for either (both lists are public), so what a key does or doesn't do is still decided by the three address probes,
   * exactly as for any other service.
   */
  private async catalogProbe(nano = false): Promise<{ found: Found; total: number | null; error: string | null }> {
    const empty: Found = { status: 200, failed: null, listed: true, kind: null, models: [], memoryBytes: null };
    this.catalog.timeoutMs = this.timeoutMs;
    this.nanogpt.timeoutMs = this.timeoutMs;
    try {
      return { found: empty, total: await (nano ? this.nanogpt.total() : this.catalog.total()), error: null };
    } catch (e) {
      return { found: { ...empty, status: 0, failed: "network", listed: false }, total: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Each problem in plain words, with what to do about it. */
  private problems(c: { baseUrl: string; key: string; chatPath: string; provider?: ChatProvider; found: Found; answers: Record<Protocol, Answer>; reachable: boolean; authOk: boolean | null; works: ServiceTestResult["works"]; big?: boolean; listError?: string | null }): string[] {
    const host = new URL(c.baseUrl).host;
    const out: string[] = [];
    if (!c.reachable) {
      const slow = [c.found, ...Object.values(c.answers)].some((a) => a.failed === "timeout");
      out.push(slow ? `${host} didn't answer within ${this.timeoutMs / 1000} seconds. Check the address, and that the server is running.` : `Nothing answered at ${c.baseUrl}. Check the address, and that the server is running.`);
      return out;
    }
    if (c.authOk === false) {
      out.push(c.key ? `This key was refused. Check that you copied all of it, and that it is for ${host}.` : "This server wants an API key. Paste one in the key field.");
      return out;
    }
    // A catalogue service lists far too many models to show: none of them being here is how it should be, and the only
    // thing that can go wrong is that the list itself couldn't be read.
    if (c.big) {
      if (c.listError) out.push(`${c.listError} Crosstalk needs its model list to find a model for you.`);
    } else if (!c.found.listed) out.push("This server doesn't list its models. Type the names of the ones you want to use.");
    else if (!c.found.models.length) out.push("This server lists no models yet. Load or pull one on the server, then test again.");
    // An agent needs tool calls to read a file or run a command. A service that says none of its models can do that can
    // still be added (you may want it for an Ask), but it's said plainly here rather than found out in a chat.
    else if (c.found.models.every((m) => m.tools === false)) out.push("None of these models can run tools, so an agent can't read files or run commands on them. Add it for questions, or pick another service for work.");
    if (!c.works.length) {
      const paths = routePaths(c.chatPath);
      const odd = (Object.keys(paths) as Protocol[]).find((p) => supportOf(c.answers[p].status) === "unknown");
      out.push(
        odd
          ? `This server answered oddly at ${paths[odd]} (${c.answers[odd].status ? `status ${c.answers[odd].status}` : "no answer"}), so Crosstalk can't tell what it supports. Try again, and look at the server's log if it keeps happening.`
          : `None of ${Object.values(paths).join(", ")} answered here, so neither Codex nor Claude Code can use this address. Check the address.`,
      );
    } else if (c.provider && !c.works.some((w) => w.provider === c.provider)) {
      const other = PROVIDER_INFO[c.works[0].provider].name;
      out.push(`${PROVIDER_INFO[c.provider].name} can't use this server, but ${other} can. Add it under ${other} instead.`);
    }
    return out;
  }

  /**
   * The AI service a New chat runs on: one already added (`account`), or a server on this machine added here and now
   * (`baseUrl`), checked and saved exactly as Settings → AI services would have saved it — the same free check, the same
   * agent, models, lane and name — so a chat started from the New chat menu is no different from one started after a
   * visit to Settings. A check that found nothing usable throws the check's own plain words, each with its fix.
   */
  async accountForChat(input: { account?: unknown; provider?: unknown; baseUrl?: unknown; label?: unknown; apiKey?: unknown; model?: unknown }): Promise<{ account: AgentAccount; added: boolean }> {
    const asked = SERVICE_AGENTS.find((p) => p === input.provider);
    const id = typeof input.account === "string" ? input.account.trim() : "";
    if (id) {
      for (const p of asked ? [asked] : (["codex", "claude", "builtin", "opencode"] as const)) if (this.app.providers.endpointOf(p, id)) return { account: this.app.providers.account(p, id), added: false };
      throw new HttpError(404, "That AI service isn't on this machine any more. Add it again in Settings → AI services.");
    }
    const baseUrl = endpointAddress(String(input.baseUrl ?? "").trim());
    // An account already pointing at this server is used as it stands: adding a second one for the same address would
    // only be refused for its name, and the chat the person asked for wouldn't start.
    const using = this.accountsUsing(baseUrl)[0];
    if (using) return { account: this.app.providers.account(using.provider, using.id), added: false };
    const key = cleanKey(input.apiKey);
    const result = await this.test({ baseUrl, ...(key ? { apiKey: key } : {}) });
    const agent = serviceAgentFor(result.works, asked ?? "codex", asked, { claude: this.app.providers.get("claude").installed, codex: this.app.providers.get("codex").installed, builtin: true, opencode: this.app.providers.get("opencode").installed });
    // The check's problems say what to do about each one (services.ts problems()): they are the answer.
    if (!agent) throw new HttpError(400, result.problems.join(" ") || `Nothing usable answered at ${baseUrl}. Check the address, and that the server is running.`);
    const wanted = typeof input.model === "string" ? input.model.trim() : "";
    // The same list the sheet offers to tick (no blanks, no names with spaces, each one once), so the account a one-tap
    // add saves holds the models Settings → AI services would have saved.
    const kept = serviceModelsKept(result.models);
    const picked = serviceModelPick(kept);
    // A list too long for the sheet's own pick (nobody is here to tick 20 of 25) keeps the first 20 that can run tools,
    // so the chat's model menu still has the service's models in it; one whose every model says it can't run tools
    // starts a chat all the same, on the model asked for, else the first the server listed.
    const many = kept.filter((m) => m.tools !== false).slice(0, SERVICE_MAX_MODELS).map((m) => m.id);
    const models = picked.length ? picked : many.length ? many : [wanted && kept.some((m) => m.id === wanted) ? wanted : (kept[0]?.id ?? "")].filter(Boolean);
    // One asked for that the pick left out is kept as well.
    if (wanted && !models.includes(wanted) && kept.some((m) => m.id === wanted) && models.length < SERVICE_MAX_MODELS) models.push(wanted);
    // A catalogue service has thousands of models and no sensible default among them: it is added in Settings, where
    // you search for the one you want.
    if (!models.length) throw new HttpError(400, this.catalog.serves(baseUrl) || this.nanogpt.serves(baseUrl) ? `Add ${this.nanogpt.serves(baseUrl) ? "NanoGPT" : "Featherless"} in Settings → AI services, where you can search its models, then start a chat on it.` : `${new URL(baseUrl).host} lists no models yet. Load or pull one on the server, then try again.`);
    const contexts: Record<string, number> = {};
    for (const m of result.models) if (models.includes(m.id) && m.contextWindow) contexts[m.id] = m.contextWindow;
    const via = result.works.find((w) => w.provider === agent)?.via;
    // The lane the check found, except that a server added this way goes through Crosstalk's own translator wherever it
    // has the chat address, even when its Responses one answered: these servers' Responses support is newer than their
    // Chat Completions one, and a model's chat template can refuse what an agent sends there (llama.cpp with a Qwen
    // template: "System message must be at the beginning"), while the translator lays the messages out itself. This is
    // the New chat menu's one-tap add of a server answering on this machine, which in Settings → AI services is the "A
    // server on this machine" preset — and that pins the same lane whatever the address says (web/src/presets.ts,
    // protocolFor), so the two ways agree for every address rather than only for a loopback one.
    const translated = agent === "codex" && result.protocols.chat === "yes";
    const protocol: Protocol | undefined = translated || via === "adapter" ? "chat" : via;
    // The name Settings would have given it: the one the app sent (the found server's own), else what this machine calls
    // the server there, else the hub's fallback (its first model's name).
    const label = String(input.label ?? "").trim() || (await this.localServers()).servers.find((s) => s.baseUrl === baseUrl)?.label || "";
    const account = this.app.providers.setEndpointAccount(agent, {
      label,
      baseUrl,
      apiKey: key,
      models,
      contextWindow: contexts[models[0]] ?? null,
      ...(protocol ? { protocol } : {}),
      ...(Object.keys(contexts).length ? { contexts } : {}),
    });
    return { account, added: true };
  }

  /** The endpoint account `id` names (under `provider`, or either agent), with its saved key; null when none is named. */
  private savedAccount(id: unknown, provider?: ServiceAgent) {
    if (id === undefined || id === null || id === "") return null;
    for (const p of provider ? [provider] : (["codex", "claude", "builtin", "opencode"] as const)) {
      const ep = this.app.providers.endpointOf(p, String(id));
      if (ep) return ep;
    }
    throw new HttpError(404, "No such custom model");
  }

  /**
   * What an endpoint account's server lists now, each with its context where it says: for the account's model list.
   * Null when the server answers but has no model list (the saved names stand); throws, in plain words, when it can't be asked.
   */
  async endpointModels(ep: { baseUrl: string; key: string; chatPath?: string; models?: string[]; contextWindow?: number | null; contexts?: Record<string, number> }): Promise<(ListedModel & { about?: string })[] | null> {
    if (this.nanogpt.serves(ep.baseUrl)) return this.nanoModels(ep);
    if (this.catalog.serves(ep.baseUrl)) return this.catalogModels(ep, this.catalog.capFor(ep.key));
    const found = await readServer(ep.baseUrl, ep.key, { listPath: listPathFor(ep.chatPath ?? CHAT_PATH), timeoutMs: this.timeoutMs });
    if (this.refuseless.serves(ep.baseUrl)) {
      // Its models say their price and whether they are uncensored in every model menu, as NanoGPT's do.
      if (found.listed) return refuselessOrder(found.models).map((m) => ({ ...m, ...(refuselessAbout(m.id, m.uncensored) ? { about: refuselessAbout(m.id, m.uncensored) } : {}) }));
      // Refuseless refuses a key with a 401: a 403 is Cloudflare's browser check in front of it, not the key.
      if (found.status === 403) throw new Error(challengeWords("Refuseless"));
    }
    if (found.listed) return found.models;
    if (found.status === 401 || found.status === 403) throw new Error("The server refused the key. Check it in this account's settings.");
    if (found.status === 0) throw new Error(found.failed === "timeout" ? `${new URL(ep.baseUrl).host} didn't answer in time. Is it running?` : `Nothing answered at ${ep.baseUrl}. Is the server running?`);
    if (found.status >= 500) throw new Error(`The server had a problem (error ${found.status}). Try again in a minute.`);
    return null;
  }

  /**
   * A catalogue account's model list: the models it was saved with, asked for by name, so the account's menu says what
   * each one holds and which of them an agent can work with — without reading a 22,000-model list. A model's context is
   * its own, but never more than this account may read at once (`cap`, its key's plan's: Featherless.capFor): a chat
   * told it has more would overflow.
   */
  private async catalogModels(ep: { models?: string[]; contextWindow?: number | null; contexts?: Record<string, number> }, cap: number | null): Promise<ListedModel[] | null> {
    const saved = ep.models ?? [];
    if (!saved.length) return null;
    this.catalog.timeoutMs = this.timeoutMs;
    const rows = await this.catalog.models(saved);
    return rows.map((r) => {
      // What this account may read: the size saved for this model, else the account's own, else what its plan serves at
      // once (the Chat plan's 32K while the plan isn't known). That last one has to be applied here as well as in the Add
      // sheet (web/src/services.ts capContext), because a model named in Settings → Accounts, or added to an account's
      // list later, never went through the sheet and has no saved size at all — and a model that can hold 256K would
      // otherwise be handed to a chat on a 32K plan as 256K.
      const limit = ep.contexts?.[r.id] ?? ep.contextWindow ?? cap;
      return { id: r.id, contextWindow: limit === null ? r.contextWindow : Math.min(r.contextWindow ?? limit, limit), sizeBytes: null, loaded: true, tools: r.tools };
    });
  }

  /**
   * A NanoGPT account's model list: the models it was saved with, as NanoGPT's own list has them now, each with what it
   * costs and whether it is uncensored or covered by the subscription — said under the model in every picker.
   */
  private async nanoModels(ep: { models?: string[]; contextWindow?: number | null; contexts?: Record<string, number> }): Promise<(ListedModel & { about?: string })[] | null> {
    const saved = ep.models ?? [];
    if (!saved.length) return null;
    this.nanogpt.timeoutMs = this.timeoutMs;
    const rows = await this.nanogpt.saved(saved);
    return rows.map((r) => {
      const about = [priceWords(r.price), r.inPlan ? "in NanoGPT's subscription" : null, r.uncensored ? "uncensored" : null].filter(Boolean).join(" · ");
      return { id: r.id, contextWindow: r.contextWindow ?? ep.contexts?.[r.id] ?? ep.contextWindow ?? null, sizeBytes: null, loaded: true, tools: r.tools, ...(about ? { about } : {}) };
    });
  }

  /**
   * What a NanoGPT or Refuseless account has to spend (Settings → AI services shows it on the account's row): NanoGPT's
   * balance and subscription, Refuseless's credit, read with the saved key. Null for an account on any other service;
   * throws, in plain words, when the service can't be asked or refuses the key.
   */
  async funds(provider: ServiceAgent, accountId: string, fresh = false) {
    const ep = this.app.providers.endpointOf(provider, accountId);
    if (!ep) return null;
    if (this.refuseless.serves(ep.baseUrl)) {
      this.refuseless.timeoutMs = this.timeoutMs;
      return this.refuseless.fundsOf(ep.key, fresh);
    }
    if (!this.nanogpt.serves(ep.baseUrl)) return null;
    this.nanogpt.timeoutMs = this.timeoutMs;
    return this.nanogpt.fundsOf(ep.key, fresh);
  }

  /**
   * Which Featherless plan an account's key is on (Settings → AI services says it on the account's row): one free read
   * with its saved key, kept ten minutes. Undefined when the account isn't on Featherless; null when the service didn't
   * say; throws, in plain words, when it couldn't be asked or turned the key down.
   */
  async plan(provider: ServiceAgent, accountId: string, fresh = false): Promise<ServicePlan | null | undefined> {
    const ep = this.app.providers.endpointOf(provider, accountId);
    if (!ep || !this.onFeatherless(ep.baseUrl)) return undefined;
    this.catalog.timeoutMs = this.timeoutMs;
    return this.catalog.planOf(ep.key, fresh);
  }

  /**
   * Whether replies on this account cost nothing of their own (the ledger keeps them as the plan's, and no limit counts
   * them): only a Featherless key last read as on its flat Chat plan (featherless.ts flatRate). The key is read only for
   * an account on Featherless's address.
   */
  flatRate(provider: Provider, account: string, baseUrl: string | null | undefined): boolean {
    if (!this.onFeatherless(baseUrl)) return false;
    return this.catalog.flatRate(baseUrl, this.app.providers.endpointOf(provider, account)?.key);
  }

  /**
   * Whether an account's address is Featherless's. NanoGPT's comes first, as everywhere here: the test hubs point both
   * services at one closed port, and a NanoGPT account must never be told about Featherless's plans.
   */
  private onFeatherless(baseUrl: string | null | undefined): boolean {
    return this.catalog.serves(baseUrl) && !this.nanogpt.serves(baseUrl);
  }

  /**
   * Featherless's terms said in the chat an agent runs it in (featherless.ts chatNotice), as a note from Crosstalk: on a
   * key the hub read as on the Chat plan, once in each chat — its terms don't allow agents, and that matters every time
   * one starts; on a key whose plan it couldn't tell, once, in the first chat on that key; on the Developer plan, never.
   * Called for every member event, so it does nothing more than a lookup until a member is on Featherless.
   */
  private featherlessChat(m: Member): void {
    const account = memberAccount(m);
    if (account === DEFAULT_ACCOUNT) return;
    const where = `chat:${m.roomId}|${m.provider}|${account}`;
    const at = this.looked.get(where);
    if (at !== undefined && Date.now() - at < PLAN_TTL_MS) return;
    this.looked.set(where, Date.now());
    while (this.looked.size > MAX_NOTICES) this.looked.delete(this.looked.keys().next().value as string);
    if (this.said()[where]) return;
    const ep = this.app.providers.endpointOf(m.provider, account);
    if (!ep?.key || !this.onFeatherless(ep.baseUrl)) return;
    const once = `key:${keyRef(ep.key)}`;
    const say = (plan: ServicePlan | null) => {
      const text = chatNotice(plan);
      // Said after whatever made the member (a duplicated chat's copied messages, say) has put its own messages in.
      if (text) queueMicrotask(() => this.sayNotice(m.roomId, where, plan?.kind === "chat" ? null : once, text));
    };
    const known = this.catalog.lastPlan(ep.key);
    if (known && Date.now() - known.checkedAt < PLAN_TTL_MS) return say(known);
    this.catalog.timeoutMs = this.timeoutMs;
    this.catalog.planOf(ep.key).then(say, (e) => {
      // A key Featherless turns down can't run a chat at all: the reply says so, and there's no plan to talk about.
      if (!(e instanceof KeyRefused)) say(known);
    });
  }

  /**
   * Puts a Featherless notice in a chat, unless it has had it (or, for a plan that isn't known, `once` says its key's
   * first chat did): the Chat plan is said in every chat on that key, a plan that isn't known only in the first.
   */
  private sayNotice(roomId: string, where: string, once: string | null, text: string) {
    try {
      if (this.said()[where] || (once && this.said()[once]) || !this.app.store.getRoom(roomId)) return;
      this.note(where, once);
      this.app.engine.systemMessage(roomId, text);
    } catch {
      // The hub is shutting down under it (its database closed): the chat gets its note when it next runs.
    }
  }

  private said(): Record<string, number> {
    if (!this.notices) {
      try {
        const kept = JSON.parse(this.app.store.kvGet(NOTICES_KEY) ?? "{}");
        this.notices = kept && typeof kept === "object" ? (kept as Record<string, number>) : {};
      } catch {
        this.notices = {};
      }
    }
    return this.notices;
  }

  /** Keeps that a chat (and, for a plan that isn't known, its key) has had its notice. */
  private note(where: string, once: string | null) {
    const all = this.said();
    const now = Date.now();
    all[where] = now;
    if (once) all[once] = now;
    const kept = Object.entries(all).sort((a, b) => a[1] - b[1]).slice(-MAX_NOTICES);
    this.notices = Object.fromEntries(kept);
    try {
      this.app.store.kvSet(NOTICES_KEY, JSON.stringify(this.notices));
    } catch {
      // The database closed under it (a hub shutting down): the note is said, and may be said again after a restart.
    }
  }

  /** Asks an endpoint account's server for its models again (a failure says why); null when there's no such account. */
  async refreshModels(provider: ServiceAgent, accountId: string): Promise<AgentAccount | null> {
    if (!this.app.providers.endpointOf(provider, accountId)) return null;
    const catalog = await this.app.providers.models(provider, accountId, { fresh: true });
    if (catalog.error) throw new HttpError(502, catalog.error);
    return this.app.providers.account(provider, accountId);
  }

  /** Model servers answering on this machine (127.0.0.1 only), looked for in parallel and remembered for 10 seconds. */
  async localServers(opts: ScanOptions = {}): Promise<{ servers: LocalServer[]; scannedAt: number }> {
    const o = { ...this.scanOptions, ...opts };
    const ports = { ...(o.ports ?? portsFromEnv() ?? SCAN_PORTS), ...this.extraPorts() };
    const key = JSON.stringify([o.host, ports, o.timeoutMs]);
    if (!this.scan || this.scan.key !== key || o.fresh || Date.now() - this.scan.at >= SCAN_CACHE_MS) {
      const host = o.host ?? "127.0.0.1";
      const job = Promise.all(Object.entries(ports).map(([port, hint]) => this.scanPort(host, Number(port), hint, o.timeoutMs ?? SCAN_TIMEOUT_MS))).then((all) => all.filter((s): s is Scanned => !!s));
      this.scan = { key, at: Date.now(), job };
    }
    const scan = this.scan;
    // Which accounts use a server is worked out each time: an account added a moment ago counts.
    return { servers: (await scan.job).map((s) => ({ ...s, accountIds: this.accountsUsing(s.baseUrl) })), scannedAt: scan.at };
  }

  /** One port: a model server only if it answers the OpenAI-style model list (a locked one isn't shown: it can't be listed). */
  private async scanPort(host: string, port: number, hint: ServerKind, timeoutMs: number): Promise<Scanned | null> {
    const base = `http://${host}:${port}`;
    const found = await readServer(base, "", { timeoutMs });
    if (!found.listed) return null;
    const kind = found.kind ?? hint;
    const protocols = protocolsOf(await probeRoutes(base, "", CHAT_PATH, timeoutMs));
    return { id: `${kind}-${port}`, kind, label: `${SERVER_NAMES[kind]} (port ${port})`, baseUrl: base, models: found.models, memoryBytes: found.memoryBytes, protocols };
  }

  /** The endpoint accounts that point at this server (this machine's own names for it count the same). */
  private accountsUsing(baseUrl: string): LocalServer["accountIds"] {
    const here = new URL(baseUrl);
    const loopback = ["127.0.0.1", "localhost", "[::1]"];
    return this.app.providers.accounts().flatMap((a) => {
      if (!a.endpoint || (a.provider !== "codex" && a.provider !== "claude")) return [];
      let u: URL;
      try {
        u = new URL(a.endpoint.baseUrl);
      } catch {
        return [];
      }
      const sameHost = u.hostname === here.hostname || (loopback.includes(u.hostname) && loopback.includes(here.hostname));
      return sameHost && u.port === here.port && u.pathname.replace(/\/+$/, "") === "" ? [{ provider: a.provider, id: a.id }] : [];
    });
  }
}

export function serviceRoutes(app: App): Route[] {
  return [
    route("POST", "/api/services/test", async ({ body }) => app.services.test(await body())),
    /**
     * Starts a chat on an AI service in one go: an account already added, or a server on this machine that isn't (the
     * New chat menu lists both, and uses this for the ones that aren't added yet). The rest of the body is a new chat's,
     * as POST /api/chats takes it. `added` says whether an account was made.
     */
    route("POST", "/api/chats/service", async ({ body }) => {
      const b = (await body()) as Record<string, unknown>;
      const { account, added } = await app.services.accountForChat(b);
      const asked = typeof b.model === "string" ? b.model.trim() : "";
      // The model goes on the chat even when none was asked for, so the chat says which of the service's models it runs.
      const model = asked || account.endpoint?.models[0] || null;
      const room = app.chats.create({ ...b, provider: account.provider, account: account.id, model });
      return { room, account, added };
    }),
    /**
     * Finds a model in a service whose list is too big to show (Featherless serves every model on Hugging Face). `q` is
     * part of a name; without one the service's own uncensored models come back. The answer is at most CATALOG_SHOWN
     * trimmed rows, so what reaches a phone is a few kilobytes however many models matched.
     */
    route("GET", "/api/services/catalog", async ({ url }): Promise<CatalogSearch> => {
      const name = url.searchParams.get("name") ?? "featherless";
      if (name !== "featherless" && name !== "nanogpt") throw new HttpError(400, "Crosstalk can only search Featherless's and NanoGPT's models.");
      try {
        // NanoGPT's search looks in one part of its list: `filter` is uncensored, plan (its subscription's models) or all.
        if (name === "nanogpt") return await app.services.nanogpt.search(url.searchParams.get("q"), url.searchParams.get("filter"));
        return await app.services.catalog.search(url.searchParams.get("q"));
      } catch (e) {
        // The service's own words, with what to do about it: the sheet shows them under the search box.
        throw new HttpError(502, e instanceof Error ? e.message : String(e));
      }
    }),
    route("GET", "/api/local-servers", ({ url }) => app.services.localServers({ fresh: url.searchParams.get("fresh") === "1" })),
    /**
     * What a NanoGPT or Refuseless account has to spend: NanoGPT's balance and subscription allowance, Refuseless's
     * credit, read with its saved key (free, no model runs). `fresh=1` reads again rather than answering from the last
     * five minutes. 404 for any other account.
     */
    route("GET", "/api/accounts/:p/:id/funds", async ({ params, url }) => {
      if (!isServiceAgent(params.p)) throw new HttpError(400, "Only Codex, Claude Code, OpenCode and Crosstalk's agent have AI service accounts.");
      let funds;
      try {
        funds = await app.services.funds(params.p, params.id, url.searchParams.get("fresh") === "1");
      } catch (e) {
        throw new HttpError(502, e instanceof Error ? e.message : String(e));
      }
      if (!funds) throw new HttpError(404, "That account's service doesn't say what it has to spend.");
      return funds;
    }),
    /** Runs a service on the other agent that runs only on services, keeping its key (Settings → AI services). */
    route("POST", "/api/accounts/:p/:id/agent", async ({ params, body }) => {
      if (!isServiceAgent(params.p)) throw new HttpError(400, "Only a service's own agent can hand it over.");
      const b = await body().catch(() => ({}));
      return app.providers.switchServiceAgent(params.p, params.id, b.to);
    }),
    /**
     * Which plan a Featherless account's key is on, read with its saved key (free, nothing runs): `{ plan }`, null when the
     * service didn't say. `fresh=1` reads again rather than answering from the last ten minutes. 404 for any other account.
     */
    route("GET", "/api/accounts/:p/:id/plan", async ({ params, url }) => {
      if (!isServiceAgent(params.p)) throw new HttpError(400, "Only Codex, Claude Code, OpenCode and Crosstalk's agent can use Featherless.");
      let plan;
      try {
        plan = await app.services.plan(params.p, params.id, url.searchParams.get("fresh") === "1");
      } catch (e) {
        throw new HttpError(502, e instanceof Error ? e.message : String(e));
      }
      if (plan === undefined) throw new HttpError(404, "That account isn't on Featherless.");
      return { plan };
    }),
    route("POST", "/api/accounts/:p/:id/refresh-models", async ({ params }) => {
      if (!isServiceAgent(params.p)) throw new HttpError(400, "Only Codex, Claude Code, OpenCode and Crosstalk's agent can use a model server of their own.");
      const account = await app.services.refreshModels(params.p, params.id);
      if (!account) throw new HttpError(404, "No such custom model");
      return account;
    }),
  ];
}
