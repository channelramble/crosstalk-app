import type { MachineMemory, MemoryHolder } from "@crosstalk/shared";
import { bytesText, holderWay } from "@crosstalk/shared";
import { showInSettings } from "../navigation";
import { useStore } from "../store";
import { MEMORY_PILL, memoryLine, memorySwap, memoryTaken, showMemory } from "../memory";
import { useMachineName } from "./MachinePicker";

/**
 * Settings → Memory: shown only while the hub's machine is getting full, and gone again once it isn't. It says what
 * is squeezing the machine and offers the one or two things that would free it -- each a tap to where that thing is
 * switched off. Crosstalk never stops anything by itself, and the person's own programs (a llama-server or a ComfyUI
 * they started) get words, not a button: those are theirs to quit.
 */
export function MemorySection() {
  const memory = useStore((s) => s.memory);
  const machine = useMachineName();
  return <MemoryCard memory={memory} machine={machine} />;
}

/** The card itself, from what it is given (so it can be drawn and read in a test without a hub). */
export function MemoryCard({ memory, machine }: { memory: MachineMemory | null; machine: string }) {
  if (!showMemory(memory)) return null;
  const pill = MEMORY_PILL[memory.band];
  const taken = memoryTaken(memory);
  const swap = memorySwap(memory);
  return (
    <>
      <h2 className="settings-heading" id="memory">
        Memory {pill && <span className={`pill ${pill.tone}`}>{pill.label}</span>}
      </h2>
      <div className="card memory-card">
        <p className="small" role="status">
          {memoryLine(memory, machine)}
        </p>
        {memory.holders.length > 0 && (
          <ul className="memory-list">
            {memory.holders.map((h) => (
              <HolderRow key={h.what} h={h} machine={machine} />
            ))}
          </ul>
        )}
        {taken && <p className="help">Together they hold {taken}.</p>}
        {swap && <p className="help">{swap}</p>}
        <p className="help">Crosstalk never stops anything by itself, and never anything you started.</p>
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
        <span className="help memory-yours">Quit it on {machine}</span>
      )}
    </li>
  );
}
