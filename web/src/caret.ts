/**
 * Where the caret goes when the message box fills itself in: an @name picked from the popup, or an answer that "Send to
 * the chat" quoted. The caret is placed in the layout pass right after that text lands in the box (see Composer), never
 * a frame later: a later frame drags the caret back over whatever was typed in between, which is what a fast typist and
 * a browser that throttles frames both hit (the name stayed, the words after it came out shuffled).
 */

/** A pick that filled the box: the text it left behind, and where the caret belongs in it. */
export type CaretWish = { text: string; pos: number; from: Element | null };

/** The box after picking `@handle` for the name that started at `start` and was typed up to `caret`. */
export function withMention(draft: string, start: number, caret: number, handle: string, from: Element | null = null): CaretWish | null {
  // Nothing closes the popup when the caret leaves the half-typed name, so a pick can arrive stale: replacing a stretch
  // the person has left would duplicate or cut their draft. Then the pick does nothing but close the popup.
  if (caret < start || draft[start] !== "@" || /\s/.test(draft.slice(start + 1, caret))) return null;
  return { text: draft.slice(0, start) + "@" + handle + " " + draft.slice(caret), pos: start + handle.length + 2, from };
}

/** The box after a quoted answer, with the caret at the end, where the person writes under it. */
export function withQuote(text: string, from: Element | null = null): CaretWish {
  return { text, pos: text.length, from };
}

/**
 * What to do about a wish once the box has been drawn: nothing at all when the box no longer holds exactly what the
 * pick put there (anything typed since is the person's, and their caret wins). The focus guard is a backstop for a
 * wish that outlives the pick's own click: what was clicked to make the pick (the popup option, gone by now, or the
 * answer card's own button) never counts as focus moving away.
 */
export function caretPlan(wish: CaretWish, box: HTMLTextAreaElement, active: Element | null): { pos: number; focus: boolean } | null {
  if (box.value !== wish.text) return null;
  const doc = box.ownerDocument;
  const elsewhere = !!active && active !== box && active !== wish.from && active !== doc.body && doc.contains(active);
  return { pos: wish.pos, focus: !elsewhere };
}
