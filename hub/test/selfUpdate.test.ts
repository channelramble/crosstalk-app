// Updates from the app (hub/src/selfUpdate.ts), against a made-up release server on 127.0.0.1 and a made-up program (a
// shell script that says a version) in a temporary folder. Nothing here asks GitHub anything or touches a real install.

import { afterEach, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, installWords, type HubUpdate, type UpdateInstall } from "@crosstalk/shared";
import { App } from "../src/app";
import { startServer } from "../src/server";
import { CantUpdate, RELEASE_KEYS, SelfUpdate, programName, pruneBackups, releaseSource, signLikeTheInstaller, signedByOne, type SelfUpdateDeps } from "../src/selfUpdate";
import { nextBuildPath, stagedBuild, takeNextBuild } from "../src/setup/system";
import { Updater } from "../src/update";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
/** The made-up program: all it can do is say its version. */
const program = (version: string) => `#!/bin/sh\necho ${version}\n# ${"padding ".repeat(4000)}\n`;

/** The made-up releases' own signing key (the real one's private half is nowhere near a test), and somebody else's. */
const KEY = generateKeyPairSync("ed25519");
const OTHER = generateKeyPairSync("ed25519");
const publicHalf = (k: typeof KEY) => k.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const signed = (text: string, k: typeof KEY = KEY) => sign(null, Buffer.from(text), k.privateKey).toString("base64") + "\n";

interface Release {
  /** Its list of checksums is signed by someone else, isn't signed at all, or was changed after it was signed. */
  signature?: "another key" | "none" | "list changed";
  tag: string;
  notes?: string;
  /** What the program in the release says its version is (the tag's, unless a test wants a wrong one). */
  says?: string;
  /** The files' names (every platform's, unless a test leaves some out). */
  names?: string[];
  /** A checksum that isn't the file's. */
  wrongSum?: boolean;
  prerelease?: boolean;
}

const ALL = ["crosstalk-hub-darwin-arm64", "crosstalk-hub-darwin-x64", "crosstalk-hub-linux-x64", "crosstalk-hub-linux-arm64"];

/** A release server like GitHub's, as far as the hub asks: the newest release, its SHA256SUMS and its programs. */
function releases(first: Release) {
  const state = {
    release: first,
    /** Every request: its path and what it said about who asks. */
    asked: [] as { path: string; agent: string | null; headers: string[] }[],
    /** Holds a download half way until it's let go (`release()`), or for ever. */
    hold: null as Promise<void> | null,
    /** The download ends half way. */
    cut: false,
  };
  const body = (name: string) => `${program(state.release.says ?? state.release.tag.replace(/^v/, ""))}# ${name}\n`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      state.asked.push({ path: url.pathname + url.search, agent: req.headers.get("user-agent"), headers: [...req.headers.keys()].sort() });
      const names = state.release.names ?? ALL;
      if (url.pathname === "/latest") {
        return Response.json({ tag_name: state.release.tag, body: state.release.notes ?? "", prerelease: !!state.release.prerelease, assets: names.map((name) => ({ name, size: body(name).length })) });
      }
      const name = url.pathname.replace(/^\/files\//, "");
      const sums = names.map((n) => `${state.release.wrongSum ? sha256("something else") : sha256(body(n))}  ${n}`).join("\n") + "\n";
      if (name === "SHA256SUMS") return new Response(sums);
      if (name === "SHA256SUMS.sig") {
        const how = state.release.signature;
        if (how === "none") return new Response("Not Found", { status: 404 });
        return new Response(signed(how === "list changed" ? sums.replace(/^./, "0") + "\n" : sums, how === "another key" ? OTHER : KEY));
      }
      if (!names.includes(name)) return new Response("Not Found", { status: 404 });
      const text = body(name);
      if (!state.hold && !state.cut) return new Response(text);
      const half = Math.floor(text.length / 2);
      const hold = state.hold;
      const cut = state.cut;
      return new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(new TextEncoder().encode(text.slice(0, half)));
            if (cut) return c.close();
            await hold;
            c.enqueue(new TextEncoder().encode(text.slice(half)));
            c.close();
          },
        }),
      );
    },
  });
  cleanups.push(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  return { state, base, stop: () => server.stop(true), files: () => state.asked.map((a) => a.path) };
}

