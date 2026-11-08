// Search across chats: asks every machine this device is paired with, once the typing pauses (docs/SPEC-0.4.md section 14).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEBOUNCE_MS, searchMachine, searchProblem, type MachineHits } from "./search";
import { useStore, type Machine } from "./store";

type Slot = Pick<MachineHits, "answer" | "busy" | "problem">;
const NONE: Slot = { answer: null, busy: false, problem: null };
/** How long Try again says it's trying, for a machine whose answer may be seconds away. */
const TRYING_MS = 2000;

/**
 * The messages that match `term` (null: nothing to search for), from every machine, one request each after a 300 ms pause
 * in typing. Each machine answers on its own: one that fails says so and never holds back the others, and an answer to
 * words that have since changed is dropped. `retry` asks one machine again (a machine that isn't answering is told to
 * reconnect, and is asked once it has).
 */
export function useMessageSearch(term: string | null, machines: Machine[]) {
  const [slots, setSlots] = useState<Record<string, Slot>>({});
  // Machines told to reconnect just now: a machine that isn't answering has nothing else to show for the tap, so the
  // button says it's trying for a moment, the way Try now on the machine's own line does (ChatSidebar.tsx TryNow).
  const [trying, setTrying] = useState<ReadonlySet<string>>(() => new Set());
  // What the requests need when they finish; `round` says which search they belong to.
  const latest = useRef({ term, machines, round: 0 });
  latest.current.term = term;
  latest.current.machines = machines;
  // Searching again when a machine starts or stops answering, not whenever its chats change.
  const answering = machines.filter((m) => m.status === "open").map((m) => m.key).join("\n");

  const ask = useCallback((m: Machine, q: string, round: number) => {
    const done = (slot: Slot) => latest.current.round === round && setSlots((s) => ({ ...s, [m.key]: slot }));
    setSlots((s) => ({ ...s, [m.key]: { ...(s[m.key] ?? NONE), busy: true } }));
    searchMachine(m.conn, q).then(
      (res) => done({ answer: { query: q, ...res }, busy: false, problem: null }),
      (e) => done({ answer: null, busy: false, problem: searchProblem(e) }),
    );
  }, []);

  useEffect(() => {
    const round = ++latest.current.round;
    if (!term) {
      setSlots({});
      return;
    }
    const timer = setTimeout(() => {
      for (const m of latest.current.machines) if (m.status === "open") ask(m, term, round);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, answering, ask]);

  const retry = useCallback(
    (key: string) => {
      const m = latest.current.machines.find((x) => x.key === key);
      const q = latest.current.term;
      if (!m || !q) return;
      if (m.status === "open") ask(m, q, latest.current.round);
      else {
        setTrying((s) => new Set(s).add(key));
        useStore.getState().reconnectNow(key);
      }
    },
    [ask],
  );
  useEffect(() => {
    if (!trying.size) return;
    const t = setTimeout(() => setTrying(new Set()), TRYING_MS);
    return () => clearTimeout(t);
  }, [trying]);

  const out = useMemo(
    () =>
      machines.map((m): MachineHits => {
        // Still connecting: it's asked once it's up. Down: say so, with Try again (reconnect), which says it's trying.
        if (m.status !== "open") return { key: m.key, name: m.name, answer: slots[m.key]?.answer ?? null, busy: trying.has(m.key) || m.downSince === null, problem: m.downSince !== null ? "It isn't answering." : null };
        return { key: m.key, name: m.name, ...(slots[m.key] ?? NONE) };
      }),
    [machines, slots, trying],
  );
  // Not final yet: asked and not answered, waiting out the pause, or not up yet.
  const searching = !!term && out.some((m) => !m.problem && m.answer?.query !== term);
  return { machines: out, searching, retry };
}
