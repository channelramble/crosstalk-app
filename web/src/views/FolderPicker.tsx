// The folder a new chat, group chat or template works in: every folder the machine has (its chats' folders and its
// workspaces folder's, GET /api/folders), as a list to tap, with a field under it for any other path. Typing in the field
// narrows the list to folders that match, so a long list is quick to search, and a path nothing matches is used as typed.

import { useEffect, useMemo, useState } from "react";
import type { HubFolders } from "@crosstalk/shared";
import { api, type Connection } from "../api";

export const NEW_FOLDER = "__new__";
export const OTHER_FOLDER = "__other__";

const nameOf = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/**
 * The rows to show: the machine's folders, then any the dialog knows of that the machine didn't list (a template's, or one
 * from before this hub could list them), without duplicates or throwaway temp folders, narrowed by what's typed.
 */
export function folderRows(listed: readonly string[], known: readonly string[], typed: string): string[] {
  const temp = /^(\/private)?\/tmp\b|^\/var\/folders\//;
  // The hub already leaves temp folders out of its own list (and keeps its workspaces folder's even where that is in one).
  const all = [...new Set([...listed, ...known.filter((f) => !temp.test(f))].filter(Boolean))];
  const q = typed.trim().toLowerCase();
  return q ? all.filter((f) => f.toLowerCase().includes(q)) : all;
}

export function FolderPicker({
  folder,
  path,
  onPick,
  known = [],
  conn,
  newHelp,
  pickedHelp,
}: {
  /** NEW_FOLDER, OTHER_FOLDER (the typed `path`), or a folder's path. */
  folder: string;
  path: string;
  onPick: (folder: string, typed?: string) => void;
  /** Folders the dialog already knows of (recent chats', a template's): shown even if the machine doesn't list them. */
  known?: readonly string[];
  /** The machine whose folders these are. */
  conn: Connection | null;
  newHelp: string;
  pickedHelp: string;
}) {
  const [listed, setListed] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setListed(null);
    setError("");
    api<HubFolders>("GET", "/api/folders", undefined, conn)
      .then((r) => live && setListed(r.folders.map((f) => f.path)))
      .catch((e) => {
        if (!live) return;
        setListed([]);
        // A hub from before it could list folders: the ones the app knows still show, with nothing to say about it.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/404|not found/i.test(msg)) setError(msg);
      });
    return () => {
      live = false;
    };
  }, [conn?.baseUrl, conn?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const typed = folder === OTHER_FOLDER ? path : "";
  // A folder picked from the list stays in it while the list is narrowed for another.
  const rows = useMemo(() => {
    const r = folderRows(listed ?? [], known, typed);
    return folder !== NEW_FOLDER && folder !== OTHER_FOLDER && !r.includes(folder) ? [folder, ...r] : r;
  }, [listed, known, typed, folder]);
  const exact = typed.trim() && rows.some((f) => f === typed.trim().replace(/\/+$/, ""));

  return (
    <div className="field">
      <span id="folder-label">Folder</span>
      <div className="choice-cards folder-list" role="radiogroup" aria-labelledby="folder-label">
        <button type="button" role="radio" aria-checked={folder === NEW_FOLDER} className={`choice-card ${folder === NEW_FOLDER ? "on" : ""}`} onClick={() => onPick(NEW_FOLDER, "")}>
          <span className="choice-card-title">A new folder</span>
        </button>
        {rows.map((f) => (
          <button key={f} type="button" role="radio" aria-checked={folder === f} aria-label={`${nameOf(f)}, ${f}`} className={`choice-card ${folder === f ? "on" : ""}`} onClick={() => onPick(f, "")}>
            <span className="choice-card-title">{nameOf(f)}</span>
            <span className="choice-card-help mono folder-path">{f}</span>
          </button>
        ))}
        {listed === null && <p className="muted small folder-note">Looking for folders…</p>}
        {listed !== null && typed.trim() && !rows.length && <p className="muted small folder-note">No folder here matches. The path you typed is used.</p>}
      </div>
      <input
        className={`input mono ${folder === OTHER_FOLDER ? "on" : ""}`}
        aria-label="Folder path"
        placeholder="Or type a path"
        value={path}
        onChange={(e) => onPick(e.target.value.trim() ? OTHER_FOLDER : NEW_FOLDER, e.target.value)}
        onFocus={() => path.trim() && folder !== OTHER_FOLDER && onPick(OTHER_FOLDER, path)}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {error && <span className="help">Couldn't read this machine's folders: {error}. Type a path, or pick a recent one.</span>}
      <span className="help">{folder === NEW_FOLDER ? newHelp : exact ? "That's one of the folders above." : pickedHelp}</span>
    </div>
  );
}
