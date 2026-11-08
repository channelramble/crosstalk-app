import type { LocalModel, LocalModelServer, PoolState } from "@crosstalk/shared";
import { bytes } from "./services";

// Settings → Local models (views/LocalModelsSection.tsx): its words and the switch's state machine as pure functions, so they can be tested.

/** A switch the person moved: on its way (the hub is loading or freeing the model), or one that didn't work (`failed` says why). */
export interface Move {
  to: boolean;
  failed: string | null;
}
export type Moves = Readonly<Record<string, Move>>;

export const moveKey = (serverId: string, model: string) => `${serverId}\n${model}`;
export const startMove = (moves: Moves, key: string, to: boolean): Moves => ({ ...moves, [key]: { to, failed: null } });
export const failMove = (moves: Moves, key: string, why: string): Moves => ({ ...moves, [key]: { to: moves[key]?.to ?? true, failed: why } });
/** The switch worked, or the person chose "Keep it as it was". */
export function endMove(moves: Moves, key: string): Moves {
  const rest = { ...moves };
  delete rest[key];
  return rest;
}

/** "unloads in 4 min": how long until the server frees a model by itself. */
export function unloadText(ms: number): string {
  if (ms <= 0) return "unloads any moment";
  const minutes = Math.ceil(ms / 60_000);
  if (ms < 60_000) return "unloads in under a minute";
  if (minutes < 60) return `unloads in ${minutes} min`;
  if (minutes < 24 * 60) return `unloads in ${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return `unloads in ${Math.round(minutes / (24 * 60))} days`;
}

/** What one model's row shows. */
export interface RowView {
  /** Where the switch sits: where it was moved to while it moves, else whether the model is loaded. */
  on: boolean;
  /** No switch at all: the server doesn't say whether the model is loaded. */
  noSwitch: boolean;
  /** It can't be used now: it's moving, loading, or the model can't be switched from here. */
  disabled: boolean;
  /** It's on its way (a spinner shows). */
  working: boolean;
  /** Under the model's name, in a few words. */
  line: string;
  /** What went wrong with the last switch: Try again and Keep it as it was go under it. */
  problem: string | null;
}

export function rowView(m: LocalModel, move: Move | undefined, now: number): RowView {
  const problem = move?.failed ?? null;
  if (move && !move.failed) return { on: move.to, noSwitch: false, disabled: true, working: true, line: move.to ? "Loading…" : "Freeing memory…", problem: null };
  if (m.loading) return { on: true, noSwitch: false, disabled: true, working: true, line: "Loading…", problem };
  if (m.loaded === null) return { on: false, noSwitch: true, disabled: true, working: false, line: "Doesn't say whether it's loaded.", problem };
  if (!m.loaded) return { on: false, noSwitch: false, disabled: !m.canSwitch, working: false, line: "Off. Uses no memory.", problem };
  const inGraphics = m.vramBytes !== null && m.memoryBytes !== null && m.vramBytes < m.memoryBytes * 0.95 ? `${bytes(m.vramBytes)} of it in graphics memory` : null;
  const line = ["On", m.memoryBytes ? bytes(m.memoryBytes) : null, inGraphics, m.expiresAt !== null ? unloadText(m.expiresAt - now) : null].filter(Boolean).join(" · ");
  return { on: true, noSwitch: false, disabled: !m.canSwitch, working: false, line, problem };
}

/** Models in memory first, then those loading, then the rest (each group in the server's order). */
export function sortModels(models: LocalModel[]): LocalModel[] {
  const rank = (m: LocalModel) => (m.loaded ? 0 : m.loading ? 1 : 2);
  return [...models].sort((a, b) => rank(a) - rank(b));
}

/** What a server holds in this machine's memory, for its card. */
export function serverMemory(s: Pick<LocalModelServer, "memoryBytes">): string {
  return s.memoryBytes ? bytes(s.memoryBytes) : "not known";
}

/** Each reason a model can't be switched from here, once (every model of LM Studio says the same). */
export function whyNotes(models: LocalModel[]): string[] {
  return [...new Set(models.filter((m) => !m.canSwitch && m.why).map((m) => m.why!))];
}

/** The model pool's on/off state, for its line in Local models; null when the hub hasn't said. */
export function poolLine(state: PoolState | undefined): string | null {
  switch (state) {
    case undefined:
      return null;
    case "off":
      return "Off";
    case "running":
      return "On";
    case "stopping":
      return "Turning off…";
    case "error":
      return "Problem";
    default:
      return "Starting…";
  }
}
