import type { Room, RoomActivity } from "@crosstalk/shared";

/** Kept on this device (`localStorage`, nothing on the hub): the welcome card was skipped, or its three steps were all done once. */
export const WELCOME_KEY = "crosstalk.welcome.dismissed";

export type WelcomeStepId = "signin" | "folder" | "hello";
export interface WelcomeStep {
  id: WelcomeStepId;
  title: string;
  /** One plain sentence. */
  text: string;
  done: boolean;
}

type ChatFacts = Pick<Room, "id" | "chat" | "lastReplyAt">;
/** What the hub says was done in a chat: the replies its agents finished (`roomActivity`; a failed or stopped one isn't counted). */
type Finished = Pick<RoomActivity, "turns">[];

/**
 * Whether an agent has answered in a chat: a reply of its has ended there (`lastReplyAt`) and wasn't a failure. A
 * message merely sent isn't an answer. Nor is a reply that failed (no sign-in, a refused key): the hub notes when that
 * one ended too, so the chat also has to have a reply an agent finished (`finished`).
 */
export function chatAnswered(r: Pick<Room, "lastReplyAt">, finished: Finished = []): boolean {
  return typeof r.lastReplyAt === "number" && finished.some((a) => a.turns > 0);
}

/**
 * The three steps and which are done, from what the app already knows (no flag on the hub): an agent is ready to chat
 * (`signedIn`: signed in, or given an API key or an AI service, on any machine), a chat exists (it was started in a
 * folder), and an agent has answered in one (chatAnswered; `activity`: the replies finished in each chat, by its id).
 * Older multi-agent rooms aren't chats and count for neither.
 */
export function welcomeSteps(input: { signedIn: boolean; rooms: ChatFacts[]; activity?: Record<string, Finished> }): WelcomeStep[] {
  const chats = input.rooms.filter((r) => r.chat);
  return [
    { id: "signin", title: "Sign in an agent", text: "Claude Code or Codex needs your sign-in before it can answer.", done: input.signedIn },
    { id: "folder", title: "Pick a folder", text: "Your agent reads and changes files in a folder you choose; a new empty one is fine.", done: chats.length > 0 },
    { id: "hello", title: "Say hello", text: "Type anything in your new chat to see your agent answer.", done: chats.some((r) => chatAnswered(r, input.activity?.[r.id])) },
  ];
}

/** The step to do next (the first that isn't done), or null when all are. */
export function nextWelcomeStep(steps: WelcomeStep[]): WelcomeStepId | null {
  return steps.find((s) => !s.done)?.id ?? null;
}

/** The card shows once the hub's state is in (so a returning person never sees it flash), until skipped or all done. */
export function welcomeShows(input: { loaded: boolean; dismissed: boolean; steps: WelcomeStep[] }): boolean {
  return input.loaded && !input.dismissed && nextWelcomeStep(input.steps) !== null;
}

type Reading = Pick<Storage, "getItem">;
type Writing = Pick<Storage, "setItem">;
const here = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // some browsers refuse storage (private mode): the card is skipped for this visit only
  }
};

export function welcomeDismissed(storage: Reading | undefined = here()): boolean {
  try {
    return storage?.getItem(WELCOME_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissWelcome(storage: Writing | undefined = here()): void {
  try {
    storage?.setItem(WELCOME_KEY, "1");
  } catch {
    // nothing to keep it in
  }
}
