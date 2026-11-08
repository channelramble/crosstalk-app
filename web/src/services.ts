// What Settings → AI services shows and sends, as plain functions (the screens in views/AiServices.tsx and
// views/AddServiceSheet.tsx only draw it): reading a service check, choosing the agent and models, the body that saves
// the account, and the words under each row.
import { CHAT_PROVIDERS, OPENCODE_VERSION, PROVIDER_INFO, SERVICE_AGENTS, SERVICE_MAX_MODELS, isServiceAgent, isServiceOnlyAgent, serviceAgentFor, serviceModelPick, serviceModelsKept, type AccountSpend, type AgentAccount, type Allowance, type ServiceAgent, type CatalogFilter, type CatalogModel, type CatalogName, type CatalogSearch, type ChatProvider, type LocalServer, type ModelCatalog, type Protocol, type Provider, type ProviderStatus, type ServiceFunds, type ServiceOnlyAgent, type ServiceTestResult, type TokenPrice } from "@crosstalk/shared";
import { costLabel } from "./money";
import type { ServicePreset } from "./presets";

/** The most models one service keeps (the hub keeps the first 20). */
export const MAX_MODELS = SERVICE_MAX_MODELS;

/** One line of a check: ✓ when it's good, ✗ when it isn't. */
export interface Line {
  ok: boolean;
  text: string;
  /** It runs through the hub's chat adapter, which has its own "?". */
  adapter?: boolean;
}
export type Tone = "ok" | "warn" | "bad" | "idle";
/** What a check came to: its lines, the problems (each with its fix), and the dot and word for the row. */
export interface Outcome {
  lines: Line[];
  problems: string[];
  tone: Tone;
  text: string;
}

const agentName = (p: ServiceAgent) => PROVIDER_INFO[p].name;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A sentence without its closing dot, so another can follow it ("Couldn't …: <reason>. Press Test to try again."). */
export const noDot = (text: string): string => text.replace(/[.\s]+$/, "");

/** The ✓ and ✗ rows of a service check ("Reachable", "Key works", "12 models found", "Works with Codex"). */
export function testLines(r: ServiceTestResult, preset?: ServicePreset | null): Line[] {
  const lines: Line[] = [{ ok: r.reachable, text: r.reachable ? "Reachable" : "Can't reach it" }];
  // Nothing else could be asked of a service that didn't answer: its problems say why.
  if (!r.reachable) return lines;
  if (r.authOk !== null) lines.push({ ok: r.authOk, text: r.authOk ? "Key works" : "Key refused" });
  // A refused key proves nothing about the service: what it lists and what can run on it were never learned, and the
  // fix is the key (the problem line says so), not the service.
  if (r.authOk === false) return lines;
  // A service whose list is a whole catalogue has no model count to tick off: it says how many there are to search. A 0
  // means the list itself couldn't be read this time — the search box below says so too, and has its own Try again.
  if (r.catalog) lines.push(r.catalog.total ? { ok: true, text: `${r.catalog.total.toLocaleString("en-US")} models to search` } : { ok: false, text: "Couldn't read its model list" });
  else {
    // The count is the models that can be picked below, not every name the service sent: a name with a space in it, a
    // repeat or one over 200 characters is dropped (serviceModelsKept), and a tick must never say models were found
    // over a box that says none were listed.
    const kept = modelChoices(r).length;
    const skipped = r.models.length - kept;
    const also = skipped > 0 ? `, ${plural(skipped, "name", "names")} skipped` : "";
    if (kept) lines.push({ ok: true, text: `${plural(kept, "model", "models")} found${also}` });
    else lines.push({ ok: false, text: r.models.length ? "None of its model names can be used" : "No models listed" });
  }
  // The adapter note says what the account will actually be saved as, which a preset can pin (Venice).
  // Only Codex goes through the hub's chat adapter: Crosstalk's own agent and OpenCode speak Chat Completions themselves.
  for (const w of r.works) lines.push({ ok: true, text: `Works with ${agentName(w.provider)}`, adapter: w.provider === "codex" && protocolFor(r, w.provider, preset) === "chat" });
  if (!r.works.length) lines.push({ ok: false, text: "Not usable with Claude Code or Codex yet" });
  // What the key has to spend (NanoGPT), read with it once it was accepted: a balance of nothing is said as a ✗, because
  // every reply on a model the subscription doesn't cover would be refused.
  if (r.funds) lines.push(...fundsLines(r.funds));
  return lines;
}

// ---- what an account has to spend (NanoGPT): its balance and its subscription's allowance ----

/** Whether an account or address is on NanoGPT, whose balance and subscription Settings shows. */
export function isNanoGpt(baseUrl: string | null | undefined): boolean {
  try {
    return /(^|\.)nano-gpt\.com$/i.test(new URL(String(baseUrl ?? "")).hostname);
  } catch {
    return false;
  }
}

/** Whether an account or address is on Refuseless, whose credit Settings shows. */
export function isRefuseless(baseUrl: string | null | undefined): boolean {
  try {
    return new URL(String(baseUrl ?? "")).hostname.toLowerCase() === "api.refuseless.com";
  } catch {
    return false;
  }
}

/** Whether Settings shows what an account has to spend: NanoGPT's balance and subscription, Refuseless's credit. */
export const showsFunds = (baseUrl: string | null | undefined): boolean => isNanoGpt(baseUrl) || isRefuseless(baseUrl);

