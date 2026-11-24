// On Home, while a new build of Crosstalk is in place on the machine and waits for its chats to go quiet
// (hub/src/update.ts): what it waits for, and Restart now. Nothing shows when the machine runs its newest build.

import { useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import { updateWords } from "@crosstalk/shared";
import { api } from "../api";
import { machineName, useStore } from "../store";
import { Dialog } from "../ui";

export function UpdateReady() {
  const update = useStore((s) => s.hub?.update ?? null);
  const machine = useStore((s) => (s.conn ? machineName(s.conn, s.hub) : "this machine"));
  const toast = useStore((s) => s.toast);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!update) return null;
  const restart = async () => {
    setBusy(true);
    try {
      await api("POST", "/api/update/restart");
      setAsking(false);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card update-ready" aria-label="Update">
      <ArrowUpCircle size={18} aria-hidden="true" />
      <p className="update-ready-text" role="status">
        {updateWords(update)}
      </p>
      {/* With nothing working it starts by itself within two minutes: the button is for not waiting on work. */}
      {update.working > 0 && !update.restarting && (
        <button className="btn small" onClick={() => setAsking(true)}>
          Restart now
        </button>
      )}
      {asking && (
        <Dialog
          title={`Restart ${machine} now?`}
          icon={<ArrowUpCircle size={18} />}
          onClose={() => !busy && setAsking(false)}
          footer={
            <div className="row" style={{ gap: 8, justifyContent: "flex-end", width: "100%" }}>
              <button className="btn small" disabled={busy} onClick={() => setAsking(false)}>
                Wait for them
              </button>
              <button className="btn small primary" disabled={busy} onClick={restart}>
                {busy ? "Restarting…" : "Restart now"}
              </button>
            </div>
          }
        >
          <p className="small" style={{ margin: 0 }}>
            This stops what's working in {update.chats.join(", ")}
            {update.working > update.chats.length ? ` and ${update.working - update.chats.length} more` : ""}. Replies that were running pick up where they left off once {machine} is back, in a few seconds. Background work an agent started stops with it, and the agent is told when it carries on.
          </p>
        </Dialog>
      )}
    </section>
  );
}
