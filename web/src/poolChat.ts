// Chatting with the model pool (docs/MODEL-POOL.md), as plainly as with a model server on this machine: one entry
// wherever a chat starts, what it says in each state, what a tap on it does, and what a chat on the pool calls itself.
// The hub sends the facts (PoolOffer, hub/src/pool/pool.ts chatOffer); the words and the decisions are here, so they
// can be tested without a pool and without a browser.

import { CHAT_PROVIDERS, PROVIDER_INFO, type ChatProvider, type PoolOffer, type PoolState } from "@crosstalk/shared";
import { namesText, POOL_STATE } from "./pool";

/** What tapping the pool's entry should do, which is what a person would expect in that state. */
export type PoolAction =
  /** It runs and answers: start the chat. */
  | "chat"
  /** Set up and stopped: offer to start it (it takes a while), then the chat. */
  | "start"
  /** On its way to running: Settings → Model pool is where the progress is. */
  | "watch"
  /** A machine it needs isn't there, or the last start hit a problem: Settings → Model pool, to check the machines. */
  | "fix"
  /** No model chosen yet (or no machine): Settings → Model pool, to set it up. */
  | "set-up";

/**
 * A pool offer with every part the screens read, so a hub that sends something odd (older, or newer with a state this
 * app doesn't know) can't break the New chat menu: missing lists are empty and an unknown state reads as "off".
 */
export function normalizeOffer(o: PoolOffer): PoolOffer {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s) : []);
  const accounts: PoolOffer["accounts"] = {};
  for (const p of CHAT_PROVIDERS) {
    const id = o?.accounts?.[p];
    if (typeof id === "string" && id) accounts[p] = id;
  }
  return {
    label: typeof o?.label === "string" && o.label.trim() ? o.label : "Model pool",
    state: o?.state && Object.hasOwn(POOL_STATE, o.state) ? o.state : "off",
    detail: typeof o?.detail === "string" ? o.detail : null,
    setUp: !!o?.setUp,
    ready: !!o?.ready && o?.state === "running",
    model: typeof o?.model === "string" && o.model ? o.model : null,
    modelName: typeof o?.modelName === "string" && o.modelName ? o.modelName : null,
    machines: list(o?.machines),
    missing: list(o?.missing),
    accounts,
  };
}

/** The pool is on its way to running (Settings → Model pool shows how far it's got). */
const onItsWay = (s: PoolState) => s === "preparing" || s === "downloading" || s === "starting";

/** What a tap on the pool's entry does. */
export function poolAction(offer: PoolOffer): PoolAction {
  if (offer.ready) return "chat";
  if (onItsWay(offer.state) || offer.state === "stopping") return "watch";
  if (!offer.setUp || !offer.machines.length) return "set-up";
  // A machine it needs isn't answering, or the last start stopped with a problem: checking the machines comes first.
  if (offer.missing.length || offer.state === "error") return "fix";
  return "start";
}

/** Which agents can drive a pool chat: the ones the pool saved an account for, in the agents' own order. */
export function poolAgents(offer: PoolOffer, installed: Partial<Record<ChatProvider, boolean>> = {}): ChatProvider[] {
  // An agent that isn't on this machine comes last, as a service's does: the chat could be started but not answered.
  const mine = CHAT_PROVIDERS.filter((p) => !!offer.accounts[p]);
  return [...mine.filter((p) => installed[p] !== false), ...mine.filter((p) => installed[p] === false)];
}

/**
 * The agent that drives a pool chat, picked the way a service's is (serviceAgentFor): the one asked for if the pool has
 * an account for it, else the preferred one, else the first. Null when the pool has never run, so it has no account yet.
 */
export function poolAgentFor(offer: PoolOffer, preferred: ChatProvider = "claude", picked?: ChatProvider | null, installed: Partial<Record<ChatProvider, boolean>> = {}): ChatProvider | null {
  const can = poolAgents(offer, installed);
  if (picked && can.includes(picked)) return picked;
  // An agent that isn't on this machine can't answer, so it's never the one picked for you: a hub with only Codex gets
  // Codex, not a chat that can't start (serviceAgentFor does the same). With neither installed the order stands.
  const here = can.filter((p) => installed[p] !== false);
  const from = here.length ? here : can;
  return from.includes(preferred) ? preferred : (from[0] ?? null);
}

