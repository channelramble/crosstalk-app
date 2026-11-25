import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentPolicy, inlineScripts } from "../src/contentPolicy";

const INDEX = readFileSync(join(import.meta.dir, "../../web/index.html"), "utf8");

test("the app's page allows only its own scripts: its files, and its one inline script by hash", () => {
  const scripts = inlineScripts(INDEX);
  expect(scripts.length).toBe(1);
  expect(scripts[0]).toContain("crosstalk.theme.v1");
  const policy = contentPolicy(INDEX);
  const hash = new Bun.CryptoHasher("sha256").update(scripts[0]).digest("base64");
  expect(policy).toContain(`script-src 'self' 'sha256-${hash}'`);
  // Nothing that would let an injected script run or phone home through a frame or a plugin.
  expect(policy).not.toMatch(/script-src[^;]*('unsafe-inline'|'unsafe-eval'|\*|https:|data:|blob:)/);
  for (const part of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-src 'none'", "frame-ancestors 'none'", "form-action 'none'", "worker-src 'self'"]) expect(policy).toContain(part);
  // What the app needs: pictures from memory and data:, connections to the person's other machines.
  expect(policy).toContain("img-src 'self' data: blob:");
  expect(policy).toContain("connect-src 'self' https: wss: http: ws:");
});

test("a page with other inline scripts gets a hash for each, and one with none gets none", () => {
  expect(inlineScripts('<script src="/a.js"></script><script type="module" src="/b.js"></script>')).toEqual([]);
  expect(inlineScripts("<script>one()</script><p><script>\n  two();\n</script>")).toEqual(["one()", "\n  two();\n"]);
  expect(contentPolicy("<html></html>")).toContain("script-src 'self';");
  expect((contentPolicy("<script>a</script><script>b</script>").match(/'sha256-/g) ?? []).length).toBe(2);
});