/** Runs only what's in the test's own folder (the made-up program); anything else is noted and not run. */
function runner(dir: string, answers: Record<string, { code: number; out: string }> = {}) {
  const ran: string[][] = [];
  const run = async (args: string[]) => {
    ran.push(args);
    if (!args[0].startsWith(dir)) return answers[args[0]] ?? { code: 0, out: "" };
    try {
      const p = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      return { code: await p.exited, out };
    } catch {
      return null;
    }
  };
  return { run, ran };
}

/** An installed Crosstalk 0.9.1 in a temporary folder, updating from `server`. */
function installed(server: ReturnType<typeof releases> | null, over: Partial<SelfUpdateDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ct-selfupdate-"));
  cleanups.push(() => (chmodSync(dir, 0o755), rmSync(dir, { recursive: true, force: true })));
  const path = join(dir, "crosstalk-hub");
  writeFileSync(path, program("0.9.1"), { mode: 0o755 });
  const { run, ran } = runner(dir);
  const t = { said: 0, steps: [] as string[], ready: null as HubUpdate | null, looked: 0 };
  const u: SelfUpdate = new SelfUpdate({
    version: "0.9.1",
    path,
    compiled: true,
    platform: "linux",
    arch: "x64",
    latestUrl: server ? `${server.base}/latest` : "http://127.0.0.1:9/latest",
    fileUrl: (_tag, name) => (server ? `${server.base}/files/${name}` : `http://127.0.0.1:9/files/${name}`),
    keys: [publicHalf(KEY)],
    run,
    restarts: async () => true,
    ready: () => t.ready,
    staged: async () => void t.looked++,
    changed: () => {
      t.said++;
      const i = u.brief().install;
      const step = i ? `${i.step}${i.percent === null ? "" : ` ${i.percent}`}` : "none";
      if (t.steps.at(-1) !== step) t.steps.push(step);
    },
    ...over,
  });
  cleanups.push(() => u.stop());
  return { u, t, dir, path, ran, files: () => readdirSync(dir).sort() };
}

test("versions compare by their numbers: 0.10.0 is newer than 0.9.1, and anything that isn't three numbers is never offered", () => {
  expect(compareVersions("0.10.0", "0.9.1")).toBeGreaterThan(0);
  expect(compareVersions("0.9.1", "0.10.0")).toBeLessThan(0);
  expect(compareVersions("v1.0.0", "0.99.99")).toBeGreaterThan(0);
  expect(compareVersions("0.9.1", "v0.9.1")).toBe(0);
  expect(compareVersions("0.9.10", "0.9.9")).toBeGreaterThan(0);
  for (const odd of ["0.10.0-beta.1", "nightly", "0.10", "", "1.2.3.4", "0.10.0\nrm -rf"]) expect(compareVersions(odd, "0.9.1")).toBeNull();
});

test("a newer release is offered with its notes; the same one and an older one are not", async () => {
  const server = releases({ tag: "v0.10.0", notes: "- Updates from the app\n- Fixes" });
  const { u, t } = installed(server);
  expect(await u.status()).toMatchObject({ version: "0.9.1", can: true, why: null, available: null, checkedAt: null, checkFailed: false, install: null });
  await u.check();
  const s = await u.status();
  expect(s).toMatchObject({ available: "0.10.0", notes: "- Updates from the app\n- Fixes", checkFailed: false });
  expect(s.checkedAt).toBeGreaterThan(0);
  expect(u.brief()).toEqual({ available: "0.10.0", install: null });
  // Every device heard, once.
  expect(t.said).toBe(1);

  for (const tag of ["v0.9.1", "v0.9.0", "v0.8.12"]) {
    const same = installed(releases({ tag, notes: "old news" }));
    await same.u.check();
    expect(await same.u.status()).toMatchObject({ available: null, notes: null, checkFailed: false });
    expect((await same.u.status()).checkedAt).toBeGreaterThan(0);
    // Nothing to tell anyone.
    expect(same.t.said).toBe(0);
  }
});

test("a test release, a tag of another kind, and a release with no program for this machine are not offered", async () => {
  const pre = installed(releases({ tag: "v0.10.0", prerelease: true }));
  await pre.u.check();
  expect(await pre.u.status()).toMatchObject({ available: null, checkFailed: false });

  const odd = installed(releases({ tag: "nightly-2026" }));
  await odd.u.check();
  expect(await odd.u.status()).toMatchObject({ available: null, checkFailed: true });

  const mac = installed(releases({ tag: "v0.10.0", names: ["crosstalk-hub-darwin-arm64"] }));
  await mac.u.check();
  expect(await mac.u.status()).toMatchObject({ available: null, checkFailed: false });
});