/** "across 3 machines", "on linux-box" — where the model runs, in plain words. */
export function poolWhereWords(offer: PoolOffer): string {
  if (!offer.machines.length) return "no machines yet";
  if (offer.machines.length === 1) return `on ${offer.machines[0]}`;
  return `across ${offer.machines.length} machines`;
}

/** The pool's state in a word or two, for the entry: "Ready", "Starting…", "Off", "Needs linux-box". */
export function poolStateWords(offer: PoolOffer): string {
  if (offer.ready) return "Ready";
  if (onItsWay(offer.state)) return `${POOL_STATE[offer.state].label}…`;
  if (offer.state === "stopping") return "Stopping…";
  if (!offer.setUp || !offer.machines.length) return "Not set up";
  if (offer.missing.length) return `Needs ${namesText(offer.missing)}`;
  if (offer.state === "error") return "Problem";
  return "Off";
}

/**
 * The line under the pool's entry: the model it runs, where it runs, and what state it's in — short enough for a
 * 390 px screen. Before a model is chosen it says what the pool is for instead.
 */
export function poolHelp(offer: PoolOffer): string {
  if (!offer.setUp) return "One big model across your machines · Set it up";
  return [offer.model ?? offer.modelName ?? "No model yet", poolWhereWords(offer), poolStateWords(offer)].filter(Boolean).join(" · ");
}

/** What the entry does, said on the button that does it. */
export const POOL_BUTTON: Record<PoolAction, string> = {
  chat: "Start chat",
  start: "Start the pool",
  watch: "Open Model pool",
  fix: "Check the machines",
  "set-up": "Set up the model pool",
};

/**
 * What a tap says before anything happens, in the dialog: what the pool is, and for a tap that would start it, what
 * starting does and that it takes a while — nothing starts on any machine until the person taps the button.
 */
export function poolAsk(offer: PoolOffer): { words: string; button: string } {
  const action = poolAction(offer);
  const where = poolWhereWords(offer);
  const model = offer.model ?? offer.modelName ?? "its model";
  const words =
    action === "start"
      ? `Starting ${offer.label} runs ${model} ${where}. It installs llama.cpp where it's missing, downloads the model to the main machine the first time, and holds those GPUs until you stop it. It can take a few minutes — longer on the first run.`
      : action === "watch"
        ? // Stopping is the other way round: nothing to wait for, it can be started again once it's off.
          offer.state === "stopping"
          ? `${offer.label} is stopping. ${offer.detail ?? ""} You can start it again in Settings → Model pool once it says Off.`.replace(/\s+/g, " ")
          : `${offer.label} is starting. ${offer.detail ?? "Settings → Model pool shows how far it's got."} Your chat can start once it says Running.`
        : action === "fix"
          ? // What's known is what the last look found: the button checks the machines again, so a machine that's back
            // clears itself here rather than leaving the entry stuck on a fact that has moved on.
            `${offer.detail ?? (offer.missing.length ? `${namesText(offer.missing)} didn't answer the last time Crosstalk looked.` : "The last start stopped with a problem.")} Check the machines now: if they answer, you can start the pool here.`
          : `${offer.label} runs one big model across your own machines. Choose the model and the machines in Settings → Model pool, then come back here to chat with it.`;
  return { words, button: POOL_BUTTON[action] };
}

/** The note at the top of a pool chat's model menu: a pool serves one model at a time, and where that is changed. */
export function poolModelNote(offer: PoolOffer, agent: ChatProvider): string {
  const model = offer.model ? `: ${offer.model}` : "";
  const run = `Driven by ${PROVIDER_INFO[agent].name}.`;
  if (offer.ready) return `${offer.label} runs one model at a time${model}. Change it in Settings → Model pool. ${run}`;
  // Not "pick another model here": this menu holds the pool's one model. Another model means another account, which is
  // in the chat's own settings (hub/src/pool/pool.ts chatProblem says the same).
  return `${offer.label} isn't running, so ${offer.model ?? "its model"} can't answer. Start it in Settings → Model pool, or move this chat to another account in its settings. ${run}`;
}
