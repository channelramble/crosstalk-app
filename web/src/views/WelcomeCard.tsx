import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { CHAT_PROVIDERS, PROVIDER_INFO, type ChatProvider } from "@crosstalk/shared";
import { showInSettings } from "../navigation";
import { useSidebar } from "../sidebar";
import { agentReady, agentSignedIn, useMachines, useStore } from "../store";
import { firstChatTarget } from "../newChat";
import { openSignIn } from "../signInSheet";
import { PHONE_SIGN_IN } from "../signIn";
import { machineName } from "../store";
import { InstallBox, useAgentInstall } from "./AgentInstall";
import { onlyThisMachine, PairDialog } from "./DevicesPage";
import { AgentSignInButton } from "./AgentSignInButton";
import { useChatStarters } from "./NewChatMenu";
import { dismissWelcome, nextWelcomeStep, welcomeDismissed, welcomeShows, welcomeSteps } from "../welcome";

/**
 * First run, at the top of Home: three steps to a first chat, until skipped or all done (welcome.ts). Each step's state
 * comes from what the app already knows, so it follows you without asking the hub anything. Only a skip is kept, on
 * this device.
 */
export function WelcomeCard() {
  const loaded = useStore((s) => s.loadedAt !== null);
  const setView = useStore((s) => s.setView);
  const setCreating = useSidebar((s) => s.setCreating);
  const machines = useMachines((m) => m.list);
  const [dismissed, setDismissed] = useState(() => welcomeDismissed());
  // What a new chat starts with: the first agent that's signed in on any machine (the dialog asks which machine), or
  // for someone with no plan who added an AI service, that service (newChat.ts firstChatTarget). Never an agent that
  // would open on a signed-out account while a service of theirs could answer.
  const services = useChatStarters(false).services;
  const first = firstChatTarget({
    own: CHAT_PROVIDERS.filter((p) => machines.some((m) => agentSignedIn(m, p))),
    services,
    ready: CHAT_PROVIDERS.filter((p) => machines.some((m) => agentReady(m, p))),
  });
  const ready = !!first;
  const steps = useMemo(
    () => welcomeSteps({ signedIn: ready, rooms: machines.flatMap((m) => Object.values(m.rooms)), activity: Object.assign({}, ...machines.map((m) => m.roomActivity)) }),
    [ready, machines],
  );
  const finished = loaded && nextWelcomeStep(steps) === null;
  // All three done once is done for good on this device: deleting the chats later doesn't bring the card back.
  useEffect(() => {
    if (finished && !dismissed) {
      dismissWelcome();
      setDismissed(true);
    }
  }, [finished, dismissed]);
  if (!welcomeShows({ loaded, dismissed, steps })) return null;

  const next = nextWelcomeStep(steps);
  const skip = () => {
    dismissWelcome();
    setDismissed(true);
  };
  return (
    <section className="card welcome" aria-labelledby="welcome-title">
      <div className="welcome-head">
        <h2 className="welcome-title" id="welcome-title">
          Welcome to Crosstalk
        </h2>
        <button className="btn small ghost" onClick={skip} aria-label="Skip the welcome steps">
          Skip
        </button>
      </div>
      <p className="welcome-lede">Three quick steps to your first chat.</p>
      <ol className="welcome-steps">
        {steps.map((s, i) => (
          <li key={s.id} className="welcome-step" data-done={s.done}>
            <span className="welcome-mark" aria-hidden="true">
              {s.done ? <Check size={16} strokeWidth={3} /> : i + 1}
            </span>
            <div className="welcome-body">
              <h3>
                {s.title}
                {s.done && <span className="welcome-sr">, done</span>}
              </h3>
              <p>{s.text}</p>
              {s.id === next &&
                (s.id === "signin" ? (
                  // Each agent's own Sign in, right here (it opens the sign-in sheet); other services are in Settings.
                  <div className="welcome-actions">
                    {CHAT_PROVIDERS.map((p) => (
                      <SetUpAgent key={p} provider={p} className={p === CHAT_PROVIDERS[0] ? "btn primary" : "btn"} />
                    ))}
                    <button
                      className="btn ghost small"
                      onClick={() => {
                        showInSettings("ai-services");
                        setView("settings");
                      }}
                    >
                      Use another kind of account
                    </button>
                  </div>
                ) : (
                  <button className="btn primary" onClick={() => first && setCreating(first)}>
                    Start a chat
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ol>
      <WelcomeAlso />
    </section>
  );
}

/**
 * One more thing worth doing, by where the app is open: on the machine itself (the installer opens it there), pairing
 * a phone; on a phone, notifications. A quiet line, not a step: the card finishes without it.
 */
function WelcomeAlso() {
  const setView = useStore((s) => s.setView);
  const [pairing, setPairing] = useState(false);
  const here = typeof location !== "undefined" && onlyThisMachine(location.origin);
  const ios = typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
  const installed = typeof navigator !== "undefined" && (!!(navigator as Navigator & { standalone?: boolean }).standalone || (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches));
  const canAsk = typeof Notification !== "undefined" && Notification.permission === "default";
  if (here)
    return (
      <p className="welcome-also">
        To use it from your phone:{" "}
        <button className="link-btn" onClick={() => setPairing(true)}>
          Pair a phone
        </button>
        {pairing && <PairDialog onClose={() => setPairing(false)} />}
      </p>
    );
  if (ios && !installed) return <p className="welcome-also">To get notifications on an iPhone, add Crosstalk to your Home Screen (Share → Add to Home Screen) and open it from its icon.</p>;
  if (canAsk)
    return (
      <p className="welcome-also">
        To hear when an agent finishes or needs you:{" "}
        <button
          className="link-btn"
          onClick={() => {
            showInSettings("notifications");
            setView("settings");
          }}
        >
          Turn on notifications
        </button>
      </p>
    );
  return null;
}

/**
 * One tap from nothing to signing in: an agent that isn't on the machine yet is installed right here (its official
 * installer, followed on the card), and its sign-in opens by itself the moment it's in. One that's installed gets its
 * Sign in button as everywhere else.
 */
function SetUpAgent({ provider, className }: { provider: ChatProvider; className: string }) {
  const status = useStore((s) => s.providers[provider]);
  const sheet = useStore((s) => s.signIns !== null) && PHONE_SIGN_IN.includes(provider);
  const install = useAgentInstall(provider);
  const name = PROVIDER_INFO[provider].name;
  // Its sign-in opens once for an install this card started (not for one that was already there, or ran elsewhere).
  const started = useRef(false);
  const opened = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!started.current || opened.current || install.phase !== "done" || !status?.installed || !sheet) return;
    opened.current = true;
    const s = useStore.getState();
    openSignIn({ provider, account: "default", accountLabel: null, machineKey: s.active, machine: s.conn ? machineName(s.conn, s.hub) : "the machine", opener: button.current });
  }, [install.phase, status?.installed, sheet, provider]);
  if (status?.installed && install.phase !== "running" && install.phase !== "checking") return <AgentSignInButton provider={provider} className={className} />;
  // A machine from before signing in from the phone: Settings has its way.
  if (!sheet) return <AgentSignInButton provider={provider} className={className} />;
  const busy = install.phase === "starting" || install.phase === "running" || install.phase === "checking";
  return (
    <div className="welcome-setup">
      {!busy && install.phase !== "failed" && (
        <button
          ref={button}
          className={className}
          onClick={() => {
            started.current = true;
            void install.start();
          }}
        >
          Set up {name}
        </button>
      )}
      {(install.phase !== "idle" || install.problem) && <InstallBox install={install} says={{ running: "Its sign-in opens when it's in.", done: "" }} fallback={`You can also install it from Settings → Accounts → ${name}.`} />}
    </div>
  );
}
