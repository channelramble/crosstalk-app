import { expect, test } from "bun:test";
import type { ReplyStart, Turn } from "@crosstalk/shared";
import { replyStartsAfter } from "./hubStore";

const turn = (id: string, memberId: string, status: Turn["status"], startedAt: number | null = 1000): Pick<Turn, "id" | "memberId" | "status" | "startedAt" | "createdAt"> => ({ id, memberId, status, startedAt, createdAt: 500 });

test("a running reply is noted with when it started, and forgotten when that same reply ends", () => {
  let starts: Record<string, ReplyStart> = {};
  starts = replyStartsAfter(starts, turn("t1", "a", "running"));
  expect(starts).toEqual({ a: { turnId: "t1", at: 1000 } });
  // The same news again changes nothing (the same object: nothing redraws).
  expect(replyStartsAfter(starts, turn("t1", "a", "running"))).toBe(starts);
  // Not started yet by the hub's clock: since it was made.
  expect(replyStartsAfter({}, turn("t2", "b", "running", null))).toEqual({ b: { turnId: "t2", at: 500 } });
  // Another reply of the same agent, queued behind it or stopped in the queue, never ends the running one's.
  expect(replyStartsAfter(starts, turn("t9", "a", "queued"))).toBe(starts);
  expect(replyStartsAfter(starts, turn("t9", "a", "stopped"))).toBe(starts);
  // Its own end does, whatever the end was; so does waiting for a usage limit (the row says when it's back instead).
  for (const status of ["done", "error", "stopped", "waiting"] as const) expect(replyStartsAfter(starts, turn("t1", "a", status))).toEqual({});
  // The next reply starts the count again.
  expect(replyStartsAfter(starts, turn("t3", "a", "running", 9000))).toEqual({ a: { turnId: "t3", at: 9000 } });
  // News of a reply that was never noted changes nothing.
  expect(replyStartsAfter(starts, turn("t4", "c", "done"))).toBe(starts);
});
