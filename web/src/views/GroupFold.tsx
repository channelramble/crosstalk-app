// Folding a group of the chat list away (Pinned, an agent, a service or model of yours, the pool, Group chats). The
// control is its own button beside the heading, not the heading itself: an agent's heading opens its screen and a
// service's starts a chat with it, and folding must not take that away. Folded, the group says what's inside — how
// many chats, and how many need a look — because folding hides even a chat that needs you.

import { useId, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { foldedWords, foldLabel } from "../chatList";

/** What one group needs to fold: whether it's folded now, what's inside, and where the choice goes. */
export interface GroupFold {
  folded: boolean;
  /** False while a search is on, when the control isn't there at all: matches show wherever they are. */
  foldable: boolean;
  count: number;
  /** How many of its chats need a look (chatList.ts keepInView). */
  attention: number;
  /** The strongest of those states, for the mark's colour (chatList.ts foldMark): "" for no colour of its own. */
  mark: "needs" | "error" | "";
  /** What tells this group from another of the same name, when one exists ("on the mini"); in the control's name. */
  where?: string | null;
  onFold(v: boolean): void;
}

/** Folded with something inside, the group says what on the line its rows were on (and the list's motion knows it's there). */
export const saysWhatsInside = (fold: Pick<GroupFold, "folded" | "count">): boolean => fold.folded && fold.count > 0;

/**
 * One group of the list: its heading, the fold control, and its rows. `title` is what the control says it folds
 * ("Claude Code chats", "pinned chats"); `label` names the whole group for a screen reader, where it has a name of its
 * own (Pinned, Group chats). `group` is its key in the list (chatList.ts, chatIdentity.ts), which the list's motion
 * tells its lines apart by (ChatListMotion.ts).
 */
export function FoldableGroup({
  className = "",
  group,
  label,
  title,
  heading,
  folded,
  foldable,
  count,
  attention,
  mark,
  where,
  onFold,
  children,
}: GroupFold & { className?: string; group?: string; label?: string; title: string; heading: ReactNode; children?: ReactNode }) {
  const rows = useId();
  const said = foldLabel(title, folded, count, attention, where);
  return (
    <section className={`csb-group ${className}`} aria-label={label} data-group={group}>
      <div className="csb-group-head">
        {heading}
        {foldable && (
          <button className="icon-btn csb-fold" onClick={() => onFold(!folded)} aria-expanded={!folded} aria-controls={rows} aria-label={said} title={said}>
            {/* One chevron, turned down at the rows while they show (motion-lists.css), so folding turns it. */}
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        )}
      </div>
      {/* Here even while it's folded and empty, so the control's aria-controls always names it. */}
      <div id={rows} className="csb-group-rows">
        {folded ? null : children}
      </div>
      {/* Folded, what's inside, in plain words on the line the rows were on: a phone's heading row has no room for them
          beside the group's own name (a model's can be long, and an agent's shows its usage). The control's own name
          says the same, so a reader hears it once. Nothing inside, nothing to say: an empty group folds to its heading
          alone, which is the clutter folding is for. */}
      {saysWhatsInside({ folded, count }) && (
        <p className="csb-fold-said" aria-hidden="true">
          {attention > 0 && <span className={`csb-fold-mark ${mark}`} />}
          {foldedWords(count, attention)}
        </p>
      )}
    </section>
  );
}