/** Dollars as a balance is said: "$5.00", and a tiny amount without rounding it to nothing ("$0.004"). */
export function usd(n: number): string {
  return n > 0 && n < 0.01 ? `$${Number(n.toPrecision(1))}` : `$${n.toFixed(2)}`;
}

/** A count of tokens, short: 950, 12k, 2.5M, 60M. */
export function tokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  return `${m < 10 ? +m.toFixed(1) : Math.round(m)}M`;
}

/** One allowance in words: "2.5M of 60M tokens used this week"; null when the service didn't say enough. */
function allowanceWords(a: Allowance | null, span: string): string | null {
  if (!a || a.used === null || !a.limit) return null;
  return `${tokenCount(a.used)} of ${tokenCount(a.limit)} tokens used ${span}`;
}

/**
 * The lines of what an account has to spend, as a check shows them: its balance, and its subscription when it has one —
 * how much of the week's allowance is used, or that covered models are being billed to the balance because it's gone.
 */
export function fundsLines(f: ServiceFunds): Line[] {
  const lines: Line[] = [];
  if (f.balanceUsd !== null) lines.push({ ok: !fundsEmpty(f), text: `Balance ${usd(f.balanceUsd)}` });
  // Refuseless holds each running reply's worst case until it ends, and gives back what wasn't used.
  if (f.heldUsd) lines.push({ ok: true, text: `${usd(f.heldUsd)} held by replies still running` });
  const plan = f.plan;
  if (plan?.active) {
    const used = allowanceWords(plan.weekly, "this week") ?? allowanceWords(plan.daily, "today");
    if (plan.billing === "paygo") lines.push({ ok: false, text: `Subscription allowance used up${used ? ` (${used})` : ""}: covered models spend your balance until it resets` });
    else if (plan.billing === "unavailable") lines.push({ ok: false, text: "Subscription can't be used right now" });
    else lines.push({ ok: true, text: `Subscription active${used ? `: ${used}` : ""}` });
  } else if (plan) lines.push({ ok: false, text: "Subscription not active" });
  return lines;
}

/**
 * Nothing left to spend: no balance, no subscription to fall back on, and nothing held by replies still running (whose
 * unused part comes back when they end) — every reply would be refused, so the row says where to add money.
 */
export function fundsEmpty(f: ServiceFunds): boolean {
  return f.balanceUsd !== null && f.balanceUsd <= 0 && !f.plan?.active && !f.heldUsd;
}

/** Where an account's money is added: Refuseless's console, else NanoGPT's site. */
export function fundsSite(baseUrl: string | null | undefined): { name: string; label: string; url: string } {
  return isRefuseless(baseUrl) ? { name: "Refuseless", label: "refuseless.com", url: "https://refuseless.com/console" } : { name: "NanoGPT", label: "nano-gpt.com", url: "https://nano-gpt.com" };
}

/** The same in one sentence, for an account's row in Settings → AI services. */
export function fundsWords(f: ServiceFunds): string {
  return fundsLines(f)
    .map((l) => l.text)
    .join(" · ");
}

export function serviceOutcome(r: ServiceTestResult, preset?: ServicePreset | null): Outcome {
  const refused = r.reachable && r.authOk === false;
  return {
    lines: testLines(r, preset),
    problems: r.problems,
    tone: !r.reachable || refused ? "bad" : r.works.length ? "ok" : "warn",
    text: !r.reachable ? "Can't reach it" : refused ? "Key refused" : r.works.length ? "Reachable" : "Can't be used yet",
  };
}

/** The agents that can run a checked service, in the order the check listed them. */
export function agentsFor(r: ServiceTestResult): ServiceAgent[] {
  return [...new Set(r.works.map((w) => w.provider))];
}

/**
 * The agent a service is added for: the one picked, else the preset's if it can run it, else the first that can. An agent
 * that's installed comes before one that isn't (`installed` says false for those; unknown counts as installed). Shared
 * with the hub (serviceAgentFor), so a one-tap add from the New chat menu picks the same agent as this sheet.
 */
export function chooseAgent(r: ServiceTestResult, preferred: ServiceAgent, picked?: ServiceAgent | null, installed: Partial<Record<ServiceAgent, boolean>> = {}): ServiceAgent | null {
  return serviceAgentFor(r.works, preferred, picked, installed);
}

/**
 * Under "Use it with": what the agent picked is. A service Crosstalk's own agent or OpenCode can run is run differently
 * by each, which is the whole of the choice; any other is the same service under either agent.
 */
export function agentChoiceHelp(agents: ServiceAgent[], picked: ServiceAgent): string {
  if (!agents.some(isServiceOnlyAgent)) return "Both can run it. Pick the one you want to chat with.";
  if (picked === "opencode") return "OpenCode is an open-source coding agent program that Crosstalk drives. It talks to the service directly, with no refusal rules of its own and no other agent involved.";
  if (picked === "builtin") return "Crosstalk agent talks to it directly, with tools for commands, files, a plan and BrowserOS neo, and follows your project's AGENTS.md: no other agent program involved, and nothing to install.";
  return `${PROVIDER_INFO[picked].name} can run it too, with its own instructions and tools on top.`;
}

/** The styles each agent can be given: Codex the Responses API, or Chat Completions through the hub's translator; Claude Code Messages. */
/** Crosstalk's own agent and OpenCode speak Chat Completions to the service themselves. */
const AGENT_PROTOCOLS: Record<ServiceAgent, Protocol[]> = { claude: ["messages"], codex: ["responses", "chat"], builtin: ["chat"], opencode: ["chat"] };

