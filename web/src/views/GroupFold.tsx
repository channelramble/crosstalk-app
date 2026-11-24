// Folding a section of the chat list away (Pinned, Working, Recent; never Needs you, which has no control). The control
// is its own button beside the heading. Folded, the section says when chats inside need a look, and how many, because
// folding hides even a chat with a reply no one has read (how many chats it holds is in its heading).

import { useId, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { foldedSaid, foldLabel } from "../chatList";

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

/**
 * Folded with a chat inside that needs a look, the section says so on the line its rows were on (and the list's motion
 * knows it's there). How many chats it holds is in its heading, folded or not.
 */
export const saysWhatsInside = (fold: Pick<GroupFold, "folded" | "attention">): boolean => fold.folded && fold.attention > 0;

/**
 * One section of the list: its heading, the fold control (when it folds), and its rows. `title` is what the control
 * says it folds ("pinned chats", "recent chats"); `label` names the whole section for a screen reader (Pinned, Needs
 * you…). `group` is its key in the list (chatList.ts ListSection), which the list's motion tells its lines apart by
 * (ChatListMotion.ts).
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
      {/* Folded, that something inside needs a look, in plain words on the line the rows were on. The control's own
          name says the same (and how many chats there are), so a reader hears it once. Nothing to look at, nothing to
          say: the heading has the count. */}
      {saysWhatsInside({ folded, attention }) && (
        <p className="csb-fold-said" aria-hidden="true">
          <span className={`csb-fold-mark ${mark}`} />
          {foldedSaid(attention)}
        </p>
      )}
    </section>
  );
}
