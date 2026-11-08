// The sign-in sheet's own little state: which agent, account and machine it's open for. One sheet for the whole app
// (views/SignIn.tsx SignInHost draws it), so the chat's card, Settings, the setup checklist and a notice all open the
// same one, and it stays open whatever screen is under it.
import { create } from "zustand";
import type { Provider } from "@crosstalk/shared";

export interface SignInTarget {
  provider: Provider;
  account: string;
  accountLabel?: string | null;
  /** The machine the agent is on: its key in this app (machineKey) and its name. */
  machineKey: string;
  machine: string;
  /** A reply of the chat it was opened from failed on it: once signed in, the next step is that chat's Try again. */
  stopped?: boolean;
  /** The button that opened it: the keyboard goes back there when the sheet closes, while it's still on screen. */
  opener?: HTMLElement | null;
  /**
   * Where the keyboard goes when the sheet closes and what opened it has gone: the chat's card goes once it's signed
   * in, so the keyboard lands on the chat's Try again instead of the top of the page.
   */
  focusAfter?: () => HTMLElement | null;
}

/**
 * `target`: what the sheet is open for (null: it's closed). `terminal`: it handed over to the agent's own sign-in in a
 * terminal (Settings' older way, for an agent that can't sign in from the sheet).
 */
export const useSignInSheet = create<{ target: SignInTarget | null; terminal: SignInTarget | null }>(() => ({ target: null, terminal: null }));

/** Opens the sign-in sheet for an agent's account on a machine. */
export function openSignIn(target: SignInTarget) {
  useSignInSheet.setState({ target, terminal: null });
}

export function closeSignIn() {
  useSignInSheet.setState({ target: null, terminal: null });
}
