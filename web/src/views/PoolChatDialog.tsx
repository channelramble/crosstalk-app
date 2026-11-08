// Tapping the model pool in New chat. Running, that's the ordinary New chat dialog with the pool's account and model
// already chosen (NewChatDialog). Any other state, this says which state it's in and offers the one thing a person
// would want next: start the pool and then the chat (saying first what starting does and that it takes a while), check
// the machines again when one of them didn't answer last time, or Settings → Model pool to set it up or see what's
// wrong. Nothing is ever started on a machine without the tap on the button here (poolChat.ts has the words).

import { useEffect, useRef, useState } from "react";
import { PROVIDER_INFO } from "@crosstalk/shared";
import { showInSettings } from "../navigation";
import type { NewChatTarget } from "../newChat";
import { poolAction, poolAsk, poolStateWords } from "../poolChat";
import { hubStore, useMachines, useStore } from "../store";
import { Dialog, ServiceAvatar } from "../ui";
import { NewChatDialog } from "./AgentScreen";

/** Settings → Model pool, on the machine the pool is set up on. */
function openModelPool(machine: string) {
  showInSettings("model-pool");
  useStore.getState().activate(machine);
  useStore.getState().setView("settings");
}

/**
 * A chat on the model pool. `target.offer` is the pool as the menu saw it; the live offer is followed from the store,
 * so a pool that becomes ready while this is open (the person just started it) turns into the New chat dialog.
 */
export function PoolChatDialog({ target, folders = [], onClose }: { target: Extract<NewChatTarget, { kind: "pool" }>; folders?: string[]; onClose: () => void }) {
  // The pool's own machine, not whichever one is open: a chat started from the chat list's heading may be on another.
  const [machine] = useState(() => target.machine ?? useStore.getState().active);
  const machines = useMachines((m) => m.list);
  // That machine's pool as it stands now, so a pool someone starts (here or in Settings) moves this dialog along.
  const live = machines.find((m) => m.key === machine)?.poolOffer ?? null;
  const offer = live ?? target.offer;
  /** What the button is doing right now: starting the pool, or checking its machines. */
  const [busy, setBusy] = useState<"start" | "check" | null>(null);
  const [error, setError] = useState("");
  /** What the error is about, so the box says which of the two went wrong. */
  const [failed, setFailed] = useState<"start" | "check">("start");
  /** A check of ours came back: said here, because a machine that still doesn't answer changes nothing on screen. */
  const [checked, setChecked] = useState(false);
  /** Set by the Start button: the dialog then waits for the pool, and a start that fails is said here. */
  const asked = useRef(false);
  const action = poolAction(offer);
  const ask = poolAsk(offer);

  // A start of our own that ended in a problem: said here, with the way out (the pool's own words say what went wrong).
  useEffect(() => {
    if (asked.current && offer.state === "error") setError(offer.detail ?? "The model pool couldn't start.");
  }, [offer.state, offer.detail]);

  if (offer.ready) return <NewChatDialog target={{ ...target, offer }} folders={folders} onClose={onClose} />;

  /** Asked of the machine the pool belongs to (its hub does the work), whichever machine is open here. */
  const call = async (what: "start" | "check", path: string, timeoutMs: number) => {
    setBusy(what);
    setError("");
    setFailed(what);
    setChecked(false);
    if (what === "start") asked.current = true;
    try {
      const hub = hubStore(machine);
      if (!hub) throw new Error("That machine isn't connected. Pick it at the top of Settings and try again.");
      await hub.getState().poolCall("POST", path, undefined, timeoutMs);
      if (what === "check") setChecked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const act = () => {
    if (action === "start") return void call("start", "/api/pool/start", 30_000);
    // A machine that didn't answer the last time Crosstalk looked may well answer now: the check happens here, and a
    // pool whose machines all answer then offers the start (nothing starts without that second tap).
    if (action === "fix") return void call("check", "/api/pool/check", 90_000);
    onClose();
    openModelPool(machine);
  };

  return (
    <Dialog
      title={`New chat with ${offer.label}`}
      icon={<ServiceAvatar where="pool" label={offer.label} />}
      onClose={onClose}
      footer={(requestClose) => (
        <>
          <button className="btn" onClick={() => requestClose()}>
            Cancel
          </button>
          <button className="btn primary" onClick={act} disabled={!!busy}>
            {busy === "start" ? "Starting…" : busy === "check" ? "Checking…" : ask.button}
          </button>
        </>
      )}
    >
      <p className="help" style={{ marginTop: 0 }}>
        {/* The state is read out as it changes: a start takes minutes, and this is the only place it's said here. */}
        <span role="status">{poolStateWords(offer)}</span>
        {offer.model ? ` · ${offer.model}` : ""}
        {` · driven by ${PROVIDER_INFO[target.provider].name}`}
      </p>
      <p className="small" style={{ margin: "2px 0 0" }}>
        {ask.words}
      </p>
      {/* Not while it's stopping: then nothing is on its way, and the words above say so. */}
      {asked.current && !error && offer.state !== "stopping" && (busy === "start" || action === "watch") && (
        <p className="help" style={{ margin: "10px 0 0" }}>
          This stays open: your chat starts as soon as the pool is running. Settings → Model pool shows every step.
        </p>
      )}
      {checked && !busy && !error && action === "fix" && (
        <p className="help" style={{ margin: "10px 0 0" }} role="status">
          Checked just now, and it still doesn't answer. Settings → Model pool says more.
        </p>
      )}
      {action === "fix" && !error && (
        <button
          type="button"
          className="link-btn small"
          style={{ marginTop: 8 }}
          onClick={() => {
            onClose();
            openModelPool(machine);
          }}
        >
          Open Model pool
        </button>
      )}
      {error && (
        <div role="alert" className="defaults-failed">
          <p className="small" style={{ margin: 0, fontWeight: 600 }}>
            {failed === "check" ? `Couldn't check ${offer.label}'s machines` : `Couldn't start ${offer.label}`}
          </p>
          <p className="help" style={{ margin: "2px 0 8px" }}>{error}</p>
          <button
            className="btn small"
            onClick={() => {
              onClose();
              openModelPool(machine);
            }}
          >
            Open Model pool
          </button>
        </div>
      )}
    </Dialog>
  );
}
