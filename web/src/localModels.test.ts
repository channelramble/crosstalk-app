import { expect, test } from "bun:test";
import type { LocalModel } from "@crosstalk/shared";
import { endMove, failMove, moveKey, poolLine, rowView, serverMemory, sortModels, startMove, unloadText, whyNotes } from "./localModels";

const GB = 1024 ** 3;
const NOW = 1_800_000_000_000;
const model = (over: Partial<LocalModel> = {}): LocalModel => ({ id: "qwen3:8b", loaded: false, loading: false, contextWindow: null, sizeBytes: null, memoryBytes: null, vramBytes: null, expiresAt: null, canSwitch: true, why: null, ...over });

test("how long until a model unloads, in a few words", () => {
  expect(unloadText(-5000)).toBe("unloads any moment");
  expect(unloadText(0)).toBe("unloads any moment");
  expect(unloadText(30_000)).toBe("unloads in under a minute");
  expect(unloadText(60_000)).toBe("unloads in 1 min");
  expect(unloadText(4 * 60_000 + 10_000)).toBe("unloads in 5 min");
  expect(unloadText(30 * 60_000)).toBe("unloads in 30 min");
  expect(unloadText(60 * 60_000)).toBe("unloads in 1 h");
  expect(unloadText(65 * 60_000)).toBe("unloads in 1 h 5 min");
  expect(unloadText(3 * 24 * 3600_000)).toBe("unloads in 3 days");
});

test("a model's row: off uses no memory, on says what it holds and when it unloads", () => {
  expect(rowView(model(), undefined, NOW)).toEqual({ on: false, noSwitch: false, disabled: false, working: false, line: "Off. Uses no memory.", problem: null });
  expect(rowView(model({ loaded: true, memoryBytes: 5.7 * GB, vramBytes: 5.7 * GB, expiresAt: NOW + 4 * 60_000 }), undefined, NOW)).toMatchObject({ on: true, disabled: false, working: false, line: "On · 5.7 GB · unloads in 4 min" });
  // Memory the server doesn't say: just On. Part of it outside graphics memory is said.
  expect(rowView(model({ loaded: true }), undefined, NOW).line).toBe("On");
  expect(rowView(model({ loaded: true, memoryBytes: 8 * GB, vramBytes: 5 * GB }), undefined, NOW).line).toBe("On · 8.0 GB · 5.0 GB of it in graphics memory");
  expect(rowView(model({ loaded: true, memoryBytes: 8 * GB, vramBytes: 7.9 * GB }), undefined, NOW).line).toBe("On · 8.0 GB");
  // A model that can't be switched from here shows its state, with the switch off limits.
  expect(rowView(model({ loaded: true, canSwitch: false, why: "LM Studio is switched in its own app." }), undefined, NOW)).toMatchObject({ on: true, disabled: true, noSwitch: false });
  expect(rowView(model({ canSwitch: false }), undefined, NOW)).toMatchObject({ on: false, disabled: true, line: "Off. Uses no memory." });
  // A server that doesn't say what it has loaded has no switch to show.
  expect(rowView(model({ loaded: null, canSwitch: false }), undefined, NOW)).toMatchObject({ noSwitch: true, line: "Doesn't say whether it's loaded." });
  // One that is loading (llama.cpp's router) shows on, working, and can't be moved meanwhile.
  expect(rowView(model({ loading: true }), undefined, NOW)).toMatchObject({ on: true, working: true, disabled: true, line: "Loading…" });
});

test("the switch's states: loading, freeing memory, a failure with its reason, and back to how it stands", () => {
  const key = moveKey("ollama-11434", "qwen3:8b");
  expect(key).toBe("ollama-11434\nqwen3:8b");
  const loaded = model({ loaded: true, memoryBytes: 6 * GB });
  const off = model();

  // Turning a loaded model off: the switch shows off at once, "Freeing memory…", and can't be moved again.
  let moves = startMove({}, key, false);
  expect(rowView(loaded, moves[key], NOW)).toEqual({ on: false, noSwitch: false, disabled: true, working: true, line: "Freeing memory…", problem: null });
  // Turning one on: "Loading…".
  expect(rowView(off, startMove({}, key, true)[key], NOW)).toEqual({ on: true, noSwitch: false, disabled: true, working: true, line: "Loading…", problem: null });

  // It didn't work: the switch goes back to how the model really is, the reason shows, and Try again knows where it was going.
  moves = failMove(moves, key, "Ollama couldn't free qwen3:8b: it answered with error 500.");
  expect(rowView(loaded, moves[key], NOW)).toMatchObject({ on: true, disabled: false, working: false, problem: "Ollama couldn't free qwen3:8b: it answered with error 500." });
  expect(moves[key].to).toBe(false);
  // Try again moves it once more (the failure goes while it does).
  moves = startMove(moves, key, moves[key].to);
  expect(moves[key]).toEqual({ to: false, failed: null });
  // Worked, or Keep it as it was: nothing is left of it, and other models' moves stay.
  const other = moveKey("ollama-11434", "gemma3:12b");
  const both = startMove(failMove(moves, key, "no"), other, true);
  expect(Object.keys(endMove(both, key))).toEqual([other]);
  expect(endMove({}, key)).toEqual({});
  expect(rowView(loaded, endMove(both, key)[key], NOW).line).toBe("On · 6.0 GB");
  // The start never changes what it was given.
  expect(Object.keys(startMove({}, key, true))).toEqual([key]);
  expect(Object.keys(both)).toEqual([key, other]);
});

test("models in memory come first, and a reason a server can't be switched is said once", () => {
  const rows = [model({ id: "c" }), model({ id: "a", loaded: true }), model({ id: "b", loading: true }), model({ id: "d", loaded: true })];
  expect(sortModels(rows).map((m) => m.id)).toEqual(["a", "d", "b", "c"]);
  expect(rows.map((m) => m.id)).toEqual(["c", "a", "b", "d"]);
  const lm = "LM Studio is switched in its own app.";
  expect(whyNotes([model({ canSwitch: false, why: lm }), model({ canSwitch: false, why: lm }), model()])).toEqual([lm]);
  expect(whyNotes([model(), model()])).toEqual([]);
});

test("the server's memory and the model pool's state, in a word", () => {
  expect(serverMemory({ memoryBytes: 6.4 * GB })).toBe("6.4 GB");
  expect(serverMemory({ memoryBytes: 300 * 1024 ** 2 })).toBe("300 MB");
  expect(serverMemory({ memoryBytes: null })).toBe("not known");
  expect([undefined, "off", "running", "preparing", "downloading", "starting", "stopping", "error"].map((s) => poolLine(s as never))).toEqual([null, "Off", "On", "Starting…", "Starting…", "Starting…", "Turning off…", "Problem"]);
});
