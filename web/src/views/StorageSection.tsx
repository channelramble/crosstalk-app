import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { HubSettings, StorageItem, StorageReport, StorageSettings } from "@crosstalk/shared";
import { api } from "../api";
import { useStore } from "../store";
import { AskTwiceDialog, Stepper, Switch, formatBytes, timeAgo } from "../ui";
import { useReconnected } from "../useReconnected";
import { useMachineName } from "./MachinePicker";

const KIND: Record<StorageItem["kind"], { label: string; pill: string }> = {
  build: { label: "Build files", pill: "blue" },
  upload: { label: "Sent by you", pill: "" },
  large: { label: "Check first", pill: "orange" },
};

const BUSY: Record<NonNullable<StorageReport["busy"]>, string> = {
  scanning: "Measuring the chat folders…",
  cleaning: "Clearing caches…",
  deleting: "Deleting…",
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings → Storage: the hub's disk, what it clears on its own, and the big things in chat folders to delete. */
export function StorageSection() {
  const toast = useStore((s) => s.toast);
  const machine = useMachineName();
  const [report, setReport] = useState<StorageReport | null>(null);
  const [settings, setSettings] = useState<StorageSettings | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [confirming, setConfirming] = useState<StorageItem[] | null>(null);
  // What finished work to report once the hub is done: anything newer than these.
  const waiting = useRef<{ kind: "clean" | "delete"; after: number } | null>(null);

  const load = async (rescan = false) => {
    try {
      const r = await api<StorageReport>("GET", `/api/storage${rescan ? "?rescan=1" : ""}`);
      setReport(r);
      setError("");
    } catch (e) {
      setError(message(e));
    }
  };
  const loadSettings = () => {
    setSettingsError("");
    api<HubSettings>("GET", "/api/settings/hub")
      .then((s) => setSettings(s.storage))
      .catch((e) => setSettingsError(message(e)));
  };
  useEffect(() => {
    void load();
    loadSettings();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Back after the hub restarted, say: what couldn't load comes in.
  useReconnected(() => {
    void load();
    if (!settings) loadSettings();
  });
  // While the hub measures, clears or deletes, check back every 2 seconds; then say how it went.
  useEffect(() => {
    if (!report) return;
    if (report.busy) {
      const t = setTimeout(() => void load(), 2000);
      return () => clearTimeout(t);
    }
    const w = waiting.current;
    if (!w) return;
    if (w.kind === "clean") {
      const freed = report.cleared.filter((c) => c.at > w.after && c.auto).reduce((n, c) => n + c.bytes, 0);
      toast("info", freed ? `Cleared ${formatBytes(freed)}.` : "Nothing to clear right now.");
    } else if (report.lastDelete && report.lastDelete.at > w.after) {
      const d = report.lastDelete;
      if (d.removed) toast("info", `Deleted ${d.removed} ${d.removed === 1 ? "item" : "items"} (${formatBytes(d.bytes)}).`);
      for (const f of d.failed) toast("error", `${f.name}: ${f.error}`);
    }
    waiting.current = null;
  }, [report]); // eslint-disable-line react-hooks/exhaustive-deps

  const put = async (next: StorageSettings) => {
    setSettings(next);
    try {
      const s = await api<HubSettings>("PUT", "/api/settings/hub", { storage: next });
      setSettings(s.storage);
      void load();
    } catch (e) {
      toast("error", message(e));
    }
  };
  const clean = async () => {
    try {
      waiting.current = { kind: "clean", after: report?.cleared[0]?.at ?? 0 };
      setReport(await api<StorageReport>("POST", "/api/storage/clean"));
    } catch (e) {
      waiting.current = null;
      toast("error", message(e));
    }
  };
  /** Deletes what's picked, once it's been asked twice (the dialog below). */
  const remove = async (items: StorageItem[]) => {
    waiting.current = { kind: "delete", after: report?.lastDelete?.at ?? 0 };
    try {
      setReport(await api<StorageReport>("POST", "/api/storage/delete", { ids: items.map((i) => i.id) }));
      setPicked(new Set());
    } catch (e) {
      waiting.current = null;
      void load();
      throw e;
    }
  };

  if (!report) {
    return error ? (
      <div className="card" role="alert">
        <p className="small" style={{ marginTop: 0 }}>Couldn't measure {machine}'s storage: {error}</p>
        <button className="btn small" onClick={() => void load()}>
          Retry
        </button>
      </div>
    ) : (
      <p className="muted small" role="status">Loading…</p>
    );
  }
  const { status } = report;
  const used = status.total - status.free;
  const full = status.free < status.reserve;
  const items = report.items.filter((i) => picked.has(i.id));
  const pickedBytes = items.reduce((n, i) => n + i.bytes, 0);
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const cachesBytes = report.caches.reduce((n, c) => n + c.bytes, 0);

  return (
    <>
      <div className="card">
        <div className="row" style={{ alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 600, fontSize: 17 }}>{formatBytes(status.free)} free</div>
          <div className="muted small">of {formatBytes(status.total)}</div>
          {full ? <span className="pill red">Full</span> : status.low ? <span className="pill orange">Low on space</span> : null}
        </div>
        <div className={`storage-meter ${full ? "full" : status.low ? "low" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={status.total} aria-valuenow={used} aria-label="Disk used">
          <span style={{ width: `${Math.min(100, (used / status.total) * 100)}%` }} />
        </div>
        {full && <p className="help" style={{ color: "var(--red)" }}>Uploads are paused until {formatBytes(status.reserve - status.free)} more is free.</p>}
        {report.trash !== null && report.trash > 1024 ** 3 && <p className="help">The Trash holds {formatBytes(report.trash)}: empty it on {machine} to free that space.</p>}
        {!settings && settingsError && (
          <div role="alert" className="small" style={{ marginTop: 12 }}>
            <p style={{ margin: "0 0 6px" }}>Couldn't load the cleanup settings: {settingsError}</p>
            <button className="btn small" onClick={loadSettings}>
              Retry
            </button>
          </div>
        )}
        {settings && (
          <>
            <div className="row" style={{ marginTop: 14 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>Clear caches on its own</div>
                <div className="help">
                  Every few hours, clears tool caches (Xcode build data, npm, pip, Homebrew and others: all of them when space is low) and installed dependencies like node_modules in chats unused for 2 weeks. They're downloaded or rebuilt again when needed.
                </div>
              </div>
              <Switch checked={settings.autoClean} onChange={(v) => void put({ ...settings, autoClean: v })} label="Clear caches on its own" />
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>Warn me below</div>
                <div className="help">Shows a warning in the sidebar and sends a notification. Agents are told to clean up once it's half that.</div>
              </div>
              <Stepper label="Warn below" value={Math.round(settings.lowSpaceGb / 5)} min={1} max={20} unit={(n) => `${n * 5} GB`} onChange={(v) => void put({ ...settings, lowSpaceGb: v * 5 })} />
            </div>
          </>
        )}
        <div className="storage-foot">
          <button className="btn small" onClick={clean} disabled={!!report.busy}>
            Clear caches now{cachesBytes ? ` (${formatBytes(cachesBytes)})` : ""}
          </button>
          {report.busy && <span className="muted small">{BUSY[report.busy]}</span>}
        </div>
        {report.cleared.length > 0 && (
          <details className="storage-details">
            <summary>Recently cleared</summary>
            {report.cleared.slice(0, 12).map((c, i) => (
              <div key={i} className="storage-line">
                <span className="ellipsis">{c.what}</span>
                <span className="muted">
                  {formatBytes(c.bytes)} · {timeAgo(c.at)}
                  {c.auto ? "" : " · by you"}
                </span>
              </div>
            ))}
          </details>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>Chat folders</div>
            <div className="help">{report.scannedAt ? `Measured ${timeAgo(report.scannedAt)}` : "Not measured yet"}</div>
          </div>
          <button className="btn small ghost" onClick={() => void load(true)} disabled={!!report.busy}>
            Measure again
          </button>
        </div>
        {report.chats.slice(0, 8).map((c) => (
          <div key={c.path} className="storage-line" title={c.path}>
            <span className="ellipsis">{c.chats[0] ?? c.path}</span>
            <span className="muted">
              {formatBytes(c.bytes)}
              {c.activeAt ? ` · used ${timeAgo(c.activeAt)}` : ""}
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <div style={{ fontWeight: 600 }}>Can be deleted</div>
        <p className="help" style={{ margin: "2px 0 10px" }}>
          The biggest things in the chat folders. Build files are made again by the next build; check the others first. Deleting is permanent.
        </p>
        {report.items.length === 0 ? (
          <p className="muted small">{report.busy === "scanning" || !report.scannedAt ? "Measuring…" : "Nothing big to delete."}</p>
        ) : (
          <div className="list-group">
            {report.items.map((i) => (
              <label key={i.id} className="list-row storage-item" title={i.path}>
                <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} disabled={!!report.busy} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="title">{i.name}</div>
                  <div className="subtitle">
                    {i.chats[0] ?? "Chat"}
                    {i.chatActiveAt ? ` · used ${timeAgo(i.chatActiveAt)}` : ""}
                  </div>
                  <div className="subtitle storage-note">{i.note}</div>
                </div>
                <div className="storage-size">
                  <div>{formatBytes(i.bytes)}</div>
                  <span className={`pill ${KIND[i.kind].pill}`}>{KIND[i.kind].label}</span>
                </div>
              </label>
            ))}
          </div>
        )}
        {report.items.length > 0 && (
          <div className="storage-foot">
            <button className="btn small danger" onClick={() => setConfirming(items)} disabled={!items.length || !!report.busy}>
              {items.length ? `Delete ${items.length} (${formatBytes(pickedBytes)})` : "Delete"}
            </button>
            {items.length > 0 && (
              <button className="btn small ghost" onClick={() => setPicked(new Set())}>
                Clear selection
              </button>
            )}
          </div>
        )}
      </div>
      {confirming && <DeleteDialog items={confirming} onConfirm={() => remove(confirming)} onClose={() => setConfirming(null)} />}
    </>
  );
}

/**
 * Deleting files is asked twice. What can't be made again (anything but build files) is named, each one: those are
 * what to look at before saying yes.
 */
function DeleteDialog({ items, onConfirm, onClose }: { items: StorageItem[]; onConfirm: () => Promise<void>; onClose: () => void }) {
  const bytes = items.reduce((n, i) => n + i.bytes, 0);
  const builds = items.filter((i) => i.kind === "build");
  const others = items.filter((i) => i.kind !== "build");
  return (
    <AskTwiceDialog
      title={items.length === 1 ? `Delete ${items[0].name}?` : `Delete ${items.length} items (${formatBytes(bytes)})?`}
      icon={<Trash2 size={18} />}
      sure={`This can't be undone: ${items.length === 1 ? "it's" : "they're"} deleted for good, not moved to the Trash.`}
      confirmLabel="Yes, delete"
      workingLabel="Deleting…"
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {others.length > 0 && (
        <>
          <p className="small" style={{ marginTop: 0 }}>{others.length === 1 ? "This isn't a build file, so nothing makes it again:" : "These aren't build files, so nothing makes them again:"}</p>
          <ul className="delete-list">
            {others.map((i) => (
              <li key={i.id}>
                <span className="mono">{i.name}</span> · {formatBytes(i.bytes)}
                {i.chats[0] ? ` · in ${i.chats[0]}` : ""}
                <span className="muted"> · {KIND[i.kind].label}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {builds.length > 0 && (
        <p className="small" style={{ marginBottom: 0 }}>
          {builds.length === 1 ? `${builds[0].name} (${formatBytes(builds[0].bytes)}) holds build files: the next build makes them again.` : `${builds.length} build folders (${formatBytes(builds.reduce((n, i) => n + i.bytes, 0))}): the next build makes them again.`}
        </p>
      )}
    </AskTwiceDialog>
  );
}
