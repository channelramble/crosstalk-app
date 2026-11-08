import { useEffect, useRef, useState } from "react";
import { Boxes, ChevronLeft } from "lucide-react";
import type { PoolModel, PoolModelChoices, PoolView, Provider } from "@crosstalk/shared";
import { api } from "../api";
import { Dialog } from "../ui";
import { FIT_PILL, SUGGESTED_MODELS, bytesText, fileName, fitBadge, hfModelUrl, mibText, modelName, namesText, parseHfLink, poolRoom, type PoolRoom } from "../pool";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Target = { repo: string; file: string | null; quant: string | null };

/**
 * Choose a model: a few suggestions or any Hugging Face link, then one of its GGUF files, each marked with how it fits
 * the machines taking part. Kimi K3.1 Pro is listed too, to say why it can't run here and what to use instead.
 */
export function ChooseModelDialog({
  view,
  onClose,
  onChoose,
  onKimi,
  onToken,
}: {
  view: PoolView;
  onClose: () => void;
  onChoose: (m: PoolModel) => Promise<boolean>;
  onKimi: (p: Provider) => void;
  /** The Hugging Face token is what's missing: closes the dialog and opens its field. */
  onToken: () => void;
}) {
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [choices, setChoices] = useState<PoolModelChoices | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => () => void request.current++, []);
  const room = poolRoom(view);
  const chosen = view.config.model;

  const open = async (t: Target) => {
    const id = ++request.current;
    setTarget(t);
    setChoices(null);
    setError("");
    setLoading(true);
    try {
      const c = await api<PoolModelChoices>("GET", `/api/pool/models?repo=${encodeURIComponent(t.repo)}`, undefined, undefined, 45_000);
      if (id === request.current) setChoices(c);
    } catch (e) {
      if (id === request.current) setError(message(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  };
  const back = () => {
    request.current++;
    setTarget(null);
    setChoices(null);
    setError("");
    setLoading(false);
  };
  const pick = async (m: PoolModel) => {
    setSaving(m.files[0]);
    const ok = await onChoose(m);
    // Closed on success; on failure the error was shown and the list stays to try again.
    if (!ok) setSaving(null);
  };
  const fromLink = (m: PoolModel) => !!target && ((!!target.file && m.files.includes(target.file)) || (!!target.quant && m.quant?.toLowerCase() === target.quant.toLowerCase()));

  return (
    <Dialog title="Choose a model" icon={<Boxes size={20} aria-hidden="true" />} wide onClose={() => !saving && onClose()}>
      <p className="help" style={{ marginTop: 0 }}>
        {roomText(room)}
      </p>
      {!target ? (
        <>
          <form
            className="pool-link-form"
            onSubmit={(e) => {
              e.preventDefault();
              const t = parseHfLink(link);
              if (!t) {
                setLinkError("That isn't a Hugging Face model link. Paste one like huggingface.co/unsloth/Qwen3.8-27B-GGUF.");
                return;
              }
              setLinkError("");
              void open(t);
            }}
          >
            <div className="pool-label">Any model on Hugging Face</div>
            <div className="pool-link-row">
              <input className="input mono" aria-label="Hugging Face link" value={link} onChange={(e) => (setLink(e.target.value), setLinkError(""))} placeholder="Paste a link or owner/model" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <button className="btn" type="submit" disabled={!link.trim()}>
                Show files
              </button>
            </div>
            {linkError && (
              <p className="small pool-error" role="alert" style={{ margin: "6px 0 0" }}>
                {linkError}
              </p>
            )}
            <p className="help" style={{ margin: "6px 0 0" }}>llama.cpp runs GGUF files: look for a repo whose name ends in GGUF.</p>
          </form>
          <div className="pool-label" style={{ marginTop: 14 }}>
            Suggestions
          </div>
          <div className="choice-cards">
            {SUGGESTED_MODELS.map((s) => (
              <button key={s.repo} type="button" className={`choice-card ${chosen?.repo === s.repo ? "on" : ""}`} onClick={() => void open({ repo: s.repo, file: null, quant: null })}>
                <span className="choice-card-title pool-wrap">
                  {modelName(s.repo)}
                  {s.gated && <span className="pill orange">Gated</span>}
                  {chosen?.repo === s.repo && <span className="pill blue">Chosen</span>}
                </span>
                <span className="choice-card-help">{s.note}</span>
                <span className="choice-card-help mono pool-repo">{s.repo}</span>
              </button>
            ))}
          </div>
          <KimiEntry onKimi={onKimi} />
        </>
      ) : (
        <section aria-label={`${modelName(target.repo)} files`}>
          <button className="btn small ghost pool-back" onClick={back} disabled={!!saving}>
            <ChevronLeft size={14} aria-hidden="true" /> Suggestions
          </button>
          <div className="pool-model-name">
            {modelName(target.repo)} {choices?.gated && <span className="pill orange">Gated</span>}
          </div>
          <a className="help mono pool-repo" href={hfModelUrl(target.repo)} target="_blank" rel="noreferrer noopener">
            {target.repo}
          </a>
          {loading && (
            <p className="muted small" role="status">
              Looking at its files on Hugging Face…
            </p>
          )}
          {error && (
            <div role="alert" className="small">
              <p className="pool-error" style={{ margin: "8px 0 4px" }}>{error}</p>
              <div className="row wrap" style={{ gap: 6 }}>
                {/* A private or gated repo needs the token, which is on the screen behind this dialog. */}
                {/hugging ?face token|\btoken\b/i.test(error) && (
                  <button className="btn small primary" onClick={onToken}>
                    Add your Hugging Face token
                  </button>
                )}
                <button className="btn small" onClick={() => void open(target)}>
                  Try again
                </button>
              </div>
            </div>
          )}
          {choices?.gated && (
            <p className="help">
              Gated: accept its terms on{" "}
              <a href={hfModelUrl(target.repo)} target="_blank" rel="noreferrer noopener">
                its page
              </a>{" "}
              first, then add your Hugging Face token under Model.
            </p>
          )}
          {choices && !choices.models.length && <p className="help">No GGUF files here. llama.cpp needs GGUF files: look for a version of this model whose name ends in GGUF.</p>}
          {choices && choices.models.length > 0 && (
            <div className="choice-cards">
              {choices.models.map((m) => {
                const badge = fitBadge(m.sizeBytes, room);
                const isChosen = chosen?.repo === m.repo && chosen.files[0] === m.files[0];
                return (
                  <button key={m.files.join("|")} type="button" className={`choice-card pool-file ${isChosen ? "on" : ""}`} onClick={() => void pick(m)} disabled={!!saving}>
                    <span className="choice-card-title pool-wrap">
                      {m.quant ?? fileName(m.files[0])}
                      {badge && <span className={`pill ${FIT_PILL[badge.kind]}`}>{badge.label}</span>}
                      {isChosen && <span className="pill blue">Chosen</span>}
                      {fromLink(m) && <span className="pill">Your link</span>}
                    </span>
                    <span className="choice-card-help">
                      {saving === m.files[0] ? "Choosing…" : `${bytesText(m.sizeBytes)}${m.files.length > 1 ? ` in ${m.files.length} parts` : ""}`}
                    </span>
                    <span className="choice-card-help mono pool-repo">{fileName(m.files[0])}</span>
                  </button>
                );
              })}
            </div>
          )}
          {choices && choices.models.length > 0 && <p className="help">Smallest first. Smaller files lose a little quality; Q4_K_M is a good middle.</p>}
        </section>
      )}
    </Dialog>
  );
}

/** What the machines taking part have free, said once above the files (each file's badge weighs itself against it). */
function roomText(room: PoolRoom): string {
  const unseen = room.uncounted;
  const one = unseen.length === 1;
  if (room.haveMiB > 0) {
    const have = `The machines taking part have about ${mibText(room.haveMiB)} free${room.devices.length > 1 ? ` on ${room.devices.length} GPUs` : ""}`;
    // A PC's memory is counted once the main machine's llama.cpp has listed its helper's GPUs (a check, with the
    // helper running): until then a file that needs more says how much more it must add.
    if (unseen.length) return `${have} that Crosstalk has counted, plus what ${namesText(unseen)} ${one ? "has" : "have"}: ${one ? "its" : "their"} GPU memory is counted once ${one ? "its helper runs" : "their helpers run"} and you check the machines. A model that fits one GPU runs fastest there alone.`;
    return `${have}. A model that fits one GPU runs fastest there alone.`;
  }
  if (unseen.length) return `The GPU memory of ${namesText(unseen)} isn't counted yet (start ${one ? "its helper" : "their helpers"}, then check the machines), so each file says how much it needs.`;
  return "Check the machines (or switch one on) to see which models fit.";
}

/** Kimi K3.1 Pro can't run on home machines: Moonshot's API instead, as a custom model. */
function KimiEntry({ onKimi }: { onKimi: (p: Provider) => void }) {
  return (
    <div className="pool-kimi" role="group" aria-label="Kimi K3.1 Pro">
      <div className="choice-card-title pool-wrap">
        Kimi K3.1 Pro <span className="pill red">Too big</span>
      </div>
      <p className="help" style={{ margin: "4px 0 8px" }}>
        It doesn't fit here: about 600 GB even at 1-bit, and its weights are only due Nov 4. Moonshot's API runs it instead, paid per use.
      </p>
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn small" onClick={() => onKimi("claude")}>
          Use it in Claude Code
        </button>
        <button className="btn small" onClick={() => onKimi("codex")}>
          Use it in Codex
        </button>
      </div>
    </div>
  );
}
