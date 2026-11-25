import { expect, test } from "bun:test";
import { quietSoon } from "./quietDevices";

const DAY = 86_400_000;
const now = 1_800_000_000_000;
const said = (daysAgo: number, scope: "full" | "peer" = "full") => ({ createdAt: now - 90 * DAY, lastMessageAt: now - daysAgo * DAY, scope });

test("a device's line says when it will be signed out, once that's a week away or less", () => {
  expect(quietSoon(said(5), 30, now)).toBe("");
  expect(quietSoon(said(22), 30, now)).toBe("");
  expect(quietSoon(said(23), 30, now)).toBe(" · signs out in 7 days unless it sends a message");
  expect(quietSoon(said(27.5), 30, now)).toBe(" · signs out in 3 days unless it sends a message");
  expect(quietSoon(said(29.5), 30, now)).toBe(" · signs out within a day unless it sends a message");
  // Never for a linked machine, with the switch off, or on a machine that doesn't say when a device last spoke.
  expect(quietSoon(said(29, "peer"), 30, now)).toBe("");
  expect(quietSoon(said(29), 0, now)).toBe("");
  expect(quietSoon(said(29), null, now)).toBe("");
  expect(quietSoon({ createdAt: now - 90 * DAY, scope: "full" }, 30, now)).toBe("");
});