/**
 * What the saved account speaks for an agent: "chat" when the hub's translator is in between. A preset can pin one
 * (Venice's chat lane, where its own body fields ride and its Responses beta isn't in the way), as long as the check
 * found that address and the agent speaks it; otherwise it's whichever the check preferred.
 */
export function protocolFor(r: ServiceTestResult, agent: ServiceAgent, preset?: ServicePreset | null): Protocol | null {
  const pinned = preset?.protocol;
  if (pinned && r.protocols[pinned] === "yes" && AGENT_PROTOCOLS[agent].includes(pinned)) return pinned;
  const via = r.works.find((w) => w.provider === agent)?.via;
  return !via ? null : via === "adapter" ? "chat" : via;
}

export interface ModelChoice {
  id: string;
  contextWindow: number | null;
  /** False when the service says this model can't run tool calls; absent or null when it said nothing. */
  tools?: boolean | null;
  /** What a service Crosstalk knows more about (Refuseless) says beside it: its name, its price, and that it's uncensored. */
  name?: string;
  price?: TokenPrice;
  uncensored?: boolean;
}

/** The models a service listed that the hub will keep: names without spaces, once each (shared with the hub's one-tap add). */
export function modelChoices(r: ServiceTestResult): ModelChoice[] {
  return serviceModelsKept(r.models);
}

/** The service said this model can't run tool calls, which an agent needs: it's marked, and never picked for you. */
export const noTools = (m: ModelChoice): boolean => m.tools === false;

/** Beside a named, priced model (Refuseless): how much of a chat it reads, and its price per million tokens. */
export function choiceFacts(m: ModelChoice): string {
  return [m.contextWindow ? formatContext(m.contextWindow) : null, priceLine(m.price)].filter(Boolean).join(" · ");
}

/** Said over a list that marks its uncensored models: those are the ones picked for you, and why. */
export const UNCENSORED_PICK_WORDS = "The uncensored ones are picked for you. The others are the makers' own weights, refusals and all: tick them if you want them too.";

// ---- a service whose model list is a whole catalogue (Featherless): finding one by name ----

/**
 * The facts beside a found model's name: how big it is, how much of a chat it reads, and — for a model that counts as
 * more than one request of the plan's own at-a-time allowance — how much of that one request of it takes up
 * (featherless.ai/docs/concurrency-limits). `atOnce` is the plan's figure, from its preset.
 */
export function catalogFacts(m: CatalogModel, atOnce?: number): string {
  const parts = [m.params ? `${m.params}B` : null, m.contextWindow ? formatContext(m.contextWindow) : null];
  if (m.concurrency && m.concurrency > 1) parts.push(atOnce ? `uses ${m.concurrency} of your ${atOnce} at a time` : `counts as ${m.concurrency} requests at a time`);
  // A service that prices each model (NanoGPT) says what it costs: in and out per million tokens, and cached input when
  // that is priced apart, because an agent re-sends its whole chat with every request and most of it is cached.
  const price = priceLine(m.price);
  if (price) parts.push(price);
  return parts.filter(Boolean).join(" · ");
}

/** A price per million tokens, short enough for a phone: "$0.33 in, $1.32 out per million (cached $0.008)". */
export function priceLine(p: TokenPrice | null | undefined): string | null {
  if (!p) return null;
  // Cents as cents ($0.45), and a price between them as it is ($0.025, Refuseless's cached input), not rounded up.
  const d = (n: number) => (n === 0 ? "free" : n < 0.01 ? `$${Number(n.toPrecision(1))}` : `$${n < 1 ? n.toFixed(3).replace(/0$/, "") : +n.toFixed(2)}`);
  const cached = p.cached !== null && p.cached < p.input ? ` (cached ${d(p.cached)})` : "";
  return `${d(p.input)} in, ${d(p.output)} out per million${cached}`;
}

/**
 * Said once over the list when any model in it can't run tools. It is worded as what it is: the service's own docs
 * naming the families whose tool calls work, not something a server told Crosstalk about this model.
 */
export const CATALOG_TOOLS_WORDS =
  "Featherless's docs say tool calls work on the Qwen 3 family and Kimi K2. An agent needs them to read files or run commands, so the rest are marked “No tools” — you can still pick one to talk to.";

/**
 * Said with the line above when a model on show is one the docs don't cover but the service's own list claims tool calls
 * for anyway (16,026 of its 22,406 rows say so, against the two families its docs name). It is the honest shape of it:
 * what isn't promised, rather than a model that can't.
 */
export const CATALOG_LIST_TOOLS_WORDS = "Featherless's own list says some of those can call tools, but its docs don't promise it for their family, so Crosstalk doesn't count on it.";

/**
 * NanoGPT's list says for each model whether it can call tools, and Crosstalk takes it at its word: a "No tools" there is
 * the service's own no, said as such.
 */
export const NANOGPT_TOOLS_WORDS = "NanoGPT's list says which models can call tools. An agent needs them to read files or run commands, so the rest are marked “No tools” — you can still pick one to talk to.";

/** Said once under a NanoGPT search when a model on show is covered by the subscription: what that means for what it costs. */
export const NANOGPT_PLAN_WORDS = "“In subscription”: with NanoGPT's $12-a-month subscription, replies on it come out of the weekly allowance instead of your balance.";

