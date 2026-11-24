// `crosstalk-hub pair` at a terminal (pairLink.ts): the link that carries the code, and the QR drawn from it.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairLink, pairScreen } from "../src/pairLink";

test("the link is the machine's address with the code in it; no link without an address a phone can open", () => {
  expect(pairLink("https://box.tail1.ts.net", "ABCD-EFGH")).toBe("https://box.tail1.ts.net/#pair=ABCD-EFGH");
  expect(pairLink("https://box.tail1.ts.net/", "ABCD-EFGH")).toBe("https://box.tail1.ts.net/#pair=ABCD-EFGH");
  expect(pairLink("http://192.168.1.20:7420", "ABCD-EFGH")).toBe("http://192.168.1.20:7420/#pair=ABCD-EFGH");
  for (const none of [null, undefined, "", "   ", "http://127.0.0.1:7420", "http://localhost:7420", "http://[::1]:7420", "box.ts.net", "ftp://box.ts.net"]) expect([none, pairLink(none, "ABCD-EFGH")]).toEqual([none, null]);
});

test("the screen is a QR code that reads dark on white in any terminal, with the address to type instead", async () => {
  const screen = await pairScreen("https://box.tail1.ts.net/#pair=ABCD-EFGH");
  expect(screen).toContain("Scan this with your phone's camera to pair it:");
  expect(screen).toContain("Or open https://box.tail1.ts.net on the phone and type the code.");
  // Its own colours (black on white), switched back off at each line's end.
  const rows = screen.split("\n").filter((l) => l.includes("\x1b[47m"));
  expect(rows.length).toBeGreaterThan(12);
  for (const row of rows) expect(row.endsWith("\x1b[0m")).toBe(true);
});

test("the command: a program that reads its output gets the one line, as ever; with --url the QR comes under it", async () => {
  const home = mkdtempSync(join(tmpdir(), "ct-pair-"));
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "pair", ...args], { env: { ...process.env, CROSSTALK_HOME: home, CROSSTALK_PUBLIC_URL: "" }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    return out;
  };
  try {
    const plain = await run("15");
    expect(plain).toMatch(/^Pairing code: [A-Z0-9]{4}-[A-Z0-9]{4}  \(valid until [^)]+\)\n$/);
    const withUrl = await run("15", "--url", "https://box.tail1.ts.net");
    const code = /^Pairing code: ([A-Z0-9-]+)/.exec(withUrl)![1];
    expect(withUrl).toContain("Scan this with your phone's camera to pair it:");
    expect(withUrl).toContain("Or open https://box.tail1.ts.net on the phone and type the code.");
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // An address only this machine can open: just the line.
    expect(await run("--url", "http://127.0.0.1:7420")).toMatch(/^Pairing code: \S+  \(valid until [^)]+\)\n$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
