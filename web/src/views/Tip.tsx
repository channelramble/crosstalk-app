import { HELP, type HelpTopic } from "../helpCopy";
import { HelpTip } from "./HelpTip";

/** The "?" for one topic of helpCopy.ts. Put it in a `tip-line` so the sentence it opens gets a line of its own. */
export function Tip({ topic }: { topic: HelpTopic }) {
  return <HelpTip label={HELP[topic].label}>{HELP[topic].text}</HelpTip>;
}

/**
 * A Settings heading with its "?" beside it. The "?" sits next to the heading, not in it: the heading's name stays its
 * words. The `id` (where Settings scrolls to) is on the line around both, so the section after it is still its sibling.
 */
export function TipHeading({ topic, id, children }: { topic: HelpTopic; id?: string; children: string }) {
  return (
    <div className="tip-line tip-heading" id={id}>
      <h2 className="settings-heading">{children}</h2>
      <Tip topic={topic} />
    </div>
  );
}
