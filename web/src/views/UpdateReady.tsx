// On Home and at the top of Settings, for the machine on screen: a newer version of Crosstalk is available (Update), it's
// downloading (how far), it didn't download (why, and Try again), or it's ready and waits for the chats to go quiet
// (what it waits for, and Restart now). Nothing shows when the machine runs the newest version it knows of.
// hub/src/selfUpdate.ts downloads it; hub/src/update.ts starts it.

import { useState, type CSSProperties } from "react";
import { ArrowUpCircle, X } from "lucide-react";
import { installWords, updateWords, type HubUpdate, type UpdateInstall } from "@crosstalk/shared";
import { api, type Connection } from "../api";
import { machineName, useMachines, useStore } from "../store";
import { Dialog } from "../ui";
import { saidLater, sayLater, useUpdate } from "../updates";

export function UpdateReady() {
  const key = useStore((s) => s.active);
  const conn = useStore((s) => s.conn);
  const update = useStore((s) => s.hub?.update ?? null);
  const release = useStore((s) => s.hub?.release ?? null);
  const machine = useStore((s) => (s.conn ? machineName(s.conn, s.hub) : "this machine"));
  const several = useMachines((m) => m.list.length > 1);
  const { start, starting, running } = useUpdate(key, conn, release);
  // Read as it's shown (it's per machine); the count only makes "Later" show at once.
  const [, setLaters] = useState(0);
  const later = saidLater(key);
  if (update) {
    return (
      <section className="card update-ready" aria-label="Update">
        <ArrowUpCircle size={18} aria-hidden="true" />
        <p className="update-ready-text" role="status">
          {updateWords(update)}
        </p>
        <span className="update-ready-actions">
          <RestartNow update={update} machine={machine} conn={conn} />
        </span>
      </section>
    );
  }
  const install = release?.install ?? null;
  if (running && install) {
    return (
      <section className="card update-ready" aria-label="Update">
        <ArrowUpCircle size={18} aria-hidden="true" />
        <InstallProgress install={install} />
      </section>
    );
  }
  const version = install?.version || release?.available;
  // Nothing newer, or "Later" was said to this one here.
  if (!version || later === version) return null;
  const dismiss = () => {
    sayLater(key, version);
    setLaters((n) => n + 1);
  };
  return (
    <section className="card update-ready" aria-label="Update">
      <ArrowUpCircle size={18} aria-hidden="true" />
      <p className="update-ready-text" role="status">
        {install ? (
          <>
            Crosstalk {version} didn't install{several ? ` on ${machine}` : ""}. <span className="update-ready-why">{installWords(install)}</span>
          </>
        ) : (
          `Crosstalk ${version} is available${several ? ` for ${machine}` : ""}.`
        )}
      </p>
      <span className="update-ready-actions">
        <button className="btn small primary" disabled={starting} onClick={() => void start()}>
          {install ? "Try again" : "Update"}
        </button>
        <button className="icon-btn update-ready-later" aria-label="Later" title="Later" onClick={dismiss}>
          <X size={18} aria-hidden="true" />
        </button>
      </span>
    </section>
  );
}

/** A download's progress: what it's doing, and how far along while it downloads. */
export function InstallProgress({ install }: { install: UpdateInstall }) {
  return (
    <div className="update-progress">
      <p className="update-ready-text" role="status">
        {installWords(install)}
      </p>
      <span className="upload-bar" aria-hidden="true" style={{ "--fill": install.step === "verifying" ? 1 : (install.percent ?? 0) / 100 } as CSSProperties}>
        <span />
      </span>
    </div>
  );
}

/**
 * Restart now, on an update that waits for work to finish, asked once more first. With nothing working it starts by
 * itself within two minutes: the button is for not waiting on work.
 */
export function RestartNow({ update, machine, conn }: { update: HubUpdate; machine: string; conn: Connection | null }) {
  const toast = useStore((s) => s.toast);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!update.working || update.restarting) return null;
  const restart = async () => {
    setBusy(true);
    try {
      await api("POST", "/api/update/restart", undefined, conn);
      setAsking(false);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn small" onClick={() => setAsking(true)}>
        Restart now
      </button>
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
    </>
  );
}