test("a machine that can't reach GitHub is quiet about it: what it knew stays, and only whoever asks hears it couldn't check", async () => {
  const server = releases({ tag: "v0.10.0" });
  const now = { at: 1_000_000 };
  const { u, t } = installed(server, { now: () => now.at });
  await u.check();
  expect(u.brief().available).toBe("0.10.0");
  const said = t.said;
  server.stop();
  now.at += 60_000;
  await u.check();
  expect(await u.status()).toMatchObject({ available: "0.10.0", checkFailed: true, checkedAt: 1_000_000 });
  // No device was told anything.
  expect(t.said).toBe(said);

  // Never reachable at all: nothing offered, nothing thrown.
  const offline = installed(null);
  await offline.u.check();
  expect(await offline.u.status()).toMatchObject({ available: null, checkFailed: true, checkedAt: null, install: null });
  expect(offline.t.said).toBe(0);
});

test("asking says nothing about the person or the machine, and Check now tapped twice asks once", async () => {
  const server = releases({ tag: "v0.10.0" });
  const now = { at: 5_000_000 };
  const { u } = installed(server, { now: () => now.at });
  await Promise.all([u.check(), u.check()]);
  await u.check();
  expect(server.files()).toEqual(["/latest"]);
  await u.install();
  await u.done();
  for (const a of server.state.asked) {
    expect(a.agent).toBe("crosstalk-hub");
    // What any download sends, and no more: no cookie, no sign-in, nothing that names a machine or a version.
    for (const h of a.headers) expect(["accept", "accept-encoding", "connection", "host", "user-agent"]).toContain(h);
    expect(a.path).not.toContain("?");
  }
  // A while later it asks again.
  now.at += 6 * 60 * 60_000;
  await u.check();
  expect(server.files().filter((f) => f === "/latest").length).toBe(3);
});

test("Update downloads this machine's program, checks it, and leaves it where the update that applies itself finds it", async () => {
  const server = releases({ tag: "v0.10.0", notes: "What's new" });
  const { u, t, path, ran, files } = installed(server);
  await u.check();
  await u.install();
  expect(u.brief().install).toMatchObject({ version: "0.10.0", step: "checking" });
  await u.done();

  // Only what this machine needs was fetched: the newest release (again, at the tap), its checksums, its program.
  expect(server.files()).toEqual(["/latest", "/latest", "/files/SHA256SUMS", "/files/SHA256SUMS.sig", "/files/crosstalk-hub-linux-x64"]);
  // It waits beside the running program, which hasn't changed; nothing else is left.
  expect(files()).toEqual(["crosstalk-hub", "crosstalk-hub.next"]);
  expect(readFileSync(path, "utf8")).toBe(program("0.9.1"));
  expect(readFileSync(nextBuildPath(path), "utf8")).toContain("echo 0.10.0");
  expect(statSync(nextBuildPath(path)).mode & 0o111).toBe(0o111);
  // It was asked its version before it was trusted, and on Linux nothing else was run.
  expect(ran).toEqual([[`${nextBuildPath(path)}.part`, "version"]]);
  // Progress, in order, each said to every device.
  expect(t.steps[0]).toBe("none");
  expect(t.steps.slice(1, 3)).toEqual(["checking", "downloading 0"]);
  expect(t.steps.filter((s) => s.startsWith("downloading")).length).toBeGreaterThan(1);
  expect(t.steps.slice(-2)).toEqual(["verifying", "none"]);
  expect(u.brief().install).toBeNull();
  expect(t.looked).toBe(1);

  // The update that applies itself takes it from here: it sees the build, says so, and puts it in place as it restarts.
  const { run } = runner(path.replace(/crosstalk-hub$/, ""));
  const seen = { restarts: 0, said: 0 };
  const updater = new Updater({ staged: stagedBuild(run, path, true), working: () => [], restart: () => seen.restarts++, changed: () => seen.said++ });
  await updater.look();
  expect(updater.status()).toMatchObject({ version: "0.10.0", working: 0, restarting: false });
  expect(takeNextBuild("0.9.1", path)).toBe(true);
  expect(readFileSync(path, "utf8")).toContain("echo 0.10.0");
  expect(readFileSync(`${path}.bak-0.9.1`, "utf8")).toBe(program("0.9.1"));
});

