import { expect, test } from "bun:test";
import { toFolders, walkEntries } from "./folders";

// Minimal stand-ins for the browser's FileSystemEntry API, returning directory contents in batches like Chrome does.
type Node = { name: string; children?: Node[] };
function entry(node: Node, path = node.name): FileSystemEntry {
  if (!node.children) {
    return { name: node.name, isFile: true, isDirectory: false, fullPath: path, file: (ok: (f: File) => void) => ok(new File(["x"], node.name)) } as unknown as FileSystemEntry;
  }
  return {
    name: node.name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let at = 0;
      return { readEntries: (ok: (e: FileSystemEntry[]) => void) => { const batch = node.children!.slice(at, at + 100).map((c) => entry(c, `${path}/${c.name}`)); at += 100; ok(batch); } };
    },
  } as unknown as FileSystemEntry;
}
const files = (n: number, prefix = "f") => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}.txt` }));
const junk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `d${i}`, children: [{ name: ".DS_Store" }] }));

test("no file-count cap: a 12,000-file folder plus junk arrives whole, alongside another folder", async () => {
  const dropped = await walkEntries([entry({ name: "app", children: [...junk(500), ...files(12_000)] }), entry({ name: "small", children: files(3) })]);
  const { folders, errors } = toFolders(dropped.folderFiles, dropped.truncated);
  expect(errors).toEqual([]);
  expect(folders.map((f) => [f.name, f.files.length])).toEqual([["app", 12_000], ["small", 3]]);
});

test("a folder that can't be read completely is rejected, never sent short", async () => {
  const broken = entry({ name: "broken", children: files(5) }) as unknown as { createReader: () => unknown };
  broken.createReader = () => ({ readEntries: (_ok: unknown, fail: (e: Error) => void) => fail(new Error("NotReadableError")) });
  const dropped = await walkEntries([broken as unknown as FileSystemEntry, entry({ name: "fine", children: files(2) })]);
  const { folders, errors } = toFolders(dropped.folderFiles, dropped.truncated);
  expect(errors.some((e) => e.startsWith("broken/"))).toBe(true);
  expect(folders.map((f) => f.name)).toEqual(["fine"]);
});

test("node_modules and .git are left out and reported; everything else is kept", async () => {
  const dropped = await walkEntries([entry({ name: "app", children: [{ name: "build", children: files(2) }, { name: "node_modules", children: files(50) }, { name: ".git", children: files(5) }, { name: "README.md" }] })]);
  const { folders } = toFolders(dropped.folderFiles, dropped.truncated);
  expect(folders[0].files.map((f) => f.rel).sort()).toEqual(["app/README.md", "app/build/f0.txt", "app/build/f1.txt"]);
  expect(folders[0].skipped.sort()).toEqual([".git/", "node_modules/"]);
});
