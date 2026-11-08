import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { CHAT_PROVIDERS } from "@crosstalk/shared";
import { showInSettings } from "../navigation";
import { useSidebar } from "../sidebar";
import { agentReady, useMachines, useStore } from "../store";
import { AgentSignInButton } from "./AgentSignInButton";
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
  // The agent a new chat starts with: the first that's ready on any machine (the dialog asks which machine).
  const agent = CHAT_PROVIDERS.find((p) => machines.some((m) => agentReady(m, p)));
  const steps = useMemo(() => welcomeSteps({ signedIn: !!agent, rooms: machines.flatMap((m) => Object.values(m.rooms)) }), [agent, machines]);
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
                      <AgentSignInButton key={p} provider={p} className={p === CHAT_PROVIDERS[0] ? "btn primary" : "btn"} />
                    ))}
                    <button
                      className="btn ghost small"
                      onClick={() => {
                        showInSettings("ai-services");
                        setView("settings");
                      }}
                    >
                      Use another AI service
                    </button>
                  </div>
                ) : (
                  <button className="btn primary" onClick={() => agent && setCreating({ kind: "agent", provider: agent })}>
                    Start a chat
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
