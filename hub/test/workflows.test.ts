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
