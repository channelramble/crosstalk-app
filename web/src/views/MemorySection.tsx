import type { MachineMemory, MemoryHolder } from "@crosstalk/shared";
import { bytesText, holderWay } from "@crosstalk/shared";
import { api } from "../api";
import { showInSettings } from "../navigation";
import { useStore } from "../store";
import { Switch } from "../ui";
import { MEMORY_PILL, hasMemorySwitch, memoryActHelp, memoryLine, memoryPromise, memorySwap, memoryTaken, showMemory } from "../memory";
import { useMachineName } from "./MachinePicker";

/**
 * Settings → Memory. While the hub's machine is getting full it says what is squeezing it and offers the one or two
 * things that would free it -- each a tap to where that thing is switched off -- and that part is gone again once it
 * isn't. The person's own programs (a llama-server or a ComfyUI they started) get words, not a button: those are theirs
 * to quit. The switch, "Free memory by itself", is always there on a machine that has it: with it on, Crosstalk stops
 * the reply that is filling the machine before it freezes (hub/src/memory.ts); off, it only tells.
 */
export function MemorySection() {
  const memory = useStore((s) => s.memory);
  const toast = useStore((s) => s.toast);
  const machine = useMachineName();
  // The hub says the new state back to every device (the `memory` event), so nothing is kept here.
  const setActs = (memoryAct: boolean) => {
    api("PUT", "/api/settings/hub", { memoryAct }).catch((e) => toast("error", `Couldn't save: ${e instanceof Error ? e.message : String(e)}`));
  };
  return <MemoryCard memory={memory} machine={machine} onActs={setActs} />;
}

/** The card itself, from what it is given (so it can be drawn and read in a test without a hub). */
export function MemoryCard({ memory, machine, onActs }: { memory: MachineMemory | null; machine: string; onActs?: (on: boolean) => void }) {
  const squeezed = showMemory(memory);
  const hasSwitch = hasMemorySwitch(memory);
  if (!memory || (!squeezed && !hasSwitch)) return null;
  const pill = MEMORY_PILL[memory.band];
  const taken = squeezed ? memoryTaken(memory) : null;
  const swap = squeezed ? memorySwap(memory) : null;
  return (
    <>
      <h2 className="settings-heading" id="memory">
        Memory {pill && <span className={`pill ${pill.tone}`}>{pill.label}</span>}
      </h2>
      <div className="card memory-card">
        {squeezed && (
          <p className="small" role="status">
            {memoryLine(memory, machine)}
          </p>
        )}
        {squeezed && memory.holders.length > 0 && (
          <ul className="memory-list">
            {memory.holders.map((h) => (
              <HolderRow key={h.what} h={h} machine={machine} />
            ))}
          </ul>
        )}
        {taken && <p className="help">Together they hold {taken}.</p>}
        {swap && <p className="help">{swap}</p>}
        {hasSwitch && (
          <div className="row memory-act" style={{ gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>Free memory by itself</div>
              <p className="help" id="memory-act-help">
                {memoryActHelp(machine)}
              </p>
            </div>
            <Switch checked={memory.acts === true} onChange={(on) => onActs?.(on)} label="Free memory by itself" describedBy="memory-act-help" />
          </div>
        )}
        <p className="help">{memoryPromise(memory)}</p>
      </div>
    </>
  );
}

function HolderRow({ h, machine }: { h: MemoryHolder; machine: string }) {
  const way = holderWay(h);
  return (
    <li className="memory-row">
      <span className="memory-what">{h.what}</span>
      <span className="help mono memory-size">{h.bytes === null ? "size unknown" : bytesText(h.bytes)}</span>
      {way.section ? (
        <button type="button" className="btn small" onClick={() => showInSettings(way.section!)}>
          {way.text}
        </button>
      ) : (
        // An agent's reply is stopped in its chat, the agents' browser by closing its pages; the rest is yours to quit.
        <span className="help memory-yours">{h.kind === "agent" ? "Stop its reply to free it" : h.kind === "browser" ? "Close its pages to free it" : `Quit it on ${machine}`}</span>
      )}
    </li>
  );
}
