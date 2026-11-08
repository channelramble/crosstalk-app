import { expect, test } from "bun:test";
import { costLabel, usd } from "./money";

test("dollar figures are short on a phone", () => {
  expect(usd(0)).toBe("$0.00");
  expect(usd(0.004)).toBe("<$0.01");
  expect(usd(0.04)).toBe("$0.04");
  expect(usd(1.234)).toBe("$1.23");
  expect(usd(47.2)).toBe("$47.20");
  expect(usd(99.999)).toBe("$100");
  expect(usd(200)).toBe("$200");
  expect(usd(1234.5)).toBe("$1,235");
  expect(usd(-3)).toBe("$0.00");
  expect(usd(Number.NaN)).toBe("—");
});

test("a cost says how sure it is", () => {
  expect(costLabel(0.04, "exact")).toBe("$0.04");
  expect(costLabel(0.04, "estimated")).toBe("≈$0.04");
  expect(costLabel(null, "estimated")).toBe("—");
  expect(costLabel(null, "unknown")).toBe("—");
  expect(costLabel(0.5, "unknown")).toBe("—");
  expect(costLabel(null, "free")).toBe("Free");
  expect(costLabel(3, "plan")).toBe("Plan");
  expect(costLabel(null, "exact")).toBe("—");
});
