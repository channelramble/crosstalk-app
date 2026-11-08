import { expect, test } from "bun:test";
import { projectPath } from "./links";

test("file paths in agent links become project downloads; web links don't", () => {
  expect(projectPath("/Users/you/crosstalk-workspaces/demo/app.zip")).toBe("/Users/you/crosstalk-workspaces/demo/app.zip");
  expect(projectPath("dist/app%20v2.zip")).toBe("dist/app v2.zip");
  expect(projectPath("file:///Users/me/p/a.zip")).toBe("/Users/me/p/a.zip");
  expect(projectPath("./notes.md#L10")).toBe("./notes.md");
  // Encoded # and ? are part of the file name, not a fragment or query.
  expect(projectPath("dist/notes%23draft.txt")).toBe("dist/notes#draft.txt");
  expect(projectPath("dist/notes%3Fdraft.txt")).toBe("dist/notes?draft.txt");
  expect(projectPath("dist/notes%23draft.txt?x=1#y")).toBe("dist/notes#draft.txt");
  for (const web of ["https://example.com/a.zip", "mailto:x@y.z", "#top", "/api/rooms/r/uploads/x.png", "//cdn.example.com/x", undefined]) expect(projectPath(web)).toBeNull();
});
