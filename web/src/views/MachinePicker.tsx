import { ChevronDown, Server } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { canNavigate } from "../navigation";
import { machineTag } from "../chatList";
import { useMachines, useStore } from "../store";

/**
 * Which machine a screen shows (its agents, settings, terminal…), for devices paired with more than one machine.
 * Chats keep running on every machine whichever one is picked here.
 */
export function MachinePicker() {
  const machines = useMachines((m) => m.list);
  const active = useStore((s) => s.active);
  const activate = useStore((s) => s.activate);
  if (machines.length < 2) return null;
  return (
    <label className="machine-picker" title="Which machine this screen shows">
      <Server size={14} aria-hidden="true" />
      <select value={active} onChange={(e) => { if (e.target.value !== active && canNavigate()) activate(e.target.value); }} aria-label="Machine">
        {machines.map((m) => (
          <option key={m.key} value={m.key}>
            {m.name}
            {m.status === "open" ? "" : " (offline)"}
          </option>
        ))}
      </select>
      <ChevronDown size={13} aria-hidden="true" />
    </label>
  );
}

/**
 * The machine a screen shows, as a sentence says it ("a shell on Mac mini"): its name, or "this machine" until its hub
 * has said. Crosstalk runs on Linux as well as on a Mac, so screens don't assume which.
 */
export function useMachineName(): string {
  return useStore((s) => s.hub?.name || s.hub?.hostname?.replace(/\.local$/, "") || "this machine");
}

/**
 * A chat's machine, shown next to it when this device uses more than one, in the fewest words that tell the machines
 * apart (machineTag): "Mac mini" shows as "Mac" beside "Linux box", but as "mini" beside "Mac Studio".
 */
export function MachineTag({ name }: { name: string }) {
  const names = useMachines(useShallow((m) => m.list.map((x) => x.name)));
  return (
    <span className="machine-tag" title={`On ${name}`}>
      {machineTag(name, names)}
    </span>
  );
}
