// A note from Crosstalk in a chat (a system message) as the plain text it is, with each https:// address in it a link
// that opens in the phone's own browser. The hub writes an address out whole where a note points somewhere — Featherless's
// plans, under a chat on a key whose plan doesn't allow agents (hub/src/featherless.ts chatNotice) — and the link shows it
// without "https://", the way every other screen says an address; the full stop after it stays text.
import type { ReactNode } from "react";

/** A piece of a note: words as they are, or an address to link. */
export type NotePart = { text: string } | { url: string; label: string };

const ADDRESS = /https:\/\/[^\s<>"'“”‘’]+/g;
/** What ends a sentence (or closes a bracket around an address) rather than being part of it. */
const TRAILING = /[.,;:!?)\]]+$/;

/** A note cut into words and addresses. Only https addresses become links; one that isn't a valid address stays text. */
export function noteParts(text: string): NotePart[] {
  const parts: NotePart[] = [];
  let at = 0;
  const words = (to: number) => {
    if (to > at) parts.push({ text: text.slice(at, to) });
  };
  for (const m of text.matchAll(ADDRESS)) {
    const start = m.index ?? 0;
    const url = m[0].replace(TRAILING, "");
    let ok = false;
    try {
      ok = new URL(url).protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok || url === "https://") continue;
    words(start);
    parts.push({ url, label: url.replace(/^https:\/\//, "") });
    at = start + url.length;
  }
  words(text.length);
  return parts;
}

export function NoteText({ text }: { text: string }) {
  const parts = noteParts(text);
  if (parts.length === 1 && "text" in parts[0]) return <>{text}</>;
  return (
    <>
      {parts.map((p, i): ReactNode =>
        "url" in p ? (
          <a key={i} href={p.url} target="_blank" rel="noreferrer noopener">
            {p.label}
          </a>
        ) : (
          p.text
        ),
      )}
    </>
  );
}
