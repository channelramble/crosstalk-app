import { useState, type ReactNode } from "react";
import { Square } from "lucide-react";
import { STOP_FAILED, stopChat, useStopping } from "../stop";
import { useStore } from "../store";
import { Dialog } from "../ui";

/**
 * What can't be undone (history leaving the chat), asked twice: what happens, then whether you're sure. While the agent
 * works (`busy`), it says so with a button to stop it (in `roomId`'s chat); Continue works once it has stopped.
 */
export function TwoStepDialog({ title, detail, sure, confirmLabel, workingLabel, icon, agentName, group = false, busy = false, roomId, onConfirm, onClose }: { title: string; detail: string; sure: string; confirmLabel: string; workingLabel: string; icon: ReactNode; agentName: string; group?: boolean; busy?: boolean; roomId?: string; onConfirm: () => Promise<unknown>; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const stopping = useStopping((s) => !!roomId && !!s.rooms[roomId]);
  const [isSure, setSure] = useState(false);
  const [working, setWorking] = useState(false);
  const go = async () => {
    setWorking(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
      setWorking(false);
    }
  };
  const stop = async () => {
    if (roomId && !(await stopChat(roomId))) toast("error", STOP_FAILED);
  };
  return (
    <Dialog
      title={isSure ? "Are you sure?" : title}
      step={isSure ? 2 : 1}
      icon={icon}
      onClose={() => !working && onClose()}
      footer={
        <div className="row" style={{ gap: 8, justifyContent: "flex-end", width: "100%" }}>
          <button className="btn small" disabled={working} onClick={onClose}>
            Cancel
          </button>
          {isSure ? (
            <button className="btn small danger" disabled={working || busy} onClick={go}>
              {working ? workingLabel : confirmLabel}
            </button>
          ) : (
            <button className="btn small primary" disabled={busy} onClick={() => setSure(true)}>
              Continue
            </button>
          )}
        </div>
      }
    >
      <p className="small" style={{ margin: 0 }}>
        {isSure ? sure : detail}
      </p>
      {busy && (
        <div className="row wrap two-step-busy" role="status">
          <span className="small muted">{stopping ? `Stopping ${group ? "the agents" : agentName}…` : group ? "An agent is working: stop it first." : `${agentName} is working: stop it first.`}</span>
          {roomId && (
            <button className="btn small" disabled={stopping} onClick={stop}>
              <Square size={11} fill="currentColor" /> {stopping ? "Stopping…" : group ? "Stop the agents" : `Stop ${agentName}`}
            </button>
          )}
        </div>
      )}
    </Dialog>
  );
}
