// The one sign-in sheet (views/SignIn.tsx), drawn over whatever screen is up wherever it was opened from (signInSheet.ts),
// and, for an agent that can't sign in from the sheet, the agent's own sign-in in a terminal as Settings has it.
import { useEffect, useRef, useState } from "react";
import type { LoginFlow } from "@crosstalk/shared";
import { closeSignIn, useSignInSheet, type SignInTarget } from "../signInSheet";
import { useStore } from "../store";
import { SignInSheet } from "./SignIn";
import { LoginDialog, startLogin } from "./SetupPage";

/** Each opening is a sheet of its own (its own key): one opened again starts from what the machine has now. */
const openings = new WeakMap<SignInTarget, number>();
let opened = 0;
const keyOf = (t: SignInTarget) => {
  let k = openings.get(t);
  if (k === undefined) openings.set(t, (k = ++opened));
  return k;
};

/** What the keyboard can be on and mean it: a control, not a screen's own scrolling container. */
const CONTROL = "button, a[href], input, select, textarea, summary, [role='button'], [contenteditable='true']";

export function SignInHost() {
  const target = useSignInSheet((s) => s.target);
  const terminal = useSignInSheet((s) => s.terminal);
  /**
   * Closed, however: the keyboard goes back to the button that opened it, or, when that has gone (a chat's card goes
   * once it's signed in), where its opener said. The sheet hands the focus back to what had it as it opened, which is
   * that button in most browsers; Safari doesn't focus a button that's tapped, so there it's the screen's scrolling
   * container (or nothing), which tells a keyboard or screen-reader user nothing.
   */
  const close = () => {
    const t = target;
    closeSignIn();
    if (!t?.opener && !t?.focusAfter) return;
    setTimeout(() => {
      const now = document.activeElement;
      if (now && now !== document.body && now.matches(CONTROL)) return;
      const to = t.opener?.isConnected ? t.opener : t.focusAfter?.() ?? null;
      to?.focus();
    }, 0);
  };
  if (terminal) return <TerminalSignIn target={terminal} />;
  if (!target) return null;
  return <SignInSheet key={keyOf(target)} target={target} onClose={close} onTerminal={() => useSignInSheet.setState({ target: null, terminal: target })} />;
}

/** The agent's own sign-in in a terminal on its machine (LoginFlow), started once for this hand-over. */
function TerminalSignIn({ target }: { target: SignInTarget }) {
  const toast = useStore((s) => s.toast);
  const [flow, setFlow] = useState<LoginFlow | null>(null);
  const begun = useRef(false);
  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    // The terminal sign-in is the screen's own machine's: that machine is the one showing.
    const app = useStore.getState();
    if (app.active !== target.machineKey) app.activate(target.machineKey);
    startLogin(target.provider, target.account)
      .then(setFlow)
      .catch((e) => {
        toast("error", `Couldn't start the terminal sign-in: ${e instanceof Error ? e.message : String(e)} Try again from the agent's card in Settings → Agents.`);
        closeSignIn();
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!flow) return null;
  return <LoginDialog provider={target.provider} accountId={target.account} label={target.accountLabel || "Default account"} flow={flow} onClose={closeSignIn} />;
}