test("earlier versions kept beside the program don't pile up: an update keeps the newest of them, and touches nothing else", async () => {
  const server = releases({ tag: "v0.10.0" });
  const { u, path, files } = installed(server);
  for (const name of ["bak-0.8.0", "bak-0.9.0", "bak-0.10.0-mine", "bak-old", "bak-0.7.12"]) writeFileSync(`${path}.${name}`, "an earlier one");
  writeFileSync(`${path}-notes.txt`, "someone's own file");
  await u.install();
  await u.done();
  expect(files()).toEqual(["crosstalk-hub", "crosstalk-hub-notes.txt", "crosstalk-hub.bak-0.10.0-mine", "crosstalk-hub.bak-0.9.0", "crosstalk-hub.bak-old", "crosstalk-hub.next"]);
  // As it starts, the one that ran joins it.
  expect(takeNextBuild("0.9.1", path)).toBe(true);
  expect(files().filter((f) => /\.bak-\d+\.\d+\.\d+$/.test(f))).toEqual(["crosstalk-hub.bak-0.9.0", "crosstalk-hub.bak-0.9.1"]);
  // A download that fails removes none.
  pruneBackups(join(tmpdir(), "ct-no-such-folder", "crosstalk-hub"));
});

test("an update that's downloaded and waiting isn't offered again, and Update then downloads nothing", async () => {
  const server = releases({ tag: "v0.10.0" });
  const { u, t } = installed(server);
  await u.check();
  t.ready = { version: "0.10.0", since: 1, working: 1, chats: ["Chat"], restarting: false };
  expect(u.brief()).toEqual({ available: null, install: null });
  expect(await u.status()).toMatchObject({ available: null, notes: null, ready: { version: "0.10.0" } });
  await u.install();
  await u.done();
  expect(server.files().filter((f) => f.startsWith("/files/"))).toEqual([]);
  expect(u.brief().install).toBeNull();
});

test("a download that doesn't match its checksum is refused, in plain words, and nothing is left behind", async () => {
  const server = releases({ tag: "v0.10.0", wrongSum: true });
  const { u, files, ran } = installed(server);
  await u.install();
  await u.done();
  const failed = u.brief().install!;
  expect(failed).toMatchObject({ version: "0.10.0", step: "failed", error: "The download doesn't match its checksum, so nothing was installed. Try again." });
  expect(installWords(failed)).toBe(failed.error!);
  expect(files()).toEqual(["crosstalk-hub"]);
  // It was never run.
  expect(ran).toEqual([]);
  // Still offered, to try again: and once the release is right, that works.
  expect(u.brief().available).toBe("0.10.0");
  server.state.release = { tag: "v0.10.0" };
  await u.install();
  await u.done();
  expect(u.brief().install).toBeNull();
  expect(files()).toEqual(["crosstalk-hub", "crosstalk-hub.next"]);
});

test("a release whose checksums don't carry Crosstalk's signature is refused before its program is fetched", async () => {
  for (const [signature, error] of [
    ["another key", "Crosstalk 0.10.0 on GitHub isn't signed with Crosstalk's key, so nothing was downloaded."],
    ["list changed", "Crosstalk 0.10.0 on GitHub isn't signed with Crosstalk's key, so nothing was downloaded."],
    ["none", "That release has no signature, so nothing was downloaded. If it was published minutes ago, try again in a few."],
  ] as const) {
    const server = releases({ tag: "v0.10.0", signature });
    const { u, files, ran } = installed(server);
    await u.install();
    await u.done();
    expect(u.brief().install, signature).toMatchObject({ version: "0.10.0", step: "failed", error });
    // The program was never asked for, let alone run.
    expect(server.files().filter((p) => p.includes("crosstalk-hub")), signature).toEqual([]);
    expect(ran, signature).toEqual([]);
    expect(files(), signature).toEqual(["crosstalk-hub"]);
  }
});

test("a signature counts only when one of the known keys made it over exactly those bytes", () => {
  const list = `${"a".repeat(64)}  crosstalk-hub-linux-x64\n`;
  const mine = [publicHalf(KEY)];
  expect(signedByOne(mine, list, signed(list))).toBe(true);
  // While a key is being replaced, either one will do.
  expect(signedByOne([publicHalf(OTHER), publicHalf(KEY)], list, signed(list))).toBe(true);
  expect(signedByOne(mine, list, signed(list, OTHER))).toBe(false);
  expect(signedByOne(mine, list.replace("a", "b"), signed(list))).toBe(false);
  expect(signedByOne(mine, list + " ", signed(list))).toBe(false);
  for (const junk of ["", "not base64 at all", "AAAA", signed(list).slice(0, 40)]) expect(signedByOne(mine, list, junk)).toBe(false);
  expect(signedByOne([], list, signed(list))).toBe(false);
  expect(signedByOne(["not a key", ""], list, signed(list))).toBe(false);
});

