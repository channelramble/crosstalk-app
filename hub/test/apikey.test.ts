import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Claude API keys: the workspace header, keeping the key when only the workspace changes, and renames", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-apikey-"));
  try {
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/apikey-workspace.ts")], { env: { ...process.env, CROSSTALK_HOME: dir, PATH: "/usr/bin:/bin" } });
    const lines = r.stdout.toString().trim().split("\n");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(lines[lines.length - 1])).toEqual({
      header: "anthropic-workspace-id: wrkspc_01ABC",
      key: true,
      listed: "wrkspc_01ABC",
      badId: expect.stringContaining("wrkspc_"),
      cleared: null,
      keptKey: true,
      renamedKind: "apikey",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