/** What a gated model needs before it will answer: its licence agreed on Featherless's own page (otherwise every request is a 403). */
export const CATALOG_GATED_WORDS = "Gated: open this model on featherless.ai and agree to its licence first, or it will refuse every request.";

/** Above the search box: how big the catalogue is, when the check could read that (a failed read still gets a search box). */
export function catalogIntro(total: number): string {
  return total ? `${total.toLocaleString("en-US")} models, so you search for the one you want.` : "Far too many models to list, so you search for the one you want.";
}

/** Under the search box: how many matched, and what to do when there are more than the answer holds. */
export function catalogSummary(s: CatalogSearch): string {
  const found = s.matched.toLocaleString("en-US");
  if (s.name === "nanogpt") return nanoSummary(s);
  if (!s.models.length) return s.q ? `Nothing matched “${s.q}”. Try part of a model's name, like qwen3 or abliterated.` : "Couldn't list any models just now. Press Test again.";
  // The catalogue's size is a separate thing to ask the service for: if that part failed, the shortlist still stands.
  if (!s.q) return s.total ? `A few uncensored ones of the ${s.total.toLocaleString("en-US")}. Type a name to find another.` : "A few uncensored ones. Type a name to find another.";
  return s.matched > s.models.length ? `${found} matched. These are the first ${s.models.length} — type more to narrow it down.` : `${plural(s.matched, "model", "models")} matched.`;
}

/** Which part of NanoGPT's list a search looked in, as the summary says it. */
const NANO_PART: Record<CatalogFilter, string> = { uncensored: "uncensored models", plan: "models in NanoGPT's subscription", all: "models" };

/** A NanoGPT search's summary: how many there are in the part it looked in, and how to narrow it down. */
function nanoSummary(s: CatalogSearch): string {
  const part = NANO_PART[s.filter ?? "all"];
  if (!s.models.length) return s.q ? `No ${part} matched “${s.q}”. Try part of a name, like deepseek or glm, or tap All models.` : "Couldn't list any models just now. Press Test again.";
  const first = s.matched > s.models.length ? ` These are the first ${s.models.length} — type more to narrow it down.` : "";
  if (s.q) return `${plural(s.matched, "model", "models")} matched among the ${part}.${first}`;
  return `${s.matched.toLocaleString("en-US")} ${part} of the ${s.total.toLocaleString("en-US")}, the ones that can run tools first, then the newest.${first}`;
}

/** A one-tap search under the box: what it types, and for NanoGPT which part of the list it looks in. */
export interface CatalogChip {
  label: string;
  q: string;
  filter?: CatalogFilter;
}

/** One-tap searches under the box, so finding a good uncensored model doesn't start with a blank field. */
export const CATALOG_CHIPS: CatalogChip[] = [
  { label: "Uncensored", q: "" },
  { label: "Qwen 3", q: "qwen3" },
  { label: "Kimi K2", q: "kimi-k2" },
];

/** NanoGPT's: its uncensored models, the subscription's, a few makers, and everything. */
export const NANOGPT_CHIPS: CatalogChip[] = [
  { label: "Uncensored", q: "", filter: "uncensored" },
  { label: "In subscription", q: "", filter: "plan" },
  { label: "DeepSeek", q: "deepseek", filter: "all" },
  { label: "GLM", q: "glm", filter: "all" },
  { label: "Qwen", q: "qwen", filter: "all" },
  { label: "All models", q: "", filter: "all" },
];

/** The chips for a catalogue. */
export const catalogChips = (name: CatalogName): CatalogChip[] => (name === "nanogpt" ? NANOGPT_CHIPS : CATALOG_CHIPS);

/** What the search box suggests typing. */
export const catalogPlaceholder = (name: CatalogName): string => (name === "nanogpt" ? "e.g. deepseek, glm, uncensored" : "e.g. abliterated, qwen3, Huihui");

/** The address of a catalogue search: NanoGPT's says which part of its list to look in. */
export function catalogPath(name: CatalogName, q: string, filter?: CatalogFilter): string {
  return `/api/services/catalog?name=${name}&q=${encodeURIComponent(q.trim())}${name === "nanogpt" && filter ? `&filter=${filter}` : ""}`;
}

/**
 * The catalogue rows to remember after a search: the ones just found, and every row already picked (those keep their
 * facts however many searches follow, so a picked model can still be unticked, made the default, and saved with its own
 * size). The rest are held to a few hundred, so a long session of typing can't grow this without end.
 */
export function rememberRows(seen: CatalogModel[], found: CatalogModel[], selected: string[], keep = 200): CatalogModel[] {
  // A row seen before keeps its place, with whatever the newest search said about it.
  const all = [...seen.map((m) => found.find((f) => f.id === m.id) ?? m), ...found.filter((f) => !seen.some((m) => m.id === f.id))];
  const picked = new Set(selected);
  const kept = new Set(all.filter((m) => !picked.has(m.id)).slice(-keep).map((m) => m.id));
  return all.filter((m) => picked.has(m.id) || kept.has(m.id));
}

/** A model's context as a chat may use it: its own, held to what the service's plan serves at once. */
export function capContext(window: number | null, cap: number | undefined): number | null {
  return window && cap ? Math.min(window, cap) : window;
}

