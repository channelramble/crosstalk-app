// One tap from "this agent isn't signed in" to signing it in: the sign-in sheet (views/SignIn.tsx), on the machine on
// screen, for its own sign-in. An agent the sheet can't sign in (not installed yet, or a hub from before phone sign-in)
// gets Settings, at that agent.

import type { ChatProvider } from "@crosstalk/shared";
import { PROVIDER_INFO } from "@crosstalk/shared";
import { showInSettings } from "../navigation";
import { openSignIn } from "../signInSheet";
import { PHONE_SIGN_IN } from "../signIn";
import { hubStore, machineName, useStore } from "../store";

/**
 * `account`: another of the agent's accounts to sign in, in place of its own sign-in. `machineKey`: the machine to sign
 * it in on, when that isn't the one on screen (New chat can be for another machine). `onLeave`: called before it goes
 * to Settings, for a dialog to close itself first.
 */
export function AgentSignInButton({ provider, className = "btn primary", account, machineKey, onLeave }: { provider: ChatProvider; className?: string; account?: { id: string; label: string }; machineKey?: string; onLeave?: () => void }) {
  const active = useStore((s) => s.active);
  const here = useStore((s) => s.providers[provider]);
  const sheetHere = useStore((s) => s.signIns !== null);
  // Another machine's own store says what's installed there and whether its hub signs agents in from the phone.
  const other = machineKey !== undefined && machineKey !== active ? hubStore(machineKey)?.getState() : undefined;
  const status = other ? other.providers[provider] : here;
  const sheet = (other ? other.signIns !== null : sheetHere) && PHONE_SIGN_IN.includes(provider);
  const name = PROVIDER_INFO[provider].name;
  if (status?.installed && sheet) {
    return (
      <button
        className={className}
        onClick={(e) => {
          const s = other ?? useStore.getState();
          openSignIn({ provider, account: account?.id ?? "default", accountLabel: account?.label ?? null, machineKey: other ? machineKey! : active, machine: s.conn ? machineName(s.conn, s.hub) : "the machine", opener: e.currentTarget });
        }}
      >
        Sign in to {name}
      </button>
    );
  }
  return (
    <button
      className={className}
      onClick={() => {
        onLeave?.();
        // Asked for before the machine is switched: Settings opens anew for it and scrolls to that agent's card.
        showInSettings(`agent-${provider}`);
        if (other) useStore.getState().activate(machineKey!);
        useStore.getState().setView("settings");
      }}
    >
      {status?.installed ? `Set up ${name}` : `Install ${name}`}
    </button>
  );
}