test("the keys this Crosstalk trusts are Ed25519 public keys, and an installed copy checks against them", () => {
  expect(RELEASE_KEYS.length).toBeGreaterThan(0);
  for (const key of RELEASE_KEYS) expect(createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }).asymmetricKeyType).toBe("ed25519");
  expect(releaseSource({}).keys).toEqual(RELEASE_KEYS);
  // A fork or a mirror names its own key.
  expect(releaseSource({ CROSSTALK_REPO: "someone/their-fork", CROSSTALK_RELEASE_KEY: ` ${publicHalf(OTHER)} ` }).keys).toEqual([publicHalf(OTHER)]);
  expect(releaseSource({ CROSSTALK_REPO: "someone/their-fork" }).keys).toEqual(RELEASE_KEYS);
});

test("a download that says it's another version is refused, and one that doesn't run at all too", async () => {
  const wrong = installed(releases({ tag: "v0.10.0", says: "0.9.9" }));
  await wrong.u.install();
  await wrong.u.done();
  expect(wrong.u.brief().install).toMatchObject({ step: "failed", error: "The download says it's Crosstalk 0.9.9, not 0.10.0, so nothing was installed." });
  expect(wrong.files()).toEqual(["crosstalk-hub"]);

  const silent = installed(releases({ tag: "v0.10.0", says: "" }));
  await silent.u.install();
  await silent.u.done();
  expect(silent.u.brief().install).toMatchObject({ step: "failed", error: "The download of Crosstalk 0.10.0 doesn't run on this machine, so nothing was installed." });
  expect(silent.files()).toEqual(["crosstalk-hub"]);
});

test("a build that was already waiting stays when a newer download fails", async () => {
  const server = releases({ tag: "v0.10.1", wrongSum: true });
  const { u, t, path, files } = installed(server);
  writeFileSync(nextBuildPath(path), program("0.10.0"), { mode: 0o755 });
  t.ready = { version: "0.10.0", since: 1, working: 0, chats: [], restarting: false };
  await u.install();
  await u.done();
  expect(u.brief().install?.step).toBe("failed");
  expect(files()).toEqual(["crosstalk-hub", "crosstalk-hub.next"]);
  expect(readFileSync(nextBuildPath(path), "utf8")).toBe(program("0.10.0"));
});

test("each system and processor gets its own program, and a machine there's none for is told so", async () => {
  expect(programName("darwin", "arm64")).toBe("crosstalk-hub-darwin-arm64");
  expect(programName("darwin", "x64")).toBe("crosstalk-hub-darwin-x64");
  expect(programName("linux", "x64")).toBe("crosstalk-hub-linux-x64");
  expect(programName("linux", "arm64")).toBe("crosstalk-hub-linux-arm64");
  expect(programName("win32", "x64")).toBeNull();
  expect(programName("linux", "riscv64")).toBeNull();

  const server = releases({ tag: "v0.10.0" });
  for (const [platform, arch] of [["linux", "arm64"], ["darwin", "x64"], ["darwin", "arm64"]]) {
    const { u, files } = installed(server, { platform, arch });
    await u.install();
    await u.done();
    expect(server.files().at(-1)).toBe(`/files/crosstalk-hub-${platform}-${arch}`);
    expect(files()).toEqual(["crosstalk-hub", "crosstalk-hub.next"]);
  }

  const other = installed(server, { platform: "win32", arch: "x64" });
  const before = server.files().length;
  expect(await other.u.status()).toMatchObject({ can: false, why: "There's no download of Crosstalk for this kind of machine (win32, x64).", available: null });
  await other.u.check();
  expect(await other.u.install().then(() => null, (e) => e)).toBeInstanceOf(CantUpdate);
  expect(server.files().length).toBe(before);

  // A release that lists this machine's program in its checksums but not among its files (or the other way round).
  const gone = releases({ tag: "v0.10.0" });
  const { u, files } = installed(gone, { arch: "arm64" });
  await u.check();
  gone.state.release = { tag: "v0.10.0", names: ["crosstalk-hub-linux-x64"] };
  await u.install();
  await u.done();
  // Looked up afresh at the tap: it's no longer there to take, so nothing is downloaded and nothing is offered.
  expect(u.brief()).toEqual({ available: null, install: null });
  expect(files()).toEqual(["crosstalk-hub"]);
});

