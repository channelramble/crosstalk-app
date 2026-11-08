import { useMemo, useState } from "react";
import { MessageSquareText, Server } from "lucide-react";
import { PROVIDER_INFO } from "@crosstalk/shared";
import { SHOWN_HITS, anyTruncated, foundHits, groupHits, hitTime, hitWho, markSnippet, searchTerm, type FoundHit } from "../search";
import { useMessageSearch } from "../useMessageSearch";
import { useMachines } from "../store";
import { MachineTag } from "./MachinePicker";
import { openHit } from "./useFindMessage";

/**
 * The sidebar's "In messages" group: what you typed, looked for in every chat on every machine (the name filter above it
 * stays instant). A hit opens its chat at that message. A machine that can't be searched says which, with Try again.
 */
export function MessageHits({ query, go }: { query: string; go: (fn: () => void) => void }) {
  const term = searchTerm(query);
  const machines = useMachines((m) => m.list);
  const { machines: found, searching, retry } = useMessageSearch(term, machines);
  const [all, setAll] = useState(false);
  const hits = useMemo(() => foundHits(found), [found]);
  const shown = useMemo(() => groupHits(all ? hits : hits.slice(0, SHOWN_HITS)), [hits, all]);
  if (!term || !machines.length) return null;
  const multi = machines.length > 1;
  const problems = found.filter((m) => m.problem);
  // Who said it: you, the agent of another chat that sent it here (the hit says which), or this chat's own agent.
  const saidBy = (h: FoundHit) => {
    const provider = machines.find((m) => m.key === h.machineKey)?.rooms[h.roomId]?.chat?.provider;
    return hitWho(h, provider ? PROVIDER_INFO[provider].name : null);
  };
  const collapsed = hits.length > SHOWN_HITS && !all;
  return (
    <section className="search-hits" aria-label="In messages" aria-busy={searching}>
      <div className="search-head">
        <MessageSquareText size={15} aria-hidden="true" />
        <span className="search-head-name">In messages</span>
        {searching && (
          <span className="search-status" role="status">
            Searching…
          </span>
        )}
      </div>
      {shown.map((g) => (
        <div className="search-chat" key={g.key}>
          <div className="search-chat-name">
            <span className="search-chat-title">{g.roomName}</span>
            {multi && <MachineTag name={g.machineName} />}
          </div>
          {g.hits.map((h) => (
            <button key={`${h.machineKey}/${h.messageId}`} className="csb-hit" onClick={() => go(() => openHit(h))}>
              <span className="csb-hit-text">
                <span className="csb-hit-who">{saidBy(h)}: </span>
                {markSnippet(h.snippet, h.query).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text))}
              </span>
              <span className="csb-time">{hitTime(h.createdAt)}</span>
            </button>
          ))}
        </div>
      ))}
      {!searching && hits.length === 0 && <p className="csb-empty">{problems.length ? "Nothing found." : "No messages match."}</p>}
      {hits.length > SHOWN_HITS && (
        <button className="csb-more" onClick={() => setAll(!all)}>
          {all ? "Show fewer matches" : `Show all ${hits.length} matches`}
        </button>
      )}
      {!searching && !collapsed && anyTruncated(found) && <p className="csb-empty">There are more matches than these. Type more of the words to narrow them down.</p>}
      {problems.map((m) => (
        <div key={m.key} className="search-problem" role="status">
          <Server size={15} aria-hidden="true" />
          <span className="search-problem-text">
            Couldn't search {m.name}. {m.problem}
          </span>
          <button className="link-btn" disabled={m.busy} onClick={() => retry(m.key)}>
            {m.busy ? "Trying…" : "Try again"}
          </button>
        </div>
      ))}
    </section>
  );
}