/**
 * How much of a chat the key's plan reads at once: what the check read of the key's own plan (Featherless's GET /v1/plan,
 * where none means the plan has no cap of its own), else the preset's figure for the service's smallest plan, so nothing
 * is told it has room the service won't serve.
 */
export function planCap(r: ServiceTestResult | null | undefined, preset?: ServicePreset | null): number | undefined {
  return r?.plan ? (r.plan.maxContext ?? undefined) : preset?.contextCap;
}

/** How many requests the key's plan runs at once, found the same way (the facts beside a big model say what it uses of them). */
export function planAtOnce(r: ServiceTestResult | null | undefined, preset?: ServicePreset | null): number | undefined {
  return r?.plan ? (r.plan.concurrency ?? undefined) : preset?.atOnce;
}

/** Said once under the picked models when the plan reads less than a model could: the chat gets the plan's figure. */
export function capWords(models: CatalogModel[], cap: number | undefined): string | null {
  if (!cap || !models.some((m) => m.contextWindow && m.contextWindow > cap)) return null;
  return `Your plan reads ${formatContext(cap)} of a chat at once, so a model that could hold more is saved at ${formatContext(cap)}.`;
}

/**
 * Up to 20 listed models all start picked; more than that, you pick the ones you want (counting every model listed, so
 * a long list stays a list you pick from). One the service says can't run tools is left out of that first pick (ticking
 * it is still your choice).
 */
export const initialSelection = (choices: ModelChoice[]): string[] => serviceModelPick(choices);

/** Picks or drops a model (new ones go last; no more than 20). */
export function toggleModel(selected: string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((m) => m !== id);
  return selected.length >= MAX_MODELS ? selected : [...selected, id];
}

/** The first model picked is the default: this puts one first. */
export const makeDefault = (selected: string[], id: string): string[] => (selected.includes(id) ? [id, ...selected.filter((m) => m !== id)] : selected);

/** Model names typed by hand (for a service that lists none): separated by commas, no spaces inside a name. */
export function parseModelNames(text: string): string[] {
  return [...new Set(text.split(",").map((m) => m.trim()).filter((m) => m && m.length <= 200 && !/\s/.test(m)))].slice(0, MAX_MODELS);
}

/** A name quoted back in a message, short enough for a phone (and never cut through the middle of a character). */
const quoted = (m: string) => (m.length > 24 ? `${m.slice(0, 24).replace(/[\ud800-\udbff]$/, "")}…` : m);

/**
 * Model names typed by hand, and what had to be left out, in plain words that say what to do: a name the sheet drops
 * (a space in it, far too long, or past the twentieth) would otherwise just vanish as it's typed, taking "Add it" and
 * the context field with it and saying nothing.
 */
export function typedModelNames(text: string): { names: string[]; problem: string | null } {
  const names = parseModelNames(text);
  const given = [...new Set(text.split(",").map((m) => m.trim()).filter(Boolean))];
  const spaced = given.find((m) => /\s/.test(m));
  const long = given.find((m) => m.length > 200);
  const problem = spaced
    ? `A model name is one word, as the agent passes it: "${quoted(spaced)}" has a space in it. Use the name the server itself uses, like qwen3-8b.`
    : long
      ? `"${quoted(long)}" is too long for a model name. Use the short name the server itself uses.`
      : given.length > MAX_MODELS
        ? `That's ${given.length} names. ${MAX_MODELS} is the most one service keeps: only the first ${MAX_MODELS} are added.`
        : null;
  return { names, problem };
}

const sane = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 2048 && n <= 10_000_000;

/** A model's context size when the service said one the hub accepts. */
export function contextOf(r: ServiceTestResult, id: string | undefined): number | null {
  const window = r.models.find((m) => m.id === id)?.contextWindow;
  return sane(window) ? window : null;
}

export interface SaveInput {
  agent: ServiceAgent;
  result: ServiceTestResult;
  preset: ServicePreset | null;
  baseUrl: string;
  apiKey: string;
  label: string;
  /** The models picked, the default first. */
  models: string[];
  /** A context size typed by hand, for when the service didn't say. */
  context: string;
  /** The catalogue rows a search found, for a service whose models aren't in the check's own list. */
  found?: CatalogModel[];
}

/** The body of POST /api/accounts/endpoint for a checked service. */
export function saveBody(i: SaveInput): Record<string, unknown> {
  const cap = planCap(i.result, i.preset);
  const contexts: Record<string, number> = {};
  for (const id of i.models) {
    // A model found by searching a catalogue carries its own size; the rest come from the check's list. Either way the
    // plan's own limit is what a chat is given, so nothing is told it has room the service won't serve.
    const window = capContext(i.found?.find((m) => m.id === id)?.contextWindow ?? contextOf(i.result, id), cap);
    if (window) contexts[id] = window;
  }
  const typed = capContext(Number(i.context), cap) ?? 0;
  const protocol = protocolFor(i.result, i.agent, i.preset);
  return {
    provider: i.agent,
    baseUrl: i.baseUrl.trim(),
    ...(i.label.trim() ? { label: i.label.trim() } : {}),
    // Saved with the account; empty means the server asks for none.
    apiKey: i.apiKey.trim(),
    models: i.models,
    // Older hubs know one size per account: the default model's, else the one typed.
    contextWindow: contexts[i.models[0]] ?? (sane(typed) ? typed : null),
    ...(protocol ? { protocol } : {}),
    ...(i.preset?.chatPath ? { chatPath: i.preset.chatPath } : {}),
    ...(Object.keys(contexts).length ? { contexts } : {}),
    // What this service needs in every chat request (Venice's venice_parameters): the hub merges it under its own fields.
    ...(i.preset?.extra ? { extra: i.preset.extra } : {}),
  };
}