test("on a Mac the download is cleared of quarantine and signed the way the installer does it, before it's run", async () => {
  const server = releases({ tag: "v0.10.0" });
  // A Mac with no signing identity: ad hoc. These are stand-ins: nothing of this machine's keychain is read or used.
  const dir = mkdtempSync(join(tmpdir(), "ct-selfupdate-mac-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const plain = runner(dir, { "/usr/bin/security": { code: 0, out: "     0 valid identities found\n" } });
  const path = join(dir, "crosstalk-hub");
  writeFileSync(path, program("0.9.1"), { mode: 0o755 });
  const mac = installed(server, { platform: "darwin", arch: "arm64", path, run: plain.run });
  await mac.u.install();
  await mac.u.done();
  const part = `${nextBuildPath(path)}.part`;
  expect(plain.ran).toEqual([
    ["/usr/bin/xattr", "-c", part],
    ["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"],
    ["/usr/bin/codesign", "--force", "--sign", "-", "--identifier", "com.crosstalk.hub", part],
    [part, "version"],
  ]);
  expect(existsSync(nextBuildPath(path))).toBe(true);

  // With a signing identity: that one, so macOS keeps what Crosstalk may open across the update.
  const ids = '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Someone Example (ABCDE12345)"\n     1 valid identities found\n';
  const signed = runner(dir, { "/usr/bin/security": { code: 0, out: ids } });
  await signLikeTheInstaller(signed.run, "/tmp/somewhere/crosstalk-hub.next.part");
  expect(signed.ran.at(-1)).toEqual(["/usr/bin/codesign", "--force", "--sign", "Apple Development: Someone Example (ABCDE12345)", "--identifier", "com.crosstalk.hub", "/tmp/somewhere/crosstalk-hub.next.part"]);
  expect(signed.ran.length).toBe(3);

  // An identity that can't sign (its key is locked away): ad hoc, as the installer falls back.
  const locked = runner(dir, { "/usr/bin/security": { code: 0, out: ids }, "/usr/bin/codesign": { code: 1, out: "" } });
  await signLikeTheInstaller(locked.run, "/tmp/somewhere/crosstalk-hub.next.part");
  expect(locked.ran.slice(-2).map((a) => a[3])).toEqual(["Apple Development: Someone Example (ABCDE12345)", "-"]);
});

test("a second tap while one downloads starts nothing: one download, and both taps see its progress", async () => {
  const server = releases({ tag: "v0.10.0" });
  let release!: () => void;
  server.state.hold = new Promise<void>((r) => (release = r));
  const { u, files } = installed(server);
  await u.install();
  // Half of it has arrived.
  for (let i = 0; i < 200 && u.brief().install?.step !== "downloading"; i++) await Bun.sleep(10);
  for (let i = 0; i < 200 && !u.brief().install?.percent; i++) await Bun.sleep(10);
  const first = u.brief().install!;
  expect(first.step).toBe("downloading");
  expect(first.percent).toBeGreaterThan(0);
  expect(first.percent).toBeLessThan(100);
  expect(installWords(first)).toBe(`Downloading Crosstalk 0.10.0… ${first.percent}%`);
  await u.install();
  await u.install();
  expect(u.brief().install).toEqual(first);
  // It's being made beside where it will wait, under another name: a half-made file is never taken for the update.
  expect(files()).toEqual(["crosstalk-hub", "crosstalk-hub.next.part"]);
  release();
  await u.done();
  expect(server.files().filter((f) => f === "/files/crosstalk-hub-linux-x64").length).toBe(1);
  expect(u.brief().install).toBeNull();
  expect(files()).toEqual(["crosstalk-hub", "crosstalk-hub.next"]);
});

test("a download that's cut short or stops arriving fails with why, leaves nothing, and can be tried again", async () => {
  const server = releases({ tag: "v0.10.0" });
  server.state.cut = true;
  const now = { at: 1_000_000 };
  const { u, files } = installed(server, { stallMs: 300, now: () => now.at });
  await u.install();
  await u.done();
  expect(u.brief().install).toMatchObject({ step: "failed", error: "The download stopped part way. Try again." });
  expect(files()).toEqual(["crosstalk-hub"]);

  // Nothing more arrives.
  server.state.cut = false;
  server.state.hold = new Promise<void>(() => {});
  await u.install();
  await u.done();
  expect(u.brief().install).toMatchObject({ step: "failed", error: "The download stopped arriving, so it was given up. Try again." });
  expect(files()).toEqual(["crosstalk-hub"]);

  // GitHub can't be reached at all at the tap.
  server.state.hold = null;
  const offline = installed(null);
  await offline.u.install();
  await offline.u.done();
  expect(offline.u.brief().install).toMatchObject({ step: "failed", error: "Couldn't reach GitHub to get the update. Check this machine's internet connection, then try again." });

  // And again, with the connection back: it goes through. A check that works clears the failure by itself.
  now.at += 60_000;
  await u.check();
  expect(u.brief()).toEqual({ available: "0.10.0", install: null });
  await u.install();
  await u.done();
  expect(u.brief().install).toBeNull();
  expect(files()).toEqual(["crosstalk-hub", "crosstalk-hub.next"]);
});

test("the hub stopping in the middle of a download leaves nothing, and one left by a crash is cleared when it starts", async () => {
  const server = releases({ tag: "v0.10.0" });
  server.state.hold = new Promise<void>(() => {});
  const { u, t, files, path } = installed(server);
  await u.install();
  for (let i = 0; i < 200 && !existsSync(`${nextBuildPath(path)}.part`); i++) await Bun.sleep(10);
  expect(files()).toEqual(["crosstalk-hub", "crosstalk-hub.next.part"]);
  const said = t.said;
  u.stop();
  await u.done();
  expect(files()).toEqual(["crosstalk-hub"]);
  expect(t.said).toBe(said);

  const crashed = installed(server, { auto: false });
  writeFileSync(`${nextBuildPath(crashed.path)}.part`, "half a downl");
  crashed.u.start();
  expect(crashed.files()).toEqual(["crosstalk-hub"]);
});

test("a Crosstalk run from its source, started by hand, or in a folder it can't write to says so and offers nothing", async () => {
  const server = releases({ tag: "v0.10.0" });
  const source = installed(server, { compiled: false });
  source.u.start();
  expect(await source.u.status()).toMatchObject({ can: false, why: "This Crosstalk runs from its source code, so there's nothing to download: update the code instead.", available: null, install: null });
  await source.u.check();
  expect(await source.u.install().then(() => null, (e) => e)).toBeInstanceOf(CantUpdate);
  expect(source.u.brief()).toEqual({ available: null, install: null });

  const byHand = installed(server, { restarts: async () => false });
  expect(await byHand.u.status()).toMatchObject({ can: false, why: "Crosstalk was started by hand on this machine, so nothing would start it again after an update. Run the installer to update it." });
  await byHand.u.check();
  expect((await byHand.u.install().then(() => null, (e) => e))?.message).toContain("started by hand");

  // Whether something restarts it couldn't be told: it's offered (the installer's service is the usual case).
  expect((await installed(server, { restarts: async () => null }).u.status()).can).toBe(true);

  if (process.getuid?.() !== 0) {
    const locked = installed(server);
    chmodSync(locked.dir, 0o555);
    const s = await locked.u.status();
    expect(s.can).toBe(false);
    expect(s.why).toContain("can't write to the folder its program is in");
    await locked.u.check();
    expect(await locked.u.install().then(() => null, (e) => e)).toBeInstanceOf(CantUpdate);
    expect(locked.files()).toEqual(["crosstalk-hub"]);
  }

  // Not one request, from any of them.
  expect(server.files()).toEqual([]);
  expect(source.t.said + byHand.t.said).toBe(0);
});

test("where releases come from: the repo it was installed from, or what the installer's own variables name", () => {
  const usual = releaseSource({});
  expect(usual.latestUrl).toBe("https://api.github.com/repos/channelramble/crosstalk-app/releases/latest");
  expect(usual.fileUrl("v0.10.0", "SHA256SUMS")).toBe("https://github.com/channelramble/crosstalk-app/releases/download/v0.10.0/SHA256SUMS");
  const fork = releaseSource({ CROSSTALK_REPO: "someone/their-fork" });
  expect(fork.latestUrl).toBe("https://api.github.com/repos/someone/their-fork/releases/latest");
  expect(fork.fileUrl("v1.2.3", "crosstalk-hub-linux-x64")).toBe("https://github.com/someone/their-fork/releases/download/v1.2.3/crosstalk-hub-linux-x64");
  // Not a repo's name: the usual one.
  expect(releaseSource({ CROSSTALK_REPO: "../../etc" }).latestUrl).toBe(usual.latestUrl);
  const mirror = releaseSource({ CROSSTALK_UPDATE_URL: "https://mirror.example/latest.json", CROSSTALK_DOWNLOAD_BASE: "https://mirror.example/files/" });
  expect(mirror.latestUrl).toBe("https://mirror.example/latest.json");
  expect(mirror.fileUrl("v0.10.0", "SHA256SUMS")).toBe("https://mirror.example/files/SHA256SUMS");
});

test("releases are never fetched in the clear from another machine", async () => {
  const { u, files } = installed(null, { latestUrl: "http://mirror.example/latest" });
  await u.check();
  expect(await u.status()).toMatchObject({ available: null, checkFailed: true });
  expect(files()).toEqual(["crosstalk-hub"]);
});

test("the words for each step", () => {
  const at = (step: UpdateInstall["step"], percent: number | null = null, version = "0.10.0") => installWords({ version, step, percent });
  expect(at("checking")).toBe("Looking for the update…");
  expect(at("downloading", 42)).toBe("Downloading Crosstalk 0.10.0… 42%");
  expect(at("downloading")).toBe("Downloading Crosstalk 0.10.0…");
  expect(at("downloading", 0, "")).toBe("Downloading the update… 0%");
  expect(at("verifying")).toBe("Checking the download…");
  expect(at("failed")).toBe("The update didn't download.");
});

test("over the API: people's devices only; a hub run from its source answers that it can't, and its info offers nothing", async () => {
  const work = mkdtempSync(join(tmpdir(), "ct-selfupdate-hub-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: work, maxHopsDefault: 6 } });
  const http = startServer(app);
  cleanups.push(async () => {
    http.stop(true);
    await app.engine.shutdown();
    app.screen.shutdown();
    app.store.close();
    rmSync(work, { recursive: true, force: true });
  });
  const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Phone", "Web"))!;
  const peer = (await app.auth.pair((await app.auth.createPairingCode(undefined, { scope: "peer", hubId: "h_other" })).code, "Other hub", "Hub"))!;
  const linked = (await app.auth.pair((await app.auth.createPairingCode(undefined, { hubId: "h_linked" })).code, "Linked hub", "Crosstalk hub"))!;
  const call = async (method: string, path: string, token = device.token) => {
    const r = await fetch(`http://127.0.0.1:${http.port}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const all = [["GET", "/api/update"], ["POST", "/api/update/check"], ["POST", "/api/update/install"], ["POST", "/api/update/restart"]] as const;

  // As every test's hub is: run from its source. It says so, and nothing is offered.
  expect((await call("GET", "/api/update")).body).toMatchObject({ can: false, available: null, install: null, ready: null });
  expect((await call("POST", "/api/update/check")).body).toMatchObject({ can: false, available: null, checkFailed: false });
  const refused = await call("POST", "/api/update/install");
  expect([refused.status, refused.body.code]).toEqual([409, "cant_update"]);
  expect(refused.body.error).toContain("runs from its source code");
  expect((await call("GET", "/api/state")).body.hub.release).toEqual({ available: null, install: null });
  expect((await call("POST", "/api/update/restart")).status).toBe(409);

  // An installed one, updating from the made-up release server.
  const server = releases({ tag: "v0.10.0", notes: "What's new" });
  const inst = installed(server, { changed: () => {} });
  (app as { selfUpdate: SelfUpdate }).selfUpdate = inst.u;
  expect((await call("POST", "/api/update/check")).body).toMatchObject({ version: "0.9.1", can: true, available: "0.10.0", notes: "What's new" });
  expect((await call("GET", "/api/state")).body.hub.release).toEqual({ available: "0.10.0", install: null });
  const started = await call("POST", "/api/update/install");
  expect(started.status).toBe(200);
  expect(started.body.install).toMatchObject({ version: "0.10.0" });
  expect((await call("POST", "/api/update/install")).status).toBe(200);
  await inst.u.done();
  expect((await call("GET", "/api/update")).body.install).toBeNull();
  expect(inst.files()).toEqual(["crosstalk-hub", "crosstalk-hub.next"]);
  expect(server.files().filter((f) => f.startsWith("/files/crosstalk-hub")).length).toBe(1);

  // Another machine's hub, whatever its sign-in, and nobody at all.
  for (const [method, path] of all) {
    // (A peer's sign-in is turned away before any route; a linked hub's full one by these routes.)
    expect([path, (await call(method, path, peer.token)).status]).toEqual([path, 403]);
    const r = await call(method, path, linked.token);
    expect([path, r.status, r.body.code]).toEqual([path, 403, "person_only"]);
    expect((await fetch(`http://127.0.0.1:${http.port}${path}`, { method })).status).toBe(401);
  }
});
