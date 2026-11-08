import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { ApiError } from "../api";
import { useStore } from "../store";
import { Switch } from "../ui";
import { useReconnected } from "../useReconnected";
import { useMachineName } from "./MachinePicker";
import { imageEditorLine } from "../imageEditor";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Settings → Image editor: the local AI image editor on this machine (hub/src/imageEditor.ts), switched on (it starts
 * and loads its model) and off (its memory is freed), with its link. Only on a machine where it's set up.
 */
export function ImageEditorSection() {
  const status = useStore((s) => s.imageEditor);
  const call = useStore((s) => s.imageEditorCall);
  const toast = useStore((s) => s.toast);
  const machine = useMachineName();
  const [loadFailed, setLoadFailed] = useState(false);
  /** Where the switch was moved, until the hub has answered. */
  const [moving, setMoving] = useState<boolean | null>(null);
  /** It's editing: turning it off asks first. */
  const [asking, setAsking] = useState(false);
  /** It won't fit in what's left of the machine's memory: the guard's words, with Start anyway under them. */
  const [tooBig, setTooBig] = useState<string | null>(null);

  const load = () =>
    call().then(
      () => setLoadFailed(false),
      () => setLoadFailed(true),
    );
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Back after the hub restarted, say: a card that couldn't load loads (the store reloads one it has).
  useReconnected(() => {
    if (loadFailed) void load();
  });
  // The question about an edit goes once it no longer applies (it went off, or stopped, meanwhile).
  const state = status?.state;
  useEffect(() => {
    if (state !== "ready" && state !== "loading") setAsking(false);
  }, [state]);

  // Older hubs and machines without it set up don't show it.
  if (!status?.installed) return null;

  // It still runs after a turn-off that didn't work, so the switch shows it on.
  const stuck = status.state === "error" && status.failed === "stop";
  const on = status.state === "starting" || status.state === "loading" || status.state === "ready" || stuck;
  const turn = async (v: boolean, force = false) => {
    setMoving(v);
    setAsking(false);
    setTooBig(null);
    try {
      await call(v, force);
    } catch (e) {
      if (e instanceof ApiError && e.code === "busy") {
        setAsking(true);
        // The line under the switch says it's editing.
        void call().catch(() => {});
      } else if (e instanceof ApiError && e.code === "memory") {
        // It would not fit beside what's already running. The hub started nothing: the choice is the person's.
        setTooBig(e.message);
      } else toast("error", message(e));
    } finally {
      setMoving(null);
    }
  };
  const working = status.state === "starting" || status.state === "loading" || status.state === "stopping";
  const showLink = (status.state === "ready" || status.state === "loading") && status.url;
  return (
    <>
      <h2 className="settings-heading" id="image-editor">Image editor</h2>
      <div className="card image-editor">
        <div className="image-editor-row">
          <div className="image-editor-text">
            <div className="pool-setting-title">AI image editor</div>
            <div className={`help image-editor-state${status.state === "error" ? " image-editor-stopped" : ""}`} aria-live="polite">
              {working && <Loader2 size={13} className="spin" aria-hidden />}
              {imageEditorLine(status, machine)}
            </div>
          </div>
          <Switch checked={moving ?? on} onChange={(v) => void turn(v)} label="AI image editor" disabled={status.state === "stopping" || moving !== null} />
        </div>
        {status.state === "error" && status.detail && (
          <div className="image-editor-problem" role="alert">
            <p className="small">{status.detail}</p>
            {stuck ? (
              <div className="image-editor-actions">
                <button className="btn small primary" onClick={() => void turn(false)} disabled={moving !== null}>
                  Try again
                </button>
                <button className="btn small ghost" onClick={() => void turn(true)} disabled={moving !== null}>
                  Keep it on
                </button>
              </div>
            ) : (
              <div className="image-editor-actions">
                <button className="btn small primary" onClick={() => void turn(true)} disabled={moving !== null}>
                  Try again
                </button>
                <button className="btn small ghost" onClick={() => void turn(false)} disabled={moving !== null}>
                  Dismiss
                </button>
              </div>
            )}
          </div>
        )}
        {tooBig && (
          <div className="image-editor-problem" role="alert">
            <p className="small">{tooBig}</p>
            <div className="image-editor-actions">
              <button className="btn small ghost" onClick={() => void turn(true, true)} disabled={moving !== null}>
                Start anyway
              </button>
              <button className="btn small primary" onClick={() => setTooBig(null)}>
                Not now
              </button>
            </div>
          </div>
        )}
        {asking && (status.state === "ready" || status.state === "loading") && (
          <div className="image-editor-problem" role="alert">
            <p className="small">It's working on an edit. Turning it off now stops that edit.</p>
            <div className="image-editor-actions">
              <button className="btn small danger" onClick={() => void turn(false, true)}>
                Turn off anyway
              </button>
              <button className="btn small ghost" onClick={() => setAsking(false)}>
                Keep it on
              </button>
            </div>
          </div>
        )}
        {status.state === "ready" && status.detail && <p className="help image-editor-note">{status.detail}</p>}
        {showLink && (
          <div className="image-editor-link">
            <a className="btn small primary" href={status.url!} target="_blank" rel="noreferrer noopener">
              <ExternalLink size={16} aria-hidden /> Open the editor
            </a>
            <span className="help mono image-editor-url">{status.url!.replace(/^https?:\/\//, "")}</span>
          </div>
        )}
        {status.state === "off" && <p className="help image-editor-note">Switching it on starts it on {machine} and loads the model, about a minute. Off frees its memory.</p>}
      </div>
    </>
  );
}
