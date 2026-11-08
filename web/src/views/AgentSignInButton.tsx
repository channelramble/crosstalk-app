// One tap from "this agent isn't signed in" to signing it in: the sign-in sheet (views/SignIn.tsx), on the machine on
// screen, for its own sign-in. An agent the sheet can't sign in (not installed yet, or a hub from before phone sign-in)
// gets Settings, at that agent.

import type { ChatProvider } from "@crosstalk/shared";
import { PROVIDER_INFO } from "@crosstalk/shared";
import { showInSettings } from "../navigation";
import { openSignIn } from "../signInSheet";
import { PHONE_SIGN_IN } from "../signIn";
import { machineName, useStore } from "../store";

export function AgentSignInButton({ provider, className = "btn primary" }: { provider: ChatProvider; className?: string }) {
  const status = useStore((s) => s.providers[provider]);
  const sheet = useStore((s) => s.signIns !== null) && PHONE_SIGN_IN.includes(provider);
  const name = PROVIDER_INFO[provider].name;
  if (status?.installed && sheet) {
    return (
      <button
        className={className}
        onClick={(e) => {
          const s = useStore.getState();
          openSignIn({ provider, account: "default", accountLabel: null, machineKey: s.active, machine: s.conn ? machineName(s.conn, s.hub) : "the hub", opener: e.currentTarget });
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
        showInSettings(`agent-${provider}`);
        useStore.getState().setView("settings");
      }}
    >
      {status?.installed ? `Set up ${name}` : `Install ${name}`}
    </button>
  );
}