/** Every Claude Code and Codex account, each agent's own sign-in first, then the services Crosstalk's own agent and OpenCode run on. */
export function serviceList(accounts: Record<string, AgentAccount>): AgentAccount[] {
  const rank = (a: AgentAccount) => SERVICE_AGENTS.indexOf(a.provider as ServiceAgent) * 2 + (a.id === "default" ? 0 : 1);
  return Object.values(accounts)
    .filter((a) => (CHAT_PROVIDERS as readonly string[]).includes(a.provider) || (isServiceOnlyAgent(a.provider) && a.kind === "endpoint"))
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/**
 * The line under Agents in Settings → AI services (`list`: serviceList's): which agent runs which service, because Claude
 * Code and Codex no longer run them all, and what the Claude Code and Codex cards below it are for. Crosstalk's own agent
 * and OpenCode run their services with those services' keys and have no sign-in, so "sign in to your plan" is only ever
 * about Claude Code and Codex, never about them.
 */
export function agentsLine(list: readonly Pick<AgentAccount, "provider" | "label">[]): string {
  const names = (p: ServiceOnlyAgent) => list.filter((a) => a.provider === p).map((a) => a.label).join(" and ");
  const said = [names("opencode") && `OpenCode runs ${names("opencode")}`, names("builtin") && `Crosstalk's own agent runs ${names("builtin")} itself`].filter(Boolean);
  if (!said.length) return "Claude Code and Codex run every service above. Install them, sign in to your plan or add accounts here.";
  const runs = `${said.join(" and ")}, with ${list.filter((a) => isServiceOnlyAgent(a.provider)).length === 1 ? "the key" : "the keys"} above`;
  return list.some((a) => !isServiceOnlyAgent(a.provider))
    ? `Claude Code and Codex run the other services above. ${runs}, and ${said.length === 1 ? "needs" : "need"} no sign-in. Install Claude Code or Codex, sign in to your plan or add accounts here.`
    : `${runs}: no sign-in, and no Claude Code or Codex needed. To use those too, install them, sign in to your plan or add accounts here.`;
}

/**
 * The body of POST /api/services/test for a custom model: its saved key, at its saved address. That route knows only
 * custom models (it finds an account among them), so a plan sign-in or an API key gets null: its Test is the account's own
 * check, POST /api/accounts/:provider/:id/refresh, the same as Check under Accounts. It takes Claude Code or Codex as
 * `provider`; Crosstalk's own agent and OpenCode leave it out, and the hub finds their accounts by id (their accounts' own
 * check only ever says "ready", so a key the service refused, what their chats' replies send you here about, would never show).
 */
export function testBody(a: AgentAccount): { baseUrl: string; accountId: string; provider?: ChatProvider; chatPath?: string } | null {
  if (!isServiceAgent(a.provider) || a.kind !== "endpoint" || !a.endpoint) return null;
  return { baseUrl: a.endpoint.baseUrl, accountId: a.id, ...(isServiceOnlyAgent(a.provider) ? {} : { provider: a.provider }), ...(a.endpoint.chatPath ? { chatPath: a.endpoint.chatPath } : {}) };
}

/** True when the hub has no such route at all (its own plain "not found"): a hub that has the route answers a 404 in its own words ("No such account"). */
export const routeMissing = (message: string, status?: number): boolean => status === 404 && /^not found\.?$/i.test(message.trim());

/** Why a check couldn't run, with what to do. Only a hub without the route is "too old"; any other answer is reported as it came. */
export function testFailure(message: string, status?: number): string {
  return routeMissing(message, status)
    ? "This machine's hub is too old to check services. Update it, or use Add a custom model under Claude Code or Codex below."
    : `The check didn't run: ${noDot(message)}. Press Test to try again.`;
}

const hostOf = (url: string | undefined) => {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Under a row's name: the agent, then the plan or key kind. */
export function kindLine(a: AgentAccount): string {
  const agent = PROVIDER_INFO[a.provider].name;
  if (a.kind === "apikey") return `${agent} · API key, billed per use`;
  if (a.kind === "endpoint") return [agent, "Custom model", hostOf(a.endpoint?.baseUrl), a.endpoint?.protocol === "chat" && a.provider === "codex" ? "chat adapter" : ""].filter(Boolean).join(" · ");
  return [agent, a.plan, a.account].filter(Boolean).join(" · ");
}

/**
 * Where a service's own settings are, said on its row: a plan sign-in is signed in and an API key replaced under the
 * agent's card below, and a service you added here is changed with the row's own Change button (its address, key and
 * models) and removed under that card. Null when there's nothing to say. Without this line a custom model could be
 * tested on its row and changed nowhere: the key a check says was refused has no field anywhere near it.
 */
export function serviceFixLine(a: AgentAccount): string | null {
  const agent = PROVIDER_INFO[a.provider].name;
  // Crosstalk's own agent and OpenCode have no Accounts below: their services are removed on their own rows.
  if (a.kind === "endpoint") return isServiceOnlyAgent(a.provider) ? "Change its address, key or models with Change, or take it away with Remove." : `Change its address, key or models with Change. Remove it under ${agent} → Accounts below.`;
  if (a.signedIn !== false) return null;
  if (a.kind === "apikey") return `Replace the key under ${agent} below.`;
  return `Press Sign in under ${agent} below.`;
}

/**
 * The dot and word on a row. A custom model shows its last check's answer; a plan sign-in or an API key always shows the
 * agent's own live state (Test asks the agent again, and the row shows what it said).
 */
export function statusOf(a: AgentAccount, outcome: Outcome | null, catalog: ModelCatalog | null): { tone: Tone; text: string } {
  if (a.kind === "apikey") return a.signedIn === true ? { tone: "ok", text: "Key accepted" } : a.signedIn === false ? { tone: "warn", text: "Key not accepted" } : { tone: "idle", text: "Key not confirmed" };
  if (a.kind === "endpoint") {
    if (outcome) return { tone: outcome.tone, text: outcome.text };
    if (catalog?.live === false) return { tone: "bad", text: "Can't reach it" };
    return { tone: "idle", text: "Not tested yet" };
  }
  return a.signedIn === true ? { tone: "ok", text: "Signed in" } : a.signedIn === false ? { tone: "warn", text: "Not signed in" } : { tone: "idle", text: "Sign-in not confirmed" };
}

/** The names a row lists: a custom model's live list (else its saved names), an agent's own models. */
export function modelNames(a: AgentAccount, catalog: ModelCatalog | null): string[] {
  if (a.kind === "endpoint") return catalog?.models.length ? catalog.models.map((m) => m.id) : (a.endpoint?.models ?? []);
  // A list that's only suggestions (the agent couldn't be asked) isn't shown as the account's models.
  return catalog && catalog.live !== false ? catalog.models.map((m) => m.label || m.id) : [];
}

export function modelsLine(names: string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${names.length} models: ${shown} and ${names.length - 3} more` : `${plural(names.length, "model", "models")}: ${shown}`;
}

/** "Couldn't reach it; showing the list from March 3." when a custom model's list is the saved one. */
export function staleLine(catalog: ModelCatalog | null): string | null {
  if (!catalog || catalog.live !== false) return null;
  const when = catalog.checkedAt ? new Date(catalog.checkedAt).toLocaleDateString("en-US", { month: "long", day: "numeric" }) : null;
  return when ? `Couldn't reach it; showing the list from ${when}.` : "Couldn't reach it; showing the saved list.";
}

/** The chip on a row: what the account cost this month (≈ for a plan sign-in, which isn't billed), and how its limit stands. */
export function spendChip(s: AccountSpend | undefined): { text: string; tone: "ok" | "warn" | "stopped" } | null {
  if (!s || !(s.month.usd > 0)) return null;
  return { text: `${costLabel(s.month.usd, s.kind === "signin" ? "estimated" : "exact")} this month`, tone: s.budget?.state === "stopped" ? "stopped" : s.budget?.state === "warn" ? "warn" : "ok" };
}

/** A context size as models name it: 128k, 200k, 1M. */
export function formatContext(n: number): string {
  if (n < 1000) return String(n);
  const binary = n % 1024 === 0;
  const k = n / (binary ? 1024 : 1000);
  return k >= 1000 ? `${+(k / (binary ? 1024 : 1000)).toFixed(1)}M` : `${Math.round(k)}k`;
}

export function bytes(n: number): string {
  const GB = 1024 ** 3;
  if (n >= GB) return `${(n / GB).toFixed(n >= 100 * GB ? 0 : 1)} GB`;
  return n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** The address a found server answers at, as a person reads it: "127.0.0.1:11434". */
export const serverHost = (s: LocalServer): string => hostOf(s.baseUrl);

/** This machine's own names for itself, which all mean the one server (the hub matches them the same way). */
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
/** Two addresses as one thing to compare: the same host and port, whichever name this machine was called by. */
const samePlace = (a: string, b: string): boolean => {
  const one = (h: string) => {
    const at = h.lastIndexOf(":");
    const split = at > h.lastIndexOf("]");
    const host = split ? h.slice(0, at) : h;
    return `${LOOPBACK.includes(host) ? "localhost" : host}${split ? h.slice(at) : ""}`;
  };
  return !!a && !!b && one(a) === one(b);
};

/**
 * Whether a server found on this machine is already in use. The scan says so (`accountIds`), and so do the accounts
 * themselves, which arrive the moment one is added — before the next look for servers (web/src/newChat.ts keeps the
 * New chat menu right the same way). Without them the row a person just used would still offer "Use it", and a second
 * tap ends in "There's already a Codex account called …" — whose advice leaves two accounts on the one server.
 */
export function serverInUse(s: Pick<LocalServer, "baseUrl" | "accountIds">, accounts: AgentAccount[]): boolean {
  if (s.accountIds.length) return true;
  return accounts.some((a) => a.kind === "endpoint" && samePlace(hostOf(a.endpoint?.baseUrl), hostOf(s.baseUrl)));
}

/** Under a found server's name: its models, which are loaded, and the memory it uses when it says. */
export function serverLine(s: LocalServer): string {
  const loaded = s.models.filter((m) => m.loaded).map((m) => m.id);
  const parts = [plural(s.models.length, "model", "models")];
  if (loaded.length) parts.push(`${loaded.slice(0, 2).join(", ")}${loaded.length > 2 ? ` and ${loaded.length - 2} more` : ""} loaded`);
  if (s.memoryBytes) parts.push(`${bytes(s.memoryBytes)} in use`);
  return parts.join(" · ");
}

// ---- OpenCode's own place in Settings → AI services, and moving a service between the two agents that run only on services ----

/** What OpenCode's card says about it. `action`: the install it offers, if any (the hub's own words for a wrong version say Install). */
export interface OpenCodeState {
  word: string;
  tone: "" | "green" | "orange";
  action: "Install" | "Update" | null;
  line: string | null;
}

export function openCodeState(status: ProviderStatus): OpenCodeState {
  if (!status.checkedAt) return { word: "Checking…", tone: "", action: null, line: null };
  if (!status.installed) return { word: "Not installed", tone: "", action: "Install", line: "Install it to run a service with it. It needs Node.js on this machine." };
  if (status.error) return { word: "Can't be used", tone: "orange", action: "Install", line: status.error };
  if (status.version !== OPENCODE_VERSION) {
    const has = status.version ? `This machine has ${status.version}.` : "This machine's OpenCode didn't say its version.";
    return { word: "Other version", tone: "orange", action: "Update", line: `Crosstalk was checked with OpenCode ${OPENCODE_VERSION}. ${has} Update puts ${OPENCODE_VERSION} on it.` };
  }
  return { word: "Installed", tone: "green", action: null, line: null };
}

/**
 * Why OpenCode can't run a chat though it's on the machine (a version 1, say), in the hub's words: null when it can, and for
 * any other agent, whose `error` can be about something else, such as a sign-in check that failed.
 */
export const openCodeUnusable = (agent: Provider, s?: ProviderStatus): string | null => (agent === "opencode" && s?.installed ? s.error : null);

/** Whether an agent's program can run a service on this machine: it's there, and usable. Not known yet counts as yes, so nothing is held up while the hub is asked. */
export const agentCanRun = (agent: Provider, s?: ProviderStatus): boolean => s?.installed !== false && !openCodeUnusable(agent, s);

/** How an install is going: not started, on its way to the hub, running, ended and being checked, then in or not. */
export type InstallPhase = "idle" | "starting" | "running" | "checking" | "done" | "failed";

/** The one line that says how an install is going, in the same place from start to end. */
export function installWords(i: { name: string; machine: string; phase: InstallPhase; exitCode: number | null; stopped: boolean; status: ProviderStatus | undefined }): string {
  const { name, machine, status } = i;
  switch (i.phase) {
    case "idle":
      return "";
    case "starting":
      return `Starting the install on ${machine}…`;
    case "running":
      return `Installing ${name} on ${machine}…`;
    case "checking":
      return `The install has ended. Checking ${name}…`;
    case "done":
      return `${name}${status?.version ? ` ${status.version}` : ""} is installed.`;
    case "failed":
      if (i.stopped) return "You stopped the install.";
      // Ended well, and still no use: the hub's own check is what counts, and its words say why (a program that doesn't run).
      if (i.exitCode === 0) return status?.error ?? `The installer finished, but ${name} isn't where Crosstalk looks for it on ${machine}. What it printed is below.`;
      if (i.exitCode === null) return `Couldn't see how the install ended: ${machine} no longer has its terminal.`;
      return `${name} didn't install (exit ${i.exitCode}). What it printed is below.`;
  }
}

/** An install that couldn't begin, with what to do. Only a hub without the route is "too old"; any other answer is reported as it came. */
export function installFailure(name: string, message: string, status?: number): string {
  return routeMissing(message, status) ? `This machine's hub is too old to install ${name} from here. Update it first.` : `The install didn't start: ${noDot(message)}. Try again in a moment.`;
}

/**
 * The agent a service's row offers to run it with instead (POST /api/accounts/:p/:id/agent copies it there, key and all): the
 * other of the two agents that run only on services, for the two services the hub runs either of them on. Null for any
 * other account, and when that agent already has a service at this address (the old row stays while chats use it, and the
 * hub would only answer with the one that's there): there's nothing to move.
 */
export function switchAgent(a: AgentAccount, accounts: AgentAccount[]): ServiceOnlyAgent | null {
  if (a.kind !== "endpoint" || !isServiceOnlyAgent(a.provider) || !(isRefuseless(a.endpoint?.baseUrl) || isNanoGpt(a.endpoint?.baseUrl))) return null;
  const to = a.provider === "builtin" ? "opencode" : "builtin";
  return accounts.some((o) => o.provider === to && o.kind === "endpoint" && o.endpoint?.baseUrl === a.endpoint?.baseUrl) ? null : to;
}

/** The toast once a service has moved. `oldKept`: chats still use its old account, so that row stays. */
export function switchedWords(label: string, from: Provider, to: Provider, oldKept: boolean): string {
  const now = `${label} now runs with ${PROVIDER_INFO[to].name}, with the same key.`;
  return oldKept ? `${now} Chats already on it stay with ${PROVIDER_INFO[from].name}, so that row stays. Press Remove on it once they're deleted.` : now;
}

/** Why a move didn't happen, with what to do (`button`: what the button is called). Only a hub without the route is "too old"; any other answer is reported as it came. */
export function switchFailure(button: string, message: string, status?: number): string {
  return routeMissing(message, status) ? "This machine's hub is too old to move a service to another agent. Update it first." : `Couldn't move it: ${noDot(message)}. Press ${button} to try again.`;
}
