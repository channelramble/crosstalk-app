import { expect, test } from "bun:test";
import { failedFiles } from "../scripts/test-ci";

test("the CI runner reads which test files failed from a JUnit report", () => {
  const xml = `<?xml version="1.0"?><testsuites name="bun test" tests="5" failures="2">
    <testsuite name="test/a.test.ts" file="test/a.test.ts" tests="2" failures="0" errors="0"><testcase name="x"/></testsuite>
    <testsuite name="test/b.test.ts" file="test/b.test.ts" tests="2" failures="1" errors="0">
      <testsuite name="a group" file="test/b.test.ts" tests="1" failures="1"><testcase name="y"><failure/></testcase></testsuite>
    </testsuite>
    <testsuite name="test/c.test.ts" tests="1" failures="0" errors="1"></testsuite>
  </testsuites>`;
  expect(failedFiles(xml)).toEqual(["test/b.test.ts", "test/c.test.ts"]);
  expect(failedFiles("<testsuites></testsuites>")).toEqual([]);
});
