import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, FileDown, Folder, Image as ImageIcon } from "lucide-react";
import { api, attachmentBlob, folderFileBlob, projectFileBlob } from "../api";
export { projectPath } from "../links";
import { useStore } from "../store";

export const isAttachmentUrl = (url?: string) => !!url && /^\/api\/rooms\/[^/]+\/uploads\/[^/?#]+$/.test(url);

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|heic|heif)$/i;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", heic: "image/heic", heif: "image/heif" };

/** Whether a file path or URL names an image the chat can preview. */
export const isImageName = (name?: string | null) => !!name && IMAGE_NAME.test(name);

export const isFolderUrl = (url?: string) => !!url && /^\/api\/rooms\/[^/]+\/folders\/[^/]+\/[^/?#]+$/.test(url);

function saveBlob(blob: Blob, name: string) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl; link.download = name; link.hidden = true;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

function size(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** An uploaded folder in a message: tap to list its files, tap a file to download it. */
export function FolderAttachment({ url, children }: { url: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<{ files: { path: string; size: number }[]; total: number } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const load = async (offset: number) => {
    setLoading(true);
    try {
      const page = await api<{ files: { path: string; size: number }[]; total: number }>("GET", `${url}?offset=${offset}`);
      setListing((cur) => ({ files: [...(offset ? cur?.files ?? [] : []), ...page.files], total: page.total }));
      setError("");
      setFailedAt(null);
    } catch (e) {
      // Keep whatever is already listed; remember which page failed so it can be retried.
      setError(e instanceof Error ? e.message : String(e));
      setFailedAt(offset);
    } finally {
      setLoading(false);
    }
  };
  const toggle = () => {
    setOpen(!open);
    if (!open && !listing && !loading) void load(0);
  };
  const openFile = async (rel: string) => {
    try { saveBlob(await folderFileBlob(url, rel), rel.split("/").pop()!); }
    catch (e) { useStore.getState().toast("error", e instanceof Error ? e.message : String(e)); }
  };
  return (
    <span className="chat-attachment chat-folder">
      <button className="attachment-download" onClick={toggle} aria-expanded={open}>
        <Folder size={16} /> {children}
        <ChevronDown size={14} style={{ transform: open ? "rotate(180deg)" : undefined }} aria-hidden="true" />
      </button>
      {open && (
        <span className="chat-folder-files">
          {!listing ? (
            error ? null : <span className="tiny">Loading…</span>
          ) : (
            <>
              {listing.files.map((f) => (
                <button key={f.path} className="chat-folder-file" onClick={() => openFile(f.path)} title={`Download ${f.path}`}>
                  <span>{f.path}</span>
                  <span className="muted">{size(f.size)}</span>
                </button>
              ))}
              {listing.total > listing.files.length && failedAt === null && (
                <button className="btn small ghost" onClick={() => load(listing.files.length)} disabled={loading}>
                  {loading ? "Loading…" : `Show ${Math.min(1000, listing.total - listing.files.length).toLocaleString()} more of ${(listing.total - listing.files.length).toLocaleString()} remaining`}
                </button>
              )}
            </>
          )}
          {error && failedAt !== null && (
            <span className="row" style={{ gap: 8, alignItems: "center" }}>
              <span className="tiny" style={{ color: "var(--red)" }}>{error}</span>
              <button className="btn small" onClick={() => load(failedAt)} disabled={loading}>{loading ? "Retrying…" : "Retry"}</button>
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/** A download link to a file in the room's project folder, fetched with the device's token. */
export function ProjectFileLink({ roomId, path, children }: { roomId: string; path: string; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try { saveBlob(await projectFileBlob(roomId, path), path.split("/").pop() || "download"); }
    catch (e) { useStore.getState().toast("error", e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <button className="attachment-download project-file-link" onClick={download} disabled={busy} title={`Download ${path}`}>
      <FileDown size={15} /> {busy ? "Downloading…" : children}
    </button>
  );
}

/**
 * An image from the room's project folder, previewed in the message (fetched with the device's token), with a
 * download button. If it can't be fetched (moved, or outside the folder) only the button shows.
 */
export function ProjectImage({ roomId, path, children, large }: { roomId: string; path: string; children: ReactNode; large?: boolean }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const name = path.split("/").pop() || "image";
  useEffect(() => {
    setPreview(null);
    setFailed(false);
    const ctl = new AbortController();
    let objectUrl: string | undefined;
    projectFileBlob(roomId, path, ctl.signal)
      .then((blob) => {
        if (ctl.signal.aborted) return;
        // The hub sends project files as downloads; label it as the image it is so every browser shows it.
        objectUrl = URL.createObjectURL(new Blob([blob], { type: IMAGE_TYPES[name.split(".").pop()!.toLowerCase()] ?? "" }));
        setPreview(objectUrl);
      })
      .catch(() => { if (!ctl.signal.aborted) setFailed(true); });
    return () => { ctl.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [roomId, path, name]);
  return (
    <span className={`chat-attachment ${large ? "large" : ""}`}>
      {preview && !failed && <a href={preview} target="_blank" rel="noopener noreferrer" aria-label={`View ${name}`}><img src={preview} alt={name} loading="lazy" onError={() => setFailed(true)} /></a>}
      <ProjectFileLink roomId={roomId} path={path}>{children}</ProjectFileLink>
    </span>
  );
}

export function Attachment({ url, children, large }: { url: string; children: ReactNode; large?: boolean }) {
  const image = /\.(png|jpe?g|gif|webp|avif|heic|heif)$/i.test(url);
  const [preview, setPreview] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  let filename = url.split("/").pop()!;
  // A malformed link from an agent must produce a download error, not crash chat.
  try { filename = decodeURIComponent(filename); } catch { /* use the raw name */ }
  const name = filename.replace(/^[a-f0-9-]{36}_/i, "");
  useEffect(() => {
    setPreview(null);
    setFailed(false);
    if (!image) return;
    const ctl = new AbortController();
    let objectUrl: string | undefined;
    attachmentBlob(url, ctl.signal).then((blob) => {
      if (ctl.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setPreview(objectUrl);
    }).catch(() => { if (!ctl.signal.aborted) setFailed(true); });
    return () => { ctl.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, image]);

  const download = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const objectUrl = URL.createObjectURL(await attachmentBlob(url));
      const link = document.createElement("a");
      link.href = objectUrl; link.download = name; link.hidden = true;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (e) { useStore.getState().toast("error", e instanceof Error ? e.message : String(e)); }
    finally { setOpening(false); }
  };
  return (
    <span className={`chat-attachment ${large ? "large" : ""}`}>
      {image && preview && !failed && <a href={preview} target="_blank" rel="noopener noreferrer" aria-label={`View ${name}`}><img src={preview} alt={name} loading="lazy" onError={() => setFailed(true)} /></a>}
      <button className="attachment-download" onClick={download} disabled={opening}>
        {image ? <ImageIcon size={16} /> : <FileDown size={16} />} {opening ? "Opening…" : children}
      </button>
      {image && failed && <span className="tiny">Preview unavailable; open the file instead.</span>}
    </span>
  );
}
