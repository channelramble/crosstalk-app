// Settings → Machines → Updates: for each machine in the app, the version of Crosstalk it runs, whether a newer one is
// available (Update), a download's progress, an update that's ready (Restart now), Check now, and what's new in the
// version on offer (the release's notes). hub/src/selfUpdate.ts does the work, on that machine.

import { useEffect, useState } from "react";
import { installWords, updateWords, type UpdateStatus } from "@crosstalk/shared";
import { api, ApiError } from "../api";
import { useMachines, type Machine } from "../store";
import { Markdown, timeAgo } from "../ui";
import { noteUpdate, useUpdate } from "../updates";
import { InstallProgress, RestartNow } from "./UpdateReady";

const NO_HANDLES: string[] = [];

export function MachineUpdates() {
  const machines = useMachines((m) => m.list);
  return (
    <div className="machine-updates">
      {machines.map((m) => (
        <MachineUpdate key={m.key} machine={m} named={machines.length > 1} />
      ))}
    </div>
  );
}

function MachineUpdate({ machine: m, named }: { machine: Machine; named: boolean }) {
  const release = m.hub?.release;
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  // "Check now" was tapped: only then does a machine that couldn't reach GitHub say so.
  const [asked, setAsked] = useState<"checking" | "failed" | "done" | null>(null);
  const [old, setOld] = useState(false);
  const { start, starting, running } = useUpdate(m.key, m.conn, release);
  const open = m.status === "open";
  // Asked again whenever what the machine says about its updates changes (a download ended, one became ready).
  const said = JSON.stringify([release?.available ?? null, release?.install?.step ?? null, m.hub?.update?.version ?? null, m.hub?.version ?? null]);
  useEffect(() => {
    if (!open) return;
    let gone = false;
    api<UpdateStatus>("GET", "/api/update", undefined, m.conn)
      .then((s) => {
        if (gone) return;
        setStatus(s);
        setOld(false);
        noteUpdate(m.key, s);
      })
      // A machine on a version from before updates came from the app has no such address. Anything else (it dropped
      // off for a moment) is asked again when it's back.
      .catch((e) => !gone && e instanceof ApiError && e.status === 404 && setOld(true));
    return () => {
      gone = true;
    };
  }, [open, said, m.key, m.conn]);
  const check = async () => {
    if (asked === "checking") return;
    setAsked("checking");
    try {
      const s = await api<UpdateStatus>("POST", "/api/update/check", undefined, m.conn);
      setStatus(s);
      noteUpdate(m.key, s);
      setAsked(s.checkFailed ? "failed" : "done");
    } catch {
      setAsked("failed");
    }
  };

  const version = m.hub?.version ?? status?.version ?? null;
  const install = release?.install ?? null;
  const ready = m.hub?.update ?? null;
  const available = release?.available ?? null;
  const can = status?.can ?? false;
  let line: string;
  let tone = "";
  if (!open) line = m.status === "connecting" ? "Connecting…" : "Can't reach it right now.";
  else if (ready) line = updateWords(ready);
  else if (running && install) line = "";
  else if (install) [line, tone] = [`Crosstalk ${install.version || "update"} didn't install. ${installWords(install)}`, "bad"];
  else if (available) [line, tone] = [`Crosstalk ${available} is available.`, "new"];
  else if (old) line = `Updates from the app start with a newer version. Run the installer on ${m.name} once to get it.`;
  else if (!status) line = "…";
  else if (!status.can) line = status.why ?? "Crosstalk can't update itself on this machine.";
  else if (asked === "failed") [line, tone] = [`Couldn't check: ${m.name} couldn't reach GitHub. It may be offline.`, "bad"];
  else if (asked === "checking" && !status.checkedAt) line = "Checking…";
  else if (status.checkedAt && !status.checkFailed) line = `Up to date. Checked ${timeAgo(status.checkedAt)}.`;
  else if (status.checkedAt) line = `Up to date when last checked, ${timeAgo(status.checkedAt)}.`;
  else line = "Not checked yet.";

  return (
    <section className="card machine-update" aria-label={named ? `Updates for ${m.name}` : "Updates"}>
      <div className="machine-update-head">
        <div className="machine-update-text">
          <div className="machine-update-name">
            {named ? `${m.name} · ` : ""}Crosstalk {version ?? "…"}
          </div>
          {running && install ? (
            <InstallProgress install={install} />
          ) : (
            <p className={`machine-update-line ${tone}`} role="status">
              {line}
            </p>
          )}
        </div>
        {open && (
          <div className="machine-update-actions">
            {ready ? (
              <RestartNow update={ready} machine={m.name} conn={m.conn} />
            ) : (
              <>
                {can && !running && (install || available) && (
                  <button className="btn small primary" disabled={starting} onClick={() => void start()}>
                    {install ? "Try again" : "Update"}
                  </button>
                )}
                {can && !running && (
                  <button className="btn small" aria-disabled={asked === "checking" || undefined} onClick={() => void check()}>
                    {asked === "checking" ? "Checking…" : "Check now"}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {open && available && status?.notes && (
        <div className="machine-update-notes">
          <div className="machine-update-notes-title">What's new in {available}</div>
          <div className="machine-update-notes-text" tabIndex={0} role="group" aria-label={`What's new in ${available}`}>
            <Markdown text={status.notes} handles={NO_HANDLES} />
          </div>
        </div>
      )}
    </section>
  );
}
