import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import type { Message } from "@crosstalk/shared";
import { leave } from "../motion";

/** The newest message when you scrolled up, and how long it was then. */
type Mark = { id: string; length: number };

/**
 * Where you are in a chat: scrolled up from the newest message or not, and what came in since you scrolled up (your
 * own messages don't count). `scrolled` is told after each scroll whether you're away from the bottom.
 */
export function useLatest(messages: Message[]) {
  const [mark, setMark] = useState<Mark | null>(null);
  const newest = useRef<Message | undefined>(undefined);
  newest.current = messages[messages.length - 1];
  const scrolled = useCallback((away: boolean) => {
    // The same mark while you stay away (or none at the bottom), so scrolling doesn't redraw the chat.
    setMark((cur) => (!away ? null : cur ?? { id: newest.current?.id ?? "", length: newest.current?.text.length ?? 0 }));
  }, []);
  const at = mark ? messages.findIndex((m) => m.id === mark.id) : -1;
  const unseen = at < 0 ? 0 : messages.slice(at + 1).filter((m) => m.authorKind !== "human" || !!m.via).length;
  // No new message, but the reply that was newest kept growing (it was still streaming).
  const grew = at >= 0 && !unseen && messages[at].text.length > mark!.length;
  return { away: mark !== null, unseen, grew, scrolled };
}

/**
 * Back to the newest message, while you're scrolled up: pinned to the bottom of the messages, just above the box you
 * type in, with how many messages came in since (a dot when the newest reply only got longer). It pops up; back at the
 * newest message it's gone at once, and a copy shrinks away.
 */
export function JumpToLatest({ unseen, grew, onClick }: { unseen: number; grew: boolean; onClick: () => void }) {
  const label = unseen ? `Jump to latest (${unseen} new)` : grew ? "Jump to latest (more below)" : "Jump to latest";
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => () => leave(box.current, "jump"), []);
  return (
    <div ref={box} className="jump-latest">
      <button type="button" className="jump-latest-btn" onClick={onClick} aria-label={label} title={label}>
        <ArrowDown size={19} aria-hidden="true" />
        {unseen > 0 ? <span className="count">{unseen > 99 ? "99+" : unseen}</span> : grew ? <span className="jump-dot" /> : null}
      </button>
    </div>
  );
}
