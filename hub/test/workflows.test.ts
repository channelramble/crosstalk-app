import { expect, test } from "bun:test";
import { YAML } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// GitHub runs nothing from a workflow file it can't read, and says so only on its own site: a release tag once
// built nothing because a step's name had a colon in it. Every workflow must at least be YAML with jobs and steps.
const DIR = join(import.meta.dir, "../../.github/workflows");

test("every GitHub workflow file is readable YAML with jobs that have steps", () => {
  const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const doc = YAML.parse(readFileSync(join(DIR, file), "utf8")) as { name?: string; on?: unknown; jobs?: Record<string, { steps?: { name?: unknown; run?: unknown; uses?: unknown }[] }> };
    expect(typeof doc.name, `${file} has a name`).toBe("string");
    expect(doc.on, `${file} says when it runs`).toBeTruthy();
    const jobs = Object.entries(doc.jobs ?? {});
    expect(jobs.length, `${file} has jobs`).toBeGreaterThan(0);
    for (const [id, job] of jobs) {
      expect(Array.isArray(job.steps) && job.steps.length > 0, `${file} ${id} has steps`).toBe(true);
      for (const step of job.steps ?? []) {
        expect(typeof step.run === "string" || typeof step.uses === "string", `${file} ${id}: every step runs or uses something`).toBe(true);
        if (step.name !== undefined) expect(typeof step.name, `${file} ${id}: a step's name is plain text`).toBe("string");
      }
    }
  }
});

// What runs with the right to publish is kept small and fixed: a tag someone moves, or a package that turns bad, must
// not be able to put out a release or read the key releases are signed with.
test("workflows read the repo and no more, name every action by its exact commit, and publish from jobs that run none of the repo's code", () => {
  for (const file of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const doc = YAML.parse(readFileSync(join(DIR, file), "utf8")) as {
      permissions?: Record<string, string>;
      jobs: Record<string, { permissions?: Record<string, string>; steps: { run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }[] }>;
    };
    expect(doc.permissions, `${file}: the run itself may only read`).toEqual({ contents: "read" });
    for (const [id, job] of Object.entries(doc.jobs)) {
      const writes = Object.values(job.permissions ?? {}).includes("write");
      for (const step of job.steps) {
        if (step.uses) expect(step.uses, `${file} ${id}: an action by its commit`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        if (step.uses?.startsWith("actions/checkout@")) expect(step.with?.["persist-credentials"], `${file} ${id}: the checkout keeps no token`).toBe(false);
        const secret = Object.values(step.env ?? {}).some((v) => /secrets\.|github\.token/.test(String(v)));
        if (secret) expect(writes, `${file} ${id}: a token or key only in a job that publishes`).toBe(true);
        if (!writes) continue;
        // A job that may publish: the finished files only. No checkout, no installing, nothing of the repo's is run.
        if (step.uses) expect(step.uses, `${file} ${id}`).toMatch(/^actions\/download-artifact@/);
        expect(step.run ?? "", `${file} ${id}: runs none of the repo's code`).not.toMatch(/\b(bun|bunx|npm|npx|node|cargo|tauri|make|bash [\w./-]+\.sh|sh [\w./-]+\.sh)\b/);
        expect(step.run ?? "", `${file} ${id}: replaces nothing that's published`).not.toContain("--clobber");
      }
    }
  }
});

test("the release is signed before it's published, by a key the version being released knows", () => {
  const text = readFileSync(join(DIR, "release.yml"), "utf8");
  const doc = YAML.parse(text) as { jobs: Record<string, { needs?: string | string[]; steps: { name?: string; run?: string }[] }> };
  const steps = doc.jobs.publish.steps.map((s) => s.run ?? "");
  const sign = steps.findIndex((r) => r.includes("SHA256SUMS.sig"));
  const publish = steps.findIndex((r) => r.includes("gh release create"));
  expect(sign).toBeGreaterThanOrEqual(0);
  expect(publish).toBeGreaterThan(sign);
  expect(steps[sign]).toContain("meta/release-keys");
  expect(steps[sign]).toContain("pkeyutl -verify");
  expect(doc.jobs.build.steps.some((s) => (s.run ?? "").includes("RELEASE_KEYS"))).toBe(true);
});
