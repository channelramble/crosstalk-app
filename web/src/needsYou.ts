// Settings → Needs you: the short card at the top of Settings, one row per thing only the person can do, each with a
// button that does it (or takes them to it) right there. Built from what the app already knows: each agent's install
// and sign-in state, the accounts a chat's reply stopped on, the Mac's waiting dialogs, and the hub's setup checklist
// (hub/src/setup/checklist.ts) for the rest. Never a shell command: an item whose only fix is a command stays in
// Machines → Advanced → Set up with an AI agent. Pure, for the unit tests; views/SettingsIndex.tsx draws it.
import { CHAT_PROVIDERS, PROVIDER_INFO, pageForSection, type AgentAccount, type MacDialog, type Provider, type ProviderStatus, type SetupChecklist, type SignInNeed } from "@crosstalk/shared";
import { signInsShown } from "./signIn";

export type NeedAction =
  /** Opens the sign-in sheet for that account. */
  | { kind: "signin"; provider: Provider; account: string; accountLabel: string | null }
  /** Installs the agent on the machine, followed right in the row. */
  | { kind: "install"; provider: Provider }
  /** Opens the section of Settings where it's answered. */
  | { kind: "show"; section: string };

export interface Need {
  id: string;
  title: string;
  /** One line under it. */
  detail: string;
  /** What its button says. */
  button: string;
  action: NeedAction;
}

export interface NeedsInput {
  machine: string;
  providers: Partial<Record<Provider, ProviderStatus>>;
  accounts: Record<string, AgentAccount>;
  /** Accounts found signed out when a chat's reply failed on them; null from a machine that can't sign in from here. */
  signIns: readonly SignInNeed[] | null;
  macDialogs: readonly MacDialog[];
  /** The hub's checklist; null until it's read, and from a machine without one. */
  list: SetupChecklist | null;
  /** The machine says an update is waiting (HubInfo.update), and the card above Needs you shows it. */
  updateShown?: boolean;
}

const ready = (x: NeedsInput, p: Provider) => !!x.providers[p]?.installed && (!!x.providers[p]?.signedIn || Object.values(x.accounts).some((a) => a.provider === p && a.signedIn));

export function needsYou(x: NeedsInput): Need[] {
  const out: Need[] = [];
  // A question on the Mac's screen stops whatever asked it until someone answers: first.
  if (x.macDialogs.length) {
    const first = x.macDialogs[0];
    const more = x.macDialogs.length - 1;
    out.push({
      id: "mac.dialogs",
      title: `${x.machine} is waiting for an answer on its screen`,
      detail: `${first.app} wants ${first.wants}${more > 0 ? `, and ${more} more` : ""}.`,
      button: "See it",
      action: { kind: "show", section: "this-mac" },
    });
  }
  // Accounts a chat's reply stopped on: those chats wait for the sign-in.
  const stopped = signInsShown([...(x.signIns ?? [])]);
  for (const n of stopped) {
    const name = PROVIDER_INFO[n.provider].name;
    const chats = n.rooms.length;
    out.push({
      id: `signin.${n.provider}.${n.account}`,
      title: `${name}${n.accountLabel ? ` · ${n.accountLabel}` : ""} isn't signed in`,
      detail: chats ? `${chats === 1 ? "A chat" : `${chats} chats`} stopped on it and can't answer until it's signed in again.` : "Its chats can't answer until it's signed in again.",
      button: "Sign in",
      action: { kind: "signin", provider: n.provider, account: n.account, accountLabel: n.accountLabel },
    });
  }
  // The agents themselves, as the checklist counts them: one that's installed but signed out needs its sign-in; one
  // that isn't installed is needed only while no agent is ready at all.
  const any = CHAT_PROVIDERS.some((p) => ready(x, p));
  for (const p of CHAT_PROVIDERS) {
    const st = x.providers[p];
    if (!st?.checkedAt || ready(x, p)) continue;
    const name = PROVIDER_INFO[p].name;
    if (!st.installed) {
      if (!any) out.push({ id: `install.${p}`, title: `${name} isn't installed`, detail: `Install it on ${x.machine} to chat with it.`, button: "Install", action: { kind: "install", provider: p } });
    } else if (st.signedIn === false && !stopped.some((n) => n.provider === p && n.account === "default")) {
      out.push({ id: `signin.${p}.default`, title: `${name} isn't signed in`, detail: `Sign in with your plan to chat with ${name} on ${x.machine}.`, button: "Sign in", action: { kind: "signin", provider: p, account: "default", accountLabel: null } });
    }
  }
  // The rest of the checklist: what's needed, waits on the person or isn't done, and has a place in Settings where
  // it's done. (The agents and the Mac's dialogs are said above, live.)
  for (const i of x.list?.items ?? []) {
    if (i.optional || (i.state !== "user" && i.state !== "missing")) continue;
    if (i.id.startsWith("agent.") || i.id === "mac.dialogs") continue;
    // An update that waits for the chats to go quiet says so itself, with Restart now (views/UpdateReady.tsx).
    if (i.id === "version" && x.updateShown) continue;
    // A newer build that waits for a restart: where its version and what's left are. What the checklist says of an
    // item "above" it in its own list is left out: there's no list here.
    const section = i.id === "version" ? "advanced" : i.fix?.target && pageForSection(i.fix.target) ? i.fix.target : null;
    if (!section) continue;
    out.push({ id: i.id, title: i.id === "version" ? "Crosstalk update" : i.title, detail: i.detail.replace(/\s*[^.]*\(above\)\./g, ""), button: "See it", action: { kind: "show", section } });
  }
  return out;
}
