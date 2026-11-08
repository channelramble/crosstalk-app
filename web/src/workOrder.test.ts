import { expect, test } from "bun:test";
import { currentTurn, workOrder } from "./workOrder";
import type { Member, Room, Turn } from "@crosstalk/shared";
const room = { mode: "review", leadMemberId: "b", maxHops: 5 } as Room;
const builder = { id: "b", handle: "builder", status: "working" } as Member;
const reviewer = { id: "r", handle: "reviewer", status: "idle" } as Member;
const turn = (memberId: string, hop: number, status = "running", createdAt = 1) => ({ memberId, hop, status, createdAt } as Turn);
test("build, review and final round show different future steps", () => {
  expect(workOrder(room, [builder, reviewer], [turn("b", 0)]).steps.map((s) => [s.when, s.action])).toEqual([["Now", "Building"], ["Planned next", "Reviewing"]]);
  const reviewing = [{ ...builder, status: "idle" }, { ...reviewer, status: "working" }] as Member[];
  expect(workOrder(room, reviewing, [turn("r", 1)]).steps.map((s) => s.when)).toEqual(["Now", "If fixes are needed"]);
  expect(workOrder(room, reviewing, [turn("r", 5)]).steps).toHaveLength(1);
  expect(workOrder(room, [builder, reviewer], [turn("b", 2)]).round).toBe(2);
  expect(workOrder(room, [builder, reviewer], [turn("b", 1)]).steps[0].action).toBe("Improving");
  expect(workOrder(room, reviewing, [turn("r", 2)]).round).toBe(1);
});
test("Off never promises a review, concurrent work is simultaneous, idle shows no future work", () => {
  expect(workOrder({ ...room, mode: "direct" }, [builder, reviewer], [turn("b", 0)]).steps).toHaveLength(1);
  expect(workOrder(room, [builder, { ...reviewer, status: "working" }], [turn("b", 0), turn("r", 1)]).steps.map((s) => s.when)).toEqual(["Now", "Now"]);
  expect(workOrder(room, [{ ...builder, status: "idle" }, reviewer], [turn("b", 0, "stopped")]).steps).toEqual([]);
});
test("the running turn's activity wins over a later queued turn", () => {
  expect(currentTurn(builder, [turn("b", 2, "queued", 2), turn("b", 0)])?.hop).toBe(0);
});

test("a direct reviewer answer doesn't promise a builder step or count as a review round", () => {
  const members = [{ ...builder, status: "idle" }, { ...reviewer, status: "working" }] as Member[];
  for (const origin of ["human", "mention"] as const) {
    const order = workOrder(room, members, [{ ...turn("r", 0), origin, chainId: "direct" }]);
    expect(order.steps.map((s) => [s.when, s.action])).toEqual([["Now", "Answering"]]);
    expect(order.round).toBeNull();
    expect(order.note).toContain("only if");
  }
});

test("reviewer-first and helper-first chains count actual reviews and reserve room to check fixes", () => {
  const members = [{ ...builder, status: "idle" }, { ...reviewer, status: "working" }] as Member[];
  const current = { ...turn("r", 2), origin: "loop", chainId: "first" } as Turn;
  const order = workOrder({ ...room, maxHops: 3 }, members, [current, { ...turn("r", 0, "done"), origin: "human", chainId: "first" }]);
  expect(order.round).toBe(1);
  expect(order.steps).toHaveLength(1); // a new build at hop 3 couldn't be reviewed
  const previousReview = { ...turn("r", 2, "done"), origin: "loop", chainId: "first" } as Turn;
  expect(workOrder(room, members, [{ ...current, hop: 4 }, previousReview]).round).toBe(2);
  expect(workOrder(room, [builder, reviewer], [{ ...turn("b", 3), origin: "mention", chainId: "helper" }]).round).toBe(1);
});
