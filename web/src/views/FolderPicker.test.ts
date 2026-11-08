import { expect, test } from "bun:test";
import { folderRows } from "./FolderPicker";

test("folderRows: the machine's folders, then known ones it didn't list, once each, without temp ones, narrowed by what's typed", () => {
  const listed = ["/Users/me/App", "/var/folders/xy/workspaces/Demo"];
  const known = ["/Users/me/App", "/Users/me/Site", "/tmp/scratch", "/private/tmp/x", "/var/folders/ab/c", ""];
  // The hub's own list is kept as it is, even a folder under /var/folders (its workspaces folder can be there).
  expect(folderRows(listed, known, "")).toEqual(["/Users/me/App", "/var/folders/xy/workspaces/Demo", "/Users/me/Site"]);
  expect(folderRows(listed, known, "  site ")).toEqual(["/Users/me/Site"]);
  expect(folderRows(listed, known, "nothing")).toEqual([]);
});
