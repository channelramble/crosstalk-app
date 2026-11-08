import { expect, test } from "bun:test";
import type { Activity } from "@crosstalk/shared";
import { applyStepDelta, mergeStep, withFullDetail, type StepDelta } from "./steps";

const step = (patch: Partial<Activity> = {}): Activity => ({ id: "a1", roomId: "r", turnId: "t", memberId: "m", kind: "command", title: "npm test", detail: "", status: "running", createdAt: 1, updatedAt: 1, ...patch });
const delta = (offset: number, text: string, patch: Partial<StepDelta> = {}): StepDelta => ({ t: "activity.delta", roomId: "r", turnId: "t", activityId: "a1", offset, delta: text, updatedAt: 2, ...patch });

test("a step's output grows by its deltas, overlaps aren't repeated, and a change of status comes with them", () => {
  let a = applyStepDelta(step(), delta(0, "ok 1\n"));
  a = applyStepDelta(a, delta(5, "ok 2\n"));
  a = applyStepDelta(a, delta(5, "ok 2\nok 3\n", { status: "done", title: "npm test (2s)" }));
  expect(a).toMatchObject({ detail: "ok 1\nok 2\nok 3\n", status: "done", title: "npm test (2s)", updatedAt: 2 });
  expect(a.detailLength).toBeUndefined();
});

test("a gap, or text that differs, marks the step unfinished instead of joining the wrong text", () => {
  const gap = applyStepDelta(step({ detail: "start" }), delta(9, "later"));
  expect(gap).toMatchObject({ detail: "start", detailLength: 14 });
  const differs = applyStepDelta(step({ detail: "abc" }), delta(1, "XY"));
  expect(differs).toMatchObject({ detail: "abc", detailLength: 3 });
  // Only its start is here: an addition just makes the rest longer.
  expect(applyStepDelta(step({ detail: "head", detailLength: 5000 }), delta(5000, "more"))).toMatchObject({ detail: "head", detailLength: 5004 });
});

test("a shortened copy of a step this app has in full keeps the full detail; a different one replaces it", () => {
  const full = step({ detail: "x".repeat(3000), status: "running" });
  const short = step({ detail: "x".repeat(1200), detailLength: 3000, status: "done", updatedAt: 5 });
  const kept = mergeStep(full, short);
  expect(kept.detail.length).toBe(3000);
  expect(kept.detailLength).toBeUndefined();
  expect(kept.status).toBe("done");
  const replaced = step({ detail: "y".repeat(1200), detailLength: 4000, status: "done" });
  expect(mergeStep(full, replaced)).toEqual(replaced);
});

test("a step fetched whole takes the output that came while it was on its way, and keeps a newer status", () => {
  const full = step({ detail: "line 1\nline 2\n", detailLength: undefined, updatedAt: 3 });
  const meanwhile = [delta(7, "line 2\n"), delta(14, "line 3\n")];
  const cur = step({ detail: "line 1", detailLength: 21, status: "done", updatedAt: 9 });
  expect(withFullDetail(full, cur, meanwhile)).toMatchObject({ detail: "line 1\nline 2\nline 3\n", status: "done", updatedAt: 9 });
});
