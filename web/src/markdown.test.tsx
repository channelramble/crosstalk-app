import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

async function render(text: string, roomId: string | null = "r1"): Promise<string> {
  const { Markdown, RoomFilesContext } = await import("./ui");
  return renderToStaticMarkup(createElement(RoomFilesContext.Provider, { value: roomId }, createElement(Markdown, { text, handles: [] })));
}

test("file:// and path links render as project downloads through the real Markdown renderer", async () => {
  const html = await render("[kit](file:///Users/me/p/app.zip) and [notes](dist/notes%23draft.txt) and [q](dist/a%3Fb.txt)");
  expect((html.match(/project-file-link/g) ?? []).length).toBe(3);
  expect(html).toContain('title="Download /Users/me/p/app.zip"');
  expect(html).toContain('title="Download dist/notes#draft.txt"');
  expect(html).toContain('title="Download dist/a?b.txt"');
});

test("unsafe schemes are still stripped, web links stay links, and file:// outside a room isn't a dead link", async () => {
  const html = await render("[bad](javascript:alert(1)) [web](https://example.com/x.zip)");
  expect(html).not.toContain("javascript:");
  expect(html).toContain('href="https://example.com/x.zip"');
  const outside = await render("[kit](file:///Users/me/p/app.zip)", null);
  expect(outside).not.toContain("<a");
  expect(outside).toContain("kit");
});


test("a malformed escape in an attachment link cannot crash the conversation", async () => {
  const html = await render("[broken](/api/rooms/r1/uploads/12345678-1234-1234-1234-123456789abc_bad%ZZ.txt)");
  expect(html).toContain("attachment-download");
  expect(html).toContain("broken");
});
