// Runs each agent's installer the way Settings does, in an empty home, and asks what it installed for its version.
// Twice for the ones that run on Node.js: with the machine's own, and with none on the PATH (Crosstalk then gets one
// for itself: providers/node.ts). Nothing is signed in. For CI and for trying a new machine by hand:
//   bun scripts/agents-check.ts [claude codex gemini opencode]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProvider } from "../src/providers/claude";
import { codexProvider } from "../src/providers/codex";
import { geminiProvider } from "../src/providers/gemini";
import { ownNodeBin } from "../src/providers/node";
import { opencodeProvider } from "../src/providers/opencode";

const all = { claude: claudeProvider, codex: codexProvider, gemini: geminiProvider, opencode: opencodeProvider };
const asked = process.argv.slice(2);
const names = (asked.length ? asked : Object.keys(all)) as (keyof typeof all)[];
const BARE = "/usr/bin:/bin";
let failed = 0;

async function check(name: keyof typeof all, withNode: boolean) {
  const mod = all[name];
  const home = mkdtempSync(join(tmpdir(), `ct-agent-${name}-`));
  const path = withNode ? `${process.env.PATH}` : BARE;
  const label = `${name}${withNode ? "" : " (no Node.js on the machine)"}`;
  try {
    // A login shell would read the real profile and put the machine's Node.js back: a plain one keeps the PATH given.
    const cmd = mod.installCommand!.map((c) => (c === "-lc" ? "-c" : c));
    const install = Bun.spawn(cmd, { env: { HOME: home, PATH: path, LANG: "en_US.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited]);
    if (code !== 0) throw new Error(`its installer ended with ${code}:\n${(out + err).split("\n").slice(-15).join("\n")}`);
    // Found where Crosstalk looks for it, and run with the PATH Crosstalk gives it.
    const places = [...(mod.extraPaths ?? []), "~/.local/bin"].map((p) => p.replace(/^~/, home));
    const bin = places.flatMap((dir) => mod.binNames.map((b) => join(dir, b))).find((p) => Bun.file(p).size > 0);
    if (!bin) throw new Error(`nothing named ${mod.binNames.join(" or ")} in ${places.join(", ")}`);
    const run = Bun.spawn([bin, ...(mod.versionArgs ?? ["--version"])], { env: { HOME: home, PATH: `${path}:${ownNodeBin().replace(process.env.HOME ?? "~", home)}`, LANG: "en_US.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    const [version, verr, vcode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    if (vcode !== 0 || !version.trim()) throw new Error(`it doesn't run: ${(version + verr).trim().slice(0, 400)}`);
    console.log(`✓ ${label}: ${version.trim().split("\n")[0]}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${label}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

for (const name of names) {
  await check(name, true);
  if (name === "gemini" || name === "opencode") await check(name, false);
}
process.exit(failed ? 1 : 0);
