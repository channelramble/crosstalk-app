import { expect, test } from "bun:test";
import { bundleIn, runningBundle } from "./version";

test("spots when the hub serves a different app bundle than the page is running", () => {
  const doc = { querySelectorAll: () => [{ getAttribute: () => "/assets/index-CZYLJZtG.js" }] } as unknown as Document;
  expect(runningBundle(doc)).toBe("assets/index-CZYLJZtG.js");
  expect(bundleIn('<script type="module" crossorigin src="/assets/index-NEWhash1.js"></script>')).toBe("assets/index-NEWhash1.js");
  // Dev server and native builds have no hashed bundle, so they never show the banner.
  expect(runningBundle({ querySelectorAll: () => [{ getAttribute: () => "/src/main.tsx" }] } as unknown as Document)).toBeNull();
});
