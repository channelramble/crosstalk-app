import type { Activity, ServerEvent } from "@crosstalk/shared";
import { mergeTextDelta } from "./stream";

export type StepDelta = Extract<ServerEvent, { t: "activity.delta" }>;

/** A step without the mark that its detail is only its start. */
function whole(a: Activity): Activity {
  const { detailLength: _, ...rest } = a;
  return rest;
}

/**
 * A step with a change from the hub applied: its new title, kind or status, and what its output added. A step whose
 * detail is only its start stays that way (it just gets longer); one that can't take the addition where it starts (a
 * gap, or text that differs) is marked unfinished the same way, so the rest is fetched when it's needed.
 */
export function applyStepDelta(a: Activity, e: StepDelta): Activity {
  const next: Activity = {
    ...a,
    updatedAt: Math.max(a.updatedAt, e.updatedAt),
    ...(e.title !== undefined ? { title: e.title } : {}),
    ...(e.kind !== undefined ? { kind: e.kind } : {}),
    ...(e.status !== undefined ? { status: e.status } : {}),
  };
  if (!e.delta) return next;
  const end = e.offset + e.delta.length;
  if (a.detailLength !== undefined) return { ...next, detailLength: Math.max(a.detailLength, end) };
  const merged = mergeTextDelta(a.detail, { offset: e.offset, delta: e.delta });
  return merged !== null ? { ...next, detail: merged } : { ...next, detailLength: Math.max(end, a.detail.length) };
}

/**
 * A whole step from the hub (an "activity" event), against what this app has: when the hub sent only the start of a
 * detail this app already has all of, the full one stays.
 */
export function mergeStep(cur: Activity | undefined, incoming: Activity): Activity {
  if (cur && cur.detailLength === undefined && incoming.detailLength !== undefined && incoming.detailLength === cur.detail.length && cur.detail.startsWith(incoming.detail)) {
    return { ...whole(incoming), detail: cur.detail };
  }
  return incoming;
}

/**
 * A step fetched whole, with what changed while it was on its way: changes that came meanwhile are applied on top
 * (their output is added where it starts, and any overlap isn't repeated), and a newer title or status is kept.
 */
export function withFullDetail(full: Activity, cur: Activity | undefined, meanwhile: StepDelta[]): Activity {
  let next = whole(full);
  for (const e of meanwhile) next = applyStepDelta(next, e);
  if (cur && cur.updatedAt > next.updatedAt) next = { ...next, title: cur.title, kind: cur.kind, status: cur.status, updatedAt: cur.updatedAt };
  return next;
}
