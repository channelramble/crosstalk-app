import { expect, test } from "bun:test";
import { plainHttpElsewhere, safeApiPath } from "./api";
import { ATTACHMENT_URL, FOLDER_URL, urlTransform } from "./links";

test("the app asks a machine only for paths it could have built: no step up the path, encoded or not, no backslash", () => {
  for (const ok of ["/api/state", "/api/rooms/r_abc-1/history?limit=80&before=3", "/api/accounts/claude/default/refresh-models", "/api/rooms/r1/uploads/a%20b.png", "/internal/setup/status", "/api/local-models/files?repo=a%2Fb"]) expect([ok, safeApiPath(ok)]).toEqual([ok, true]);
  for (const bad of ["/api/rooms/../history", "/api/rooms/..\\..\\api\\devices?/history", "/api/rooms/%2e%2e/folders/%2E%2e/health", "/api/rooms/a%2fb/history", "/api/rooms/a%5cb", "/api/./state", "/elsewhere", "https://other.example/api/state", "//other.example/api/state", "/api/rooms/.."]) {
    expect([bad, safeApiPath(bad)]).toEqual([bad, false]);
  }
});

test("a file sent in a chat is named by a chat, a folder and a name: never by a step up the path", () => {
  expect(ATTACHMENT_URL.test("/api/rooms/r_1/uploads/photo.png")).toBe(true);
  expect(ATTACHMENT_URL.test("/api/rooms/r_1/uploads/a%20b.final.png")).toBe(true);
  expect(FOLDER_URL.test("/api/rooms/r_1/folders/6f1c2d3e-aaaa-bbbb-cccc-000000000000/site")).toBe(true);
  for (const bad of ["/api/rooms/x/uploads/..", "/api/rooms/x/uploads/.", "/api/rooms/%2e%2e/uploads/a", "/api/rooms/x/uploads/%2e%2e", "/api/rooms/x/uploads/a%2fb", "/api/rooms/x/uploads/a\\b", "/api/rooms/x/uploads/a?b", "/api/rooms/x/y/uploads/a"]) expect([bad, ATTACHMENT_URL.test(bad)]).toEqual([bad, false]);
  for (const bad of ["/api/rooms/%2e%2e/folders/%2e%2e/health", "/api/rooms/x/folders/../health", "/api/rooms/x/folders/f/..", "/api/rooms/x/folders/f/%2E%2E"]) expect([bad, FOLDER_URL.test(bad)]).toEqual([bad, false]);
});

test("a reply's links go to the web, to mail, to a file of the project, or stay in the app", () => {
  const fallback = (u: string) => (/^(javascript|data|vbscript):/i.test(u) ? "" : u);
  for (const ok of ["https://example.com/a", "http://example.com", "mailto:someone@example.com", "#/room/r1", "/api/rooms/r1/uploads/a.png", "docs/readme.md", "file:///Users/someone/project/a.txt"]) expect(urlTransform(ok, fallback)).toBe(ok);
  for (const bad of ["xmpp:a@b", "irc://host/chan", "ircs://host/chan", "tel:123", "sms:123", "intent://x", "tauri://localhost", "javascript:alert(1)"]) expect([bad, urlTransform(bad, fallback)]).toEqual([bad, ""]);
});

test("a pairing code goes over plain http only to this device or an address on your own network", () => {
  for (const ok of ["https://mini.example.ts.net", "https://203.0.113.9", "http://127.0.0.1:7420", "http://localhost:7420", "http://192.168.1.20:7420", "http://10.0.0.4", "http://172.20.1.1", "http://100.101.102.103:7420", "http://linux-box:7420", "http://studio.local:7420", "http://[::1]:7420", "http://[fd7a:115c:a1e0::1]:7420", ""]) {
    expect([ok, plainHttpElsewhere(ok)]).toEqual([ok, false]);
  }
  for (const bad of ["http://example.com", "http://203.0.113.9:7420", "http://mini.example.ts.net", "http://172.32.0.1", "http://100.128.0.1"]) expect([bad, plainHttpElsewhere(bad)]).toEqual([bad, true]);
});
