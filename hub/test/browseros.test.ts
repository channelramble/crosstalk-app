// BrowserOS neo (hub/src/browseros.ts, browserosCli.ts): which build each machine gets, how the download is checked,
// what happens when a signature or a checksum doesn't hold up, and what the words say when GitHub can't be asked.
//
// The releases fixture is the real payload's shape, trimmed from what github.com/browseros-ai/BrowserOS answered on
// 2026-10-30: three sub-component releases that carry no installer, the Windows-only `browserclaw/v0.51.2.4`, and
// `browserclaw/v0.51.2.3` — which carries seven 0.51.2.3 installers *and* the 0.51.2.4 Windows one. It is kept in
// GitHub's own order (by when each tag was made), which is not publish order: that is exactly what trips a naive pick.
// Nothing here reaches GitHub, writes to /Applications or touches the copy of BrowserOS neo on this machine.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import RELEASES from "./fixtures/browseros-releases.json";
import {
  addCommand,
  agentLinks,
  buildTarget,
  cachedReleases,
  checkMacSignature,
  compareVersions,
  browserRunning,
  discoverMcp,
  downloadAsset,
  fetchReleases,
  forgetMcp,
  forgetReleases,
  installBuild,
  localMcpUrl,
  namesBrowser,
  newerVersion,
  pickBuild,
  readBrowserConfig,
  readInstalled,
  removeCommand,
  sameMcpUrl,
  serverInfo,
  serverRunning,
  spaceNeeded,
  tomlMcpUrls,
  versionInName,
  type Build,
  type InstallDeps,
  type RunBoth,
  type SystemDeps,
} from "../src/browseros";
import { chooseToInstall, describe as describeFacts, runBrowserOsCli } from "../src/browserosCli";

const payload = RELEASES as unknown[];

/** A machine, for the pure pickers. */
const mac = (arch = "arm64") => buildTarget("darwin", arch);
const linux = (arch: string, dpkg: boolean, fuse: boolean) => buildTarget("linux", arch, { dpkg, fuse });
const windows = () => buildTarget("win32", "x64");

// ---------------------------------------------------------------- picking a build

describe("which build a machine gets", () => {
  test("the newest release that has an asset for this machine — never the newest tag", () => {
    // The three newest tags in the payload are sub-component releases with no installer in them at all.
    expect((payload[0] as { tag_name: string }).tag_name).toBe("claw-server/v0.0.90");
    const picked = pickBuild(payload, mac());
    expect(picked).toMatchObject({ tag: "browserclaw/v0.51.2.3", version: "0.51.2.3" });
    expect(picked!.asset.name).toBe("BrowserOS_neo_v0.51.2.3_arm64.dmg");
    expect(picked!.asset.sha256).toBe("71de41267c6a9bd991c2d560125304082aa32a45a86f572fd819ce6e521e8a56");
    expect(picked!.asset.size).toBe(165186976);
    expect(picked!.kind).toBe("dmg");
  });

  test("the right build really does differ per machine: Windows is a version ahead of the Mac", () => {
    const win = pickBuild(payload, windows())!;
    expect([win.version, win.asset.name]).toEqual(["0.51.2.4", "BrowserOS_neo_v0.51.2.4_x64_installer.exe"]);
    // Same file sits in both releases; the one published later wins, so the tag said is the one it belongs to.
    expect(win.tag).toBe("browserclaw/v0.51.2.4");
    expect(pickBuild(payload, mac())!.version).toBe("0.51.2.3");
  });

  test("a build's version comes from the asset's own name, not from the tag it sits in", () => {
    // browserclaw/v0.51.2.3 carries BrowserOS_neo_v0.51.2.4_x64_installer.exe. Reading the tag would say 0.51.2.3.
    const olderTagOnly = payload.filter((r) => (r as { tag_name: string }).tag_name !== "browserclaw/v0.51.2.4");
    expect(pickBuild(olderTagOnly, windows())).toMatchObject({ tag: "browserclaw/v0.51.2.3", version: "0.51.2.4" });
    expect(versionInName("BrowserOS_neo_v0.51.2.3_arm64.dmg")).toBe("0.51.2.3");
    expect(versionInName("BrowserOS_neo_v0.51.2.4_x64_installer.exe")).toBe("0.51.2.4");
    expect(versionInName("browseros-claw-server-rust-resources-darwin-arm64.zip")).toBeNull();
  });

  test("each platform and architecture gets its own asset", () => {
    const of = (t: ReturnType<typeof mac>) => pickBuild(payload, t)?.asset.name ?? null;
    expect(of(mac("arm64"))).toBe("BrowserOS_neo_v0.51.2.3_arm64.dmg");
    expect(of(mac("x64"))).toBe("BrowserOS_neo_v0.51.2.3_x64.dmg");
    expect(of(linux("x64", true, true))).toBe("BrowserOS_neo_v0.51.2.3_amd64.deb");
    expect(of(linux("arm64", true, true))).toBe("BrowserOS_neo_v0.51.2.3_arm64.deb");
    expect(of(linux("x64", false, true))).toBe("BrowserOS_neo_v0.51.2.3_x64.AppImage");
    expect(of(windows())).toBe("BrowserOS_neo_v0.51.2.4_x64_installer.exe");
  });

  test("a Linux box with neither dpkg nor FUSE still gets a build, with how to start it", () => {
    const t = linux("x64", false, false);
    expect(t.blocked).toBeNull();
    const picked = pickBuild(payload, t)!;
    expect(picked.asset.name).toBe("BrowserOS_neo_v0.51.2.3_x64.AppImage");
    expect(picked.kind).toBe("appimage");
    expect(picked.note).toContain("--appimage-extract-and-run");
  });

  test("the universal dmg is only a fallback: the arch's own build is half the download", () => {
    const native = payload.map((r) => r as { assets: { name: string }[] });
    expect(pickBuild(payload, mac("arm64"))!.asset.name).toContain("_arm64.dmg");
    // The same release with its arm64 dmg taken out: the universal one is taken, and says why.
    const onlyUniversal = JSON.parse(JSON.stringify(payload)) as { assets: { name: string }[] }[];
    for (const r of onlyUniversal) r.assets = r.assets.filter((a) => !a.name.endsWith("_arm64.dmg"));
    const picked = pickBuild(onlyUniversal, mac("arm64"))!;
    expect(picked.asset.name).toBe("BrowserOS_neo_v0.51.2.3_universal.dmg");
    expect(picked.note).toContain("universal");
    expect(native.length).toBeGreaterThan(0);
  });

  test("a machine with no build at all says so and offers nothing", () => {
    for (const t of [buildTarget("darwin", "ppc"), buildTarget("linux", "riscv64"), buildTarget("freebsd", "x64"), buildTarget("win32", "arm64")]) {
      expect(t.wants).toEqual([]);
      expect(t.blocked).toContain("no");
      expect(pickBuild(payload, t)).toBeNull();
    }
  });

  test("a prerelease is not 'the newest build', and is only taken when nothing stable fits", () => {
    const asset = (name: string) => ({ name, state: "uploaded", size: 165_186_976, digest: `sha256:${"a".repeat(64)}`, browser_download_url: `https://example.invalid/${name}` });
    const pre = { tag_name: "browserclaw/v0.52.0.0", draft: false, prerelease: true, published_at: "2026-10-29T00:00:00Z", assets: [asset("BrowserOS_neo_v0.52.0.0_arm64.dmg")] };
    // GitHub's /releases list carries prereleases, so without skipping them this one would be offered as an update to
    // someone on the stable 0.51.2.3.
    const withPre = pickBuild([pre, ...payload], mac())!;
    expect([withPre.version, withPre.tag]).toEqual(["0.51.2.3", "browserclaw/v0.51.2.3"]);
    expect(newerVersion("0.51.2.3", withPre.version)).toBe(false);
    // Nothing stable for this machine at all: the prerelease is better than "no build", and it says what it is.
    const onlyPre = pickBuild([pre], mac())!;
    expect(onlyPre.version).toBe("0.52.0.0");
    expect(onlyPre.note).toContain("prerelease");
    // A universal-only prerelease keeps both notes: why it is the universal build, and that it is a prerelease.
    const universal = pickBuild([{ ...pre, assets: [asset("BrowserOS_neo_v0.52.0.0_universal.dmg")] }], mac())!;
    expect(universal.note).toContain("universal");
    expect(universal.note).toContain("prerelease");
  });

  test("drafts, half-uploaded assets and nonsense payloads give nothing", () => {
    const draft = [{ tag_name: "browserclaw/v9.9.9.9", draft: true, published_at: "2027-01-01T00:00:00Z", assets: [{ name: "BrowserOS_neo_v9.9.9.9_arm64.dmg", state: "uploaded", size: 1, digest: "sha256:" + "a".repeat(64), browser_download_url: "https://example.invalid/x" }] }];
    expect(pickBuild(draft, mac())).toBeNull();
    const uploading = [{ ...draft[0], draft: false, assets: [{ ...(draft[0].assets[0] as object), state: "starter" }] }];
    expect(pickBuild(uploading, mac())).toBeNull();
    for (const junk of [null, undefined, {}, "nope", [1, 2], [{}], [{ assets: "no" }]]) expect(pickBuild(junk, mac())).toBeNull();
  });

  test("newer means newer, in the direction the checklist asks it", () => {
    expect(newerVersion("0.51.2.3", "0.52.0.0")).toBe(true);
    expect(newerVersion("0.51.2.3", "0.51.2.3")).toBe(false);
    expect(newerVersion("0.52.0.0", "0.51.2.3")).toBe(false);
    // Nothing could read the installed version: offer the update rather than call it up to date.
    expect(newerVersion(null, "0.51.2.3")).toBe(true);
    expect(newerVersion("0.51.2.3", null)).toBe(false);
  });

  test("versions compare number by number, not as text", () => {
    expect(compareVersions("0.51.2.10", "0.51.2.9")).toBe(1);
    expect(compareVersions("0.51.2.3", "0.51.2.4")).toBe(-1);
    expect(compareVersions("0.51.2", "0.51.2.0")).toBe(0);
    expect(compareVersions("1.0", "0.99.99")).toBe(1);
  });
});

// ---------------------------------------------------------------- asking GitHub

describe("asking GitHub", () => {
  const answer = (status: number, headers: Record<string, string>, body: unknown = {}) =>
    (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

  test("a used-up allowance comes back as 403 with the time it resets, and says it in words", async () => {
    const reset = Math.floor(Date.parse("2026-10-30T18:21:26Z") / 1000);
    const r = await fetchReleases({ get: answer(403, { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "60", "x-ratelimit-reset": String(reset) }, { message: "API rate limit exceeded" }) });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.why).toBe("rate");
    expect(r.retryAt).toBe(reset * 1000);
    expect(r.detail).toContain("60");
  });

  test("a 403 that isn't a rate limit stays a plain refusal, not a wait", async () => {
    const r = await fetchReleases({ get: answer(403, { "x-ratelimit-remaining": "57" }, { message: "nope" }) });
    expect(r).toMatchObject({ ok: false, why: "http" });
  });

  test("no network reads as offline, and an answer that isn't a list reads as bad", async () => {
    const dead = (async () => {
      throw new TypeError("Unable to connect");
    }) as unknown as typeof fetch;
    expect(await fetchReleases({ get: dead })).toMatchObject({ ok: false, why: "offline" });
    expect(await fetchReleases({ get: answer(200, {}, { message: "not a list" }) })).toMatchObject({ ok: false, why: "bad" });
    expect(await fetchReleases({ get: answer(200, {}, "{broken") })).toMatchObject({ ok: false, why: "bad" });
  });

  test("the answer is reused, and a used-up allowance is held exactly until it comes back", async () => {
    forgetReleases();
    let calls = 0;
    const ok = (async () => {
      calls++;
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;
    let now = 1_000_000;
    expect((await cachedReleases({ get: ok, now: () => now })).ok).toBe(true);
    await cachedReleases({ get: ok, now: () => now });
    expect(calls).toBe(1);
    now += 7 * 3600_000;
    await cachedReleases({ get: ok, now: () => now });
    expect(calls).toBe(2);

    forgetReleases();
    const reset = now + 40 * 60_000;
    let rateCalls = 0;
    const limited = (async () => {
      rateCalls++;
      return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(reset / 1000)) } });
    }) as unknown as typeof fetch;
    await cachedReleases({ get: limited, now: () => now });
    now += 30 * 60_000;
    await cachedReleases({ get: limited, now: () => now });
    expect(rateCalls).toBe(1);
    now = reset + 1000;
    await cachedReleases({ get: limited, now: () => now });
    expect(rateCalls).toBe(2);
    forgetReleases();
  });
});

// ---------------------------------------------------------------- downloading and checking

/** A build whose asset is a few bytes, so a download can really be written, hashed and checked. */
function tinyBuild(body: string, over: Partial<Build["asset"]> = {}): { build: Build; sha: string } {
  const sha = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  return {
    sha,
    build: {
      tag: "browserclaw/v0.51.2.3",
      version: "0.51.2.3",
      kind: "dmg",
      publishedAt: 1,
      asset: { name: "BrowserOS_neo_v0.51.2.3_arm64.dmg", url: "https://example.invalid/dmg", size: body.length, sha256: sha, ...over },
    },
  };
}

describe("downloading the asset", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "crosstalk-browseros-test-"));

  test("a download that matches the SHA-256 GitHub reports is kept", async () => {
    const dir = scratch();
    try {
      const { build } = tinyBuild("a real disk image, honestly");
      const get = (async () => new Response("a real disk image, honestly", { status: 200 })) as unknown as typeof fetch;
      const file = join(dir, build.asset.name);
      expect(await downloadAsset(build, file, { get })).toEqual({ ok: true });
      expect(readFileSync(file, "utf8")).toBe("a real disk image, honestly");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one that doesn't match is deleted, and nothing is installed", async () => {
    const dir = scratch();
    try {
      const { build } = tinyBuild("what GitHub promised");
      const get = (async () => new Response("something else entirely", { status: 200 })) as unknown as typeof fetch;
      const file = join(dir, "x.dmg");
      const r = await downloadAsset({ ...build, asset: { ...build.asset, size: "something else entirely".length } }, file, { get });
      expect(r).toMatchObject({ ok: false, why: "checksum" });
      expect(Bun.file(file).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an asset GitHub reports no SHA-256 for is refused rather than installed unchecked", async () => {
    const { build } = tinyBuild("whatever", { sha256: null });
    const r = await downloadAsset(build, "/nowhere/should-not-be-written", { get: (async () => new Response("")) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, why: "no-digest" });
    expect((r as { detail: string }).detail).toContain("won't install it");
  });

  test("a download that dies half way carries on from where it stopped instead of starting again", async () => {
    const dir = scratch();
    try {
      const whole = "0123456789abcdefghij";
      const { build } = tinyBuild(whole);
      const file = join(dir, "part.dmg");
      const ranges: (string | null)[] = [];
      let first = true;
      const get = (async (_url: string, init: RequestInit) => {
        ranges.push(new Headers(init.headers).get("range"));
        if (first) {
          first = false;
          // It stops half way: the stream ends early, the file is short.
          return new Response(whole.slice(0, 8), { status: 200 });
        }
        return new Response(whole.slice(8), { status: 206 });
      }) as unknown as typeof fetch;
      expect(await downloadAsset(build, file, { get })).toEqual({ ok: true });
      expect(ranges).toEqual([null, "bytes=8-"]);
      expect(readFileSync(file, "utf8")).toBe(whole);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a server that ignores the range and sends the lot again still ends up with the right file", async () => {
    const dir = scratch();
    try {
      const whole = "0123456789abcdefghij";
      const { build } = tinyBuild(whole);
      const file = join(dir, "part.dmg");
      let first = true;
      const get = (async () => {
        if (first) {
          first = false;
          return new Response(whole.slice(0, 8), { status: 200 });
        }
        return new Response(whole, { status: 200 });
      }) as unknown as typeof fetch;
      expect(await downloadAsset(build, file, { get })).toEqual({ ok: true });
      expect(readFileSync(file, "utf8")).toBe(whole);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no size reported, a short download is tried again rather than called corrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crosstalk-browseros-test-"));
    try {
      const whole = "0123456789abcdefghij";
      const { build } = tinyBuild(whole, { size: null });
      let first = true;
      const get = (async () => {
        if (first) {
          first = false;
          return new Response(whole.slice(0, 8), { status: 200 });
        }
        return new Response(whole, { status: 200 });
      }) as unknown as typeof fetch;
      expect(await downloadAsset(build, join(dir, "nosize.dmg"), { get })).toEqual({ ok: true });
      // Really damaged, with no size either: it still ends up refused, never installed.
      const bad = (async () => new Response("not the file at all", { status: 200 })) as unknown as typeof fetch;
      expect(await downloadAsset(build, join(dir, "bad.dmg"), { get: bad })).toMatchObject({ ok: false, why: "checksum" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a download that never finishes gives up with what to do, not a stack trace", async () => {
    const dir = scratch();
    try {
      const { build } = tinyBuild("0123456789abcdefghij");
      const get = (async () => new Response("0123", { status: 200 })) as unknown as typeof fetch;
      const r = await downloadAsset(build, join(dir, "p.dmg"), { get, space: () => ({ free: 500 * 1024 ** 3 }) });
      expect(r).toMatchObject({ ok: false, why: "download" });
      expect((r as { detail: string }).detail).toContain("Check the network");
      // What arrived stays, so the next try carries on from there instead of fetching 165 MB again.
      expect(Bun.file(join(dir, "p.dmg")).size).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a disk with no room for it is told so before the first byte, in the words the pool uses", async () => {
    const dir = scratch();
    try {
      // The real sizes: 165 MB for the arm64 dmg, and the install copies the bundle out of it, so the peak is twice.
      const { build } = tinyBuild("x", { size: 165_186_976 });
      expect(spaceNeeded(build)).toBe(2 * 165_186_976);
      expect(spaceNeeded({ ...build, kind: "deb" })).toBe(165_186_976);
      let asked = 0;
      const get = (async () => {
        asked++;
        return new Response("x", { status: 200 });
      }) as unknown as typeof fetch;
      // 1 GB free: more than the download, less than the install plus the 2 GB the hub keeps free for everything else.
      const r = await downloadAsset(build, join(dir, "big.dmg"), { get, space: () => ({ free: 1024 ** 3 }) });
      expect(r).toMatchObject({ ok: false, why: "space" });
      const detail = (r as { detail: string }).detail;
      expect(detail).toContain("Not enough free space");
      expect(detail).toContain("Free up space");
      expect(detail).toContain("keeping 2.0 GB free");
      // Nothing was fetched and nothing was written: a disk problem is said as one, before it fills the disk.
      expect(asked).toBe(0);
      expect(Bun.file(join(dir, "big.dmg")).size).toBe(0);
      // Room for the download and the copy and the reserve: it goes ahead.
      const { build: tiny } = tinyBuild("a real disk image");
      expect(await downloadAsset(tiny, join(dir, "ok.dmg"), { get: (async () => new Response("a real disk image", { status: 200 })) as unknown as typeof fetch, space: () => ({ free: 500 * 1024 ** 3 }) })).toEqual({ ok: true });
      // A disk that can't be measured refuses nothing.
      expect(await downloadAsset(tiny, join(dir, "ok2.dmg"), { get: (async () => new Response("a real disk image", { status: 200 })) as unknown as typeof fetch, space: () => null })).toEqual({ ok: true });
      // The folder the download goes in doesn't exist yet on a first install, so the disk is measured at the nearest
      // folder that does — otherwise there would be nothing to measure and the check would never run.
      const measured: string[] = [];
      await downloadAsset(tiny, join(dir, "not", "there", "yet", "x.dmg"), {
        get: (async () => new Response("a real disk image", { status: 200 })) as unknown as typeof fetch,
        space: (p) => {
          measured.push(p);
          return { free: 500 * 1024 ** 3 };
        },
      });
      expect(measured).toEqual([dir]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a disk that fills up mid-download says that, and what arrived is deleted", async () => {
    const dir = scratch();
    try {
      const { build } = tinyBuild("0123456789abcdefghij");
      const file = join(dir, "full.dmg");
      const get = (async () => new Response("0123", { status: 200 })) as unknown as typeof fetch;
      const r = await downloadAsset(build, file, {
        get,
        space: () => ({ free: 500 * 1024 ** 3 }),
        // What the write really throws when the disk fills up.
        sink: async () => {
          throw new Error("ENOSPC: no space left on device, write");
        },
      });
      // Never "check the network": it is the disk, and the words have to say the thing the person can act on.
      expect(r).toMatchObject({ ok: false, why: "space" });
      expect((r as { detail: string }).detail).toContain("filled up");
      expect((r as { detail: string }).detail).not.toContain("network");
      expect(Bun.file(file).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dead download never sits on the room the hub keeps free", async () => {
    const dir = scratch();
    try {
      const { build } = tinyBuild("0123456789abcdefghij");
      const file = join(dir, "left.dmg");
      const get = (async () => new Response("0123", { status: 200 })) as unknown as typeof fetch;
      // Room when it started, under the reserve by the time it gave up (something else filled the disk meanwhile).
      let looks = 0;
      const space = () => ({ free: looks++ === 0 ? 500 * 1024 ** 3 : 1024 ** 2 });
      // The download died for its own reasons, and what arrived would now be sitting on the hub's own reserve: it goes.
      const r = await downloadAsset(build, file, { get, space });
      expect(r).toMatchObject({ ok: false, why: "download" });
      expect(Bun.file(file).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- the signature on a Mac

/** A `run` that answers a fixed script, keyed by the program and its first argument. */
function fakeRun(answers: Record<string, { code: number; out?: string; err?: string }>, seen: string[][] = []): RunBoth {
  return async (args) => {
    seen.push(args);
    const key = Object.keys(answers).find((k) => args.join(" ").includes(k));
    const a = key ? answers[key] : null;
    return a ? { code: a.code, out: a.out ?? "", err: a.err ?? "" } : { code: 0, out: "", err: "" };
  };
}

const SIGNED = "Executable=/Volumes/x/BrowserOS neo.app\nAuthority=Developer ID Application: Example Developer (ABCDE12345)\nAuthority=Apple Root CA\n";

describe("the signature and notarisation, checked before anything is installed", () => {
  test("a properly signed, notarised app passes and the authority is named", async () => {
    const r = await checkMacSignature("/Volumes/x/BrowserOS neo.app", {
      run: fakeRun({ "codesign --verify": { code: 0 }, "codesign -dv": { code: 0, err: SIGNED }, spctl: { code: 0, err: "/Volumes/x/BrowserOS neo.app: accepted\nsource=Notarized Developer ID" } }),
    });
    expect(r.ok).toBe(true);
    expect(r.authority).toBe("Developer ID Application: Example Developer (ABCDE12345)");
    expect(r.notarised).toBe(true);
  });

  test("a broken signature fails, and the words say so without installing anything", async () => {
    const r = await checkMacSignature("/Volumes/x/app.app", { run: fakeRun({ "codesign --verify": { code: 1, err: "a sealed resource is missing or invalid" } }) });
    expect([r.ok, r.why]).toEqual([false, "signature"]);
    expect(r.detail).toContain("isn't properly signed");
    expect(r.detail).toContain("installed nothing");
  });

  test("an app macOS won't open — not notarised — fails too", async () => {
    const r = await checkMacSignature("/Volumes/x/app.app", {
      run: fakeRun({ "codesign --verify": { code: 0 }, "codesign -dv": { code: 0, err: SIGNED }, spctl: { code: 3, err: "/Volumes/x/app.app: rejected\nsource=Unnotarized Developer ID" } }),
    });
    expect([r.ok, r.notarised, r.why]).toEqual([false, false, "notarisation"]);
    expect(r.detail).toContain("isn't notarised");
  });

  test("notarised but not a Developer ID is refused as well", async () => {
    const r = await checkMacSignature("/Volumes/x/app.app", {
      run: fakeRun({ "codesign --verify": { code: 0 }, "codesign -dv": { code: 0, err: "Authority=Apple Development: someone (ABC)\n" }, spctl: { code: 0, err: "accepted" } }),
    });
    expect([r.ok, r.why]).toEqual([false, "signature"]);
    expect(r.detail).toContain("Developer ID");
  });

  test("codesign that can't be run at all is a failure, never a pass", async () => {
    const r = await checkMacSignature("/Volumes/x/app.app", { run: async () => null });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("wasn't checked");
  });
});

// ---------------------------------------------------------------- the whole install

describe("installing", () => {
  const dmgDeps = (over: Partial<InstallDeps> = {}, seen: string[][] = []): InstallDeps => ({
    platform: "darwin",
    home: "/Users/me",
    get: (async () => new Response("disk image", { status: 200 })) as unknown as typeof fetch,
    run: fakeRun(
      {
        hdiutil: { code: 0 },
        "/bin/ls": { code: 0, out: "Applications\nBrowserOS neo.app\n" },
        "codesign --verify": { code: 0 },
        "codesign -dv": { code: 0, err: SIGNED },
        spctl: { code: 0, err: "accepted\nsource=Notarized Developer ID" },
        ditto: { code: 0 },
        plutil: { code: 0, out: JSON.stringify({ CFBundleShortVersionString: "0.51.2.3", CFBundleIdentifier: "com.browseros.BrowserClaw" }) },
        // pgrep: 1 is "nothing of that name is running", which is what lets an install go ahead at all.
        pgrep: { code: 1 },
      },
      seen,
    ),
    exists: () => false,
    read: () => null,
    remove: () => {},
    // A disk with room: the space check is tested on its own, and never against this machine's real free space.
    space: () => ({ free: 500 * 1024 ** 3 }),
    ...over,
  });

  test("a bad checksum stops it before the image is ever mounted", async () => {
    const seen: string[][] = [];
    const { build } = tinyBuild("what GitHub promised");
    const dir = mkdtempSync(join(tmpdir(), "crosstalk-browseros-test-"));
    try {
      const r = await installBuild({ ...build, asset: { ...build.asset, size: "not that".length } }, { ...dmgDeps({ get: (async () => new Response("not that", { status: 200 })) as unknown as typeof fetch }, seen), tmp: dir });
      expect(r).toMatchObject({ done: "failed", why: "checksum" });
      expect(seen.some((a) => a[0].includes("hdiutil"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a signature that fails stops it before anything goes in /Applications", async () => {
    const seen: string[][] = [];
    const { build } = tinyBuild("disk image");
    const dir = mkdtempSync(join(tmpdir(), "crosstalk-browseros-test-"));
    try {
      const r = await installBuild(build, { ...dmgDeps({ run: fakeRun({ hdiutil: { code: 0 }, "/bin/ls": { code: 0, out: "BrowserOS neo.app" }, "codesign --verify": { code: 1, err: "invalid signature" } }, seen) }, seen), tmp: dir }, { into: join(dir, "Applications") });
      // A broken signature is reported as a signature failure, never as a notarisation one.
      expect(r).toMatchObject({ done: "failed", why: "signature" });
      expect(seen.some((a) => a.join(" ").includes("ditto"))).toBe(false);
      // The image is always unmounted again, pass or fail.
      expect(seen.some((a) => a.join(" ").includes("hdiutil detach"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a checked build is put in place, and the image is unmounted after", async () => {
    const seen: string[][] = [];
    const dir = mkdtempSync(join(tmpdir(), "crosstalk-browseros-test-"));
    try {
      const { build } = tinyBuild("disk image");
      const apps = join(dir, "Applications");
      // ditto is faked, so make the staged bundle appear where placeMacApp expects it.
      const run: RunBoth = async (args) => {
        seen.push(args);
        if (args[0].endsWith("ditto")) {
          // The real ditto makes the folders it needs.
          mkdirSync(join(args[2], ".."), { recursive: true });
          writeFileSync(args[2], "app", { flag: "w" });
          return { code: 0, out: "", err: "" };
        }
        return fakeRun({ hdiutil: { code: 0 }, "/bin/ls": { code: 0, out: "BrowserOS neo.app" }, "codesign --verify": { code: 0 }, "codesign -dv": { code: 0, err: SIGNED }, spctl: { code: 0, err: "accepted" }, pgrep: { code: 1 }, plutil: { code: 0, out: JSON.stringify({ CFBundleShortVersionString: "0.51.2.3", CFBundleIdentifier: "com.browseros.BrowserClaw" }) } })(args);
      };
      const r = await installBuild(build, { ...dmgDeps({ run }), tmp: dir, remove: () => {} }, { into: apps });
      // The name it goes in under is the one the rest of Crosstalk looks for, not whatever the image called it.
      expect(r).toMatchObject({ done: "installed", version: "0.51.2.3", path: join(apps, "BrowserOS neo.app") });
      expect(seen.filter((a) => a.join(" ").includes("hdiutil detach")).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an app in the image that isn't BrowserOS neo is not installed, however well it is signed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crosstalk-browseros-test-"));
    const seen: string[][] = [];
    try {
      const { build } = tinyBuild("disk image");
      // Signed by a Developer ID and notarised — which is all the signature check can say. The bundle id is what says
      // *which* app it is, and anything else is somebody else's browser.
      const run = fakeRun(
        {
          hdiutil: { code: 0 },
          "/bin/ls": { code: 0, out: "Some Other Browser.app\n" },
          "codesign --verify": { code: 0 },
          "codesign -dv": { code: 0, err: SIGNED },
          spctl: { code: 0, err: "accepted" },
          pgrep: { code: 1 },
          plutil: { code: 0, out: JSON.stringify({ CFBundleShortVersionString: "9.9", CFBundleIdentifier: "com.example.other" }) },
        },
        seen,
      );
      const r = await installBuild(build, { ...dmgDeps({ run }), tmp: dir }, { into: join(dir, "Applications") });
      expect(r).toMatchObject({ done: "failed", why: "identity" });
      expect((r as { detail: string }).detail).toContain("com.browseros.BrowserClaw");
      expect(seen.some((a) => a.join(" ").includes("ditto"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the browser's own bundle is picked out of an image that carries more than one app", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crosstalk-browseros-test-"));
    const seen: string[][] = [];
    try {
      const { build } = tinyBuild("disk image");
      const run: RunBoth = async (args) => {
        seen.push(args);
        if (args[0].endsWith("ditto")) {
          mkdirSync(join(args[2], ".."), { recursive: true });
          writeFileSync(args[2], "app", { flag: "w" });
          return { code: 0, out: "", err: "" };
        }
        // "Aaa Installer.app" sorts first; the browser is the one whose bundle id says so.
        const which = args.join(" ").includes("Aaa Installer.app") ? { CFBundleIdentifier: "com.example.installer" } : { CFBundleShortVersionString: "0.51.2.3", CFBundleIdentifier: "com.browseros.BrowserClaw" };
        return fakeRun({ hdiutil: { code: 0 }, "/bin/ls": { code: 0, out: "Aaa Installer.app\nBrowserOS neo.app\n" }, "codesign --verify": { code: 0 }, "codesign -dv": { code: 0, err: SIGNED }, spctl: { code: 0, err: "accepted" }, pgrep: { code: 1 }, plutil: { code: 0, out: JSON.stringify(which) } })(args);
      };
      const r = await installBuild(build, { ...dmgDeps({ run }), tmp: dir, remove: () => {} }, { into: join(dir, "Applications") });
      expect(r).toMatchObject({ done: "installed" });
      expect(seen.some((a) => a.join(" ").includes("codesign --verify") && a.join(" ").includes("BrowserOS neo.app"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a copy that is open is never replaced quietly — the browser's own process, not a helper's pid file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crosstalk-browseros-test-"));
    try {
      const { build } = tinyBuild("disk image");
      const asked: string[][] = [];
      // The browser is up and there is **no** server.state at all: its MCP helper isn't running, the person is using
      // another profile, or the helper crashed. The old guard read that as "not open" and deleted the bundle it was
      // executing from. pgrep 0 means the bundle's own process is there.
      const open = dmgDeps({ exists: () => true, read: () => null, run: fakeRun({ hdiutil: { code: 0 }, "/bin/ls": { code: 0, out: "BrowserOS neo.app" }, "codesign --verify": { code: 0 }, "codesign -dv": { code: 0, err: SIGNED }, spctl: { code: 0, err: "accepted" }, plutil: { code: 0, out: JSON.stringify({ CFBundleIdentifier: "com.browseros.BrowserClaw" }) }, pgrep: { code: 0, out: "72259\n" } }, asked) });
      const r = await installBuild(build, { ...open, tmp: dir }, { into: join(dir, "Applications") });
      expect(r).toMatchObject({ done: "failed", why: "running" });
      expect((r as { detail: string }).detail).toContain("Quit it first");
      // It asked about the bundle's own executable folder, which is the browser and never its helper beside it.
      const pgrep = asked.find((a) => a[0].endsWith("pgrep"))!;
      expect(pgrep[1]).toBe("-f");
      expect(pgrep[2]).toContain("BrowserOS neo");
      expect(pgrep[2]).toContain("/Contents/MacOS/");
      expect(asked.some((a) => a.join(" ").includes("ditto"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a process list that can't be asked counts as open, rather than as a free hand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crosstalk-browseros-test-"));
    try {
      const { build } = tinyBuild("disk image");
      const run: RunBoth = async (args) => (args[0].endsWith("pgrep") ? null : fakeRun({ hdiutil: { code: 0 }, "/bin/ls": { code: 0, out: "BrowserOS neo.app" }, "codesign --verify": { code: 0 }, "codesign -dv": { code: 0, err: SIGNED }, spctl: { code: 0, err: "accepted" }, plutil: { code: 0, out: JSON.stringify({ CFBundleIdentifier: "com.browseros.BrowserClaw" }) } })(args));
      const r = await installBuild(build, { ...dmgDeps({ exists: () => true, read: () => null, run }), tmp: dir }, { into: join(dir, "Applications") });
      expect(r).toMatchObject({ done: "failed", why: "running" });
      expect((r as { detail: string }).detail).toContain("couldn't tell");
      // Saying to replace it anyway still gets past the guard (it fails later, on a /Applications that isn't there).
      const forced = await installBuild(build, { ...dmgDeps({ exists: () => true, read: () => null, run }), tmp: dir }, { into: join(dir, "Applications"), replaceRunning: true });
      expect(forced).toMatchObject({ done: "failed", why: "copy" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a .deb is downloaded and checked, and the last step stays the person's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crosstalk-browseros-test-"));
    try {
      const { build } = tinyBuild("deb bytes");
      const r = await installBuild({ ...build, kind: "deb", asset: { ...build.asset, name: "BrowserOS_neo_v0.51.2.3_amd64.deb" } }, { platform: "linux", home: "/home/me", get: (async () => new Response("deb bytes", { status: 200 })) as unknown as typeof fetch, tmp: dir, run: fakeRun({}) });
      expect(r).toMatchObject({ done: "ready" });
      expect((r as { command: string }).command).toContain("sudo dpkg -i");
      expect((r as { detail: string }).detail).toContain("SHA-256");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- finding its MCP endpoint

describe("its MCP endpoint, found rather than assumed", () => {
  // The found address is kept (it is a real MCP session in a browser the person works in), so each test starts fresh.
  beforeEach(() => forgetMcp());
  const files = (map: Record<string, string>): SystemDeps => ({ platform: "darwin", home: "/Users/me", read: (p) => map[p] ?? null, exists: (p) => p in map });
  const CONFIG = "/Users/me/Library/Application Support/BrowserClaw/.browseros/config.json";
  const STATE = "/Users/me/Library/Application Support/BrowserClaw/.browseros/server.state";
  const config = JSON.stringify({ ports: { cdp: 9110, proxy: 9010, server: 9210 }, instance: { browseros_version: "0.51.2.3" } });

  test("the ports come out of the browser's own file, proxy first, and the debugger port is left alone", async () => {
    const asked: string[] = [];
    const get = (async (url: string) => {
      asked.push(url);
      if (!url.includes(":9010")) return new Response("nope", { status: 404 });
      return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "browseros-neo", version: "0.0.80" } } })}\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const found = await discoverMcp({ ...files({ [CONFIG]: config }), get });
    expect(found).toMatchObject({ url: "http://127.0.0.1:9010/mcp", port: 9010, from: "proxy", serverName: "browseros-neo", serverVersion: "0.0.80" });
    expect(asked).toEqual(["http://127.0.0.1:9010/mcp"]);
    expect(asked.some((u) => u.includes("9110"))).toBe(false);
  });

  test("when the proxy port doesn't answer, the server port is asked next", async () => {
    const get = (async (url: string) => (url.includes(":9210") ? new Response(JSON.stringify({ result: { serverInfo: { name: "browseros-neo", version: "0.0.80" } } }), { status: 200 }) : new Response("", { status: 500 }))) as unknown as typeof fetch;
    expect(await discoverMcp({ ...files({ [CONFIG]: config }), get })).toMatchObject({ port: 9210, from: "server" });
  });

  test("no config file means no address — nothing is guessed and no range is scanned", async () => {
    let asked = 0;
    const get = (async () => {
      asked++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await discoverMcp({ ...files({}), get })).toBeNull();
    expect(asked).toBe(0);
    expect(readBrowserConfig(files({ [CONFIG]: "{not json" }))).toBeNull();
  });

  test("a port that answers but isn't an MCP server doesn't count", async () => {
    const get = (async () => new Response("<html>hello</html>", { status: 200 })) as unknown as typeof fetch;
    expect(await discoverMcp({ ...files({ [CONFIG]: config }), get })).toBeNull();
    expect(serverInfo("<html>")).toBeNull();
    expect(serverInfo(`data: ${JSON.stringify({ result: { serverInfo: { name: "n", version: "1" } } })}`)).toEqual({ name: "n", version: "1" });
  });

  test("the address it answered on is kept, and asked again when the browser writes new ports", async () => {
    let asks = 0;
    const get = (async (url: string, init: RequestInit) => {
      if (init.method === "DELETE") return new Response("", { status: 202 });
      asks++;
      if (!url.includes(":9010")) return new Response("nope", { status: 404 });
      return new Response(JSON.stringify({ result: { serverInfo: { name: "browseros-neo", version: "0.0.80" } } }), { status: 200 });
    }) as unknown as typeof fetch;
    let now = 1_000_000;
    const d = { ...files({ [CONFIG]: config }), get, now: () => now };
    expect(await discoverMcp(d)).toMatchObject({ port: 9010 });
    // An agent polling setup_status works the checklist out every few seconds; each probe is a real MCP session in the
    // browser the person is working in, so it is asked once and kept.
    for (let i = 0; i < 5; i++) await discoverMcp(d);
    expect(asks).toBe(1);
    now += 11 * 60_000;
    await discoverMcp(d);
    expect(asks).toBe(2);
    // A new build writes new ports: that is a different question, asked straight away.
    const moved = JSON.stringify({ ports: { cdp: 9110, proxy: 9010, server: 9310 }, instance: { browseros_version: "0.52.0.0" } });
    await discoverMcp({ ...files({ [CONFIG]: moved }), get, now: () => now });
    expect(asks).toBe(3);
  });

  test("the session the probe opens is closed again, not left half open in the browser", async () => {
    const calls: { method: string; session: string | null }[] = [];
    const get = (async (_url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? "GET", session: new Headers(init.headers).get("mcp-session-id") });
      if (init.method === "DELETE") return new Response("", { status: 202 });
      return new Response(JSON.stringify({ result: { serverInfo: { name: "browseros-neo", version: "0.0.80" } } }), { status: 200, headers: { "mcp-session-id": "s-1" } });
    }) as unknown as typeof fetch;
    expect(await discoverMcp({ ...files({ [CONFIG]: config }), get })).toMatchObject({ port: 9010 });
    expect(calls).toEqual([
      { method: "POST", session: null },
      { method: "DELETE", session: "s-1" },
    ]);
  });

  test("the MCP helper's pid file is one signal, and never 'the browser is open' by itself", async () => {
    const alive = files({ [STATE]: JSON.stringify({ pid: 72345, creation_time: 1 }) });
    expect(serverRunning({ ...alive, alive: () => true })).toBe(true);
    expect(serverRunning({ ...alive, alive: () => false })).toBe(false);
    expect(serverRunning(files({}))).toBe(false);

    // As measured on a Mac: the browser was pid 72259 and server.state held 72345, its separate Rust
    // helper. So the browser can be open with no state file, and the helper's pid can be stale with the browser gone.
    const app = "/Applications/BrowserOS neo.app";
    const asked: string[][] = [];
    const browserUp = await browserRunning(app, { ...files({ [app]: "" }), run: fakeRun({ pgrep: { code: 0, out: "72259\n" } }, asked) });
    expect(browserUp).toEqual({ running: true, sure: true });
    expect(asked[0].join(" ")).toContain("/Contents/MacOS/");
    expect(asked[0].join(" ")).not.toContain("BrowserClawServer");
    // Nothing of the bundle running, and no helper either: it really is closed.
    expect(await browserRunning(app, { ...files({ [app]: "" }), run: fakeRun({ pgrep: { code: 1 } }) })).toEqual({ running: false, sure: true });
    // Nothing of the bundle running, but the helper's pid is alive: still said to be open.
    expect(await browserRunning(app, { ...alive, alive: () => true, run: fakeRun({ pgrep: { code: 1 } }) })).toEqual({ running: true, sure: true });
    // pgrep couldn't be run at all: said so, so the caller can be careful without the words claiming anything.
    expect(await browserRunning(app, { ...files({ [app]: "" }), run: async () => null })).toEqual({ running: false, sure: false });
  });

  test("the installed copy reads its version from its own bundle, with the browser's file as a fallback", async () => {
    const app = "/Applications/BrowserOS neo.app";
    const run = fakeRun({ plutil: { code: 0, out: JSON.stringify({ CFBundleShortVersionString: "0.51.2.3", CFBundleIdentifier: "com.browseros.BrowserClaw" }) }, pgrep: { code: 1 } });
    const found = await readInstalled({ ...files({ [app]: "", [CONFIG]: config }), run });
    expect(found).toMatchObject({ path: app, version: "0.51.2.3", bundleId: "com.browseros.BrowserClaw", kind: "dmg", running: false });
    const noPlist = await readInstalled({ ...files({ [app]: "", [CONFIG]: config }), run: fakeRun({ plutil: { code: 1 }, pgrep: { code: 1 } }) });
    expect(noPlist).toMatchObject({ version: "0.51.2.3", bundleId: null });
    expect(await readInstalled({ ...files({}), run })).toBeNull();
    // "It's open now" in the item is what was really seen of the bundle, with no state file anywhere.
    const open = await readInstalled({ ...files({ [app]: "", [CONFIG]: config }), run: fakeRun({ plutil: { code: 0, out: "{}" }, pgrep: { code: 0, out: "72259\n" } }) });
    expect(open?.running).toBe(true);
  });
});

// ---------------------------------------------------------------- the agents' own settings

describe("which agents point at it", () => {
  const home = "/Users/me";
  const read = (map: Record<string, string>): SystemDeps => ({ home, read: (p) => map[p] ?? null });

  test("each agent's entry is read from the file that agent writes", () => {
    const links = agentLinks(
      read({
        [`${home}/.claude.json`]: JSON.stringify({ mcpServers: { "crosstalk-setup": { command: "x" }, "browseros-neo": { url: "http://127.0.0.1:9010/mcp", type: "http" } } }),
        [`${home}/.codex/config.toml`]: '[mcp_servers.crosstalk-setup]\ncommand = "x"\n\n[mcp_servers.browseros-neo]\nurl = "http://127.0.0.1:9010/mcp"\n\n[tui]\nx = 1\n',
        [`${home}/.gemini/settings.json`]: JSON.stringify({ mcpServers: { "browseros-neo": { httpUrl: "http://127.0.0.1:9210/mcp" } } }),
      }),
    );
    expect(links).toEqual([
      { agent: "claude", name: "browseros-neo", url: "http://127.0.0.1:9010/mcp" },
      { agent: "gemini", name: "browseros-neo", url: "http://127.0.0.1:9210/mcp" },
      { agent: "codex", name: "browseros-neo", url: "http://127.0.0.1:9010/mcp" },
    ]);
  });

  test("settings that can't be read tell us nothing, rather than 'not connected'", () => {
    expect(agentLinks(read({ [`${home}/.claude.json`]: "{broken" }))).toEqual([]);
    expect(agentLinks(read({}))).toEqual([]);
  });

  test("only an MCP endpoint on this machine, or an entry named after the browser, counts", () => {
    expect(localMcpUrl("http://127.0.0.1:9010/mcp")).toBe(true);
    expect(localMcpUrl("http://localhost:9010/mcp/")).toBe(true);
    expect(localMcpUrl("https://mcp.example.com/mcp")).toBe(false);
    expect(localMcpUrl("http://127.0.0.1:9010/other")).toBe(false);
    const links = agentLinks(read({ [`${home}/.claude.json`]: JSON.stringify({ mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } } }) }));
    expect(links).toEqual([]);
  });

  test("somebody else's MCP server on this machine is not this browser's link", () => {
    const files = read({
      [`${home}/.claude.json`]: JSON.stringify({
        mcpServers: {
          // A person's own local MCP server. Taking every loopback /mcp for the browser read this as the agent's
          // BrowserOS entry, said the browser had moved port, and offered to "fix" a server that isn't it — while the
          // real entry below was never looked at.
          docs: { url: "http://127.0.0.1:3000/mcp" },
          "browseros-neo": { url: "http://127.0.0.1:9010/mcp" },
        },
      }),
    });
    expect(agentLinks(files, "http://127.0.0.1:9010/mcp")).toEqual([{ agent: "claude", name: "browseros-neo", url: "http://127.0.0.1:9010/mcp" }]);
    // An entry with any other name counts only when it points at the address the browser itself answered on.
    const unnamed = read({ [`${home}/.claude.json`]: JSON.stringify({ mcpServers: { docs: { url: "http://127.0.0.1:3000/mcp" }, neo: { url: "http://localhost:9010/mcp" } } }) });
    expect(agentLinks(unnamed, "http://127.0.0.1:9010/mcp")).toEqual([{ agent: "claude", name: "neo", url: "http://localhost:9010/mcp" }]);
    // With no address found (the browser has never run here), nothing unnamed is claimed as its link at all.
    expect(agentLinks(unnamed)).toEqual([]);
    // A name that says BrowserOS still counts whatever port it holds: that is what keeps a stale entry visible.
    const stale = read({ [`${home}/.claude.json`]: JSON.stringify({ mcpServers: { "browseros-neo": { url: "http://127.0.0.1:9210/mcp" } } }) });
    expect(agentLinks(stale, "http://127.0.0.1:9010/mcp")).toEqual([{ agent: "claude", name: "browseros-neo", url: "http://127.0.0.1:9210/mcp" }]);
    expect([namesBrowser("browseros-neo"), namesBrowser("BrowserClaw"), namesBrowser("docs")]).toEqual([true, true, false]);
  });

  test("one address written three ways is one address", () => {
    const url = "http://127.0.0.1:9010/mcp";
    for (const same of ["http://127.0.0.1:9010/mcp", "http://localhost:9010/mcp", "http://127.0.0.1:9010/mcp/", "http://[::1]:9010/mcp", " http://localhost:9010/mcp/ "]) expect([same, sameMcpUrl(same, url)]).toEqual([same, true]);
    for (const other of ["http://127.0.0.1:9210/mcp", "http://127.0.0.1:9010/other", "https://127.0.0.1:9010/mcp", "http://10.0.0.2:9010/mcp"]) expect([other, sameMcpUrl(other, url)]).toEqual([other, false]);
  });

  test("the Codex blocks are read without a TOML parser, and a block with no url is skipped", () => {
    expect(tomlMcpUrls('[mcp_servers.a]\nurl = "http://127.0.0.1:1/mcp"\n[mcp_servers.b]\ncommand = "x"\n[other]\nurl = "http://x/mcp"\n')).toEqual([["a", "http://127.0.0.1:1/mcp"]]);
  });

  test("the commands are the ones each CLI really takes", () => {
    expect(addCommand("claude", "http://127.0.0.1:9010/mcp")).toBe("claude mcp add --scope user --transport http browseros-neo http://127.0.0.1:9010/mcp");
    expect(addCommand("codex", "http://127.0.0.1:9010/mcp")).toBe("codex mcp add browseros-neo --url http://127.0.0.1:9010/mcp");
    expect(addCommand("gemini", "http://127.0.0.1:9010/mcp")).toBe("gemini mcp add --scope user --transport http browseros-neo http://127.0.0.1:9010/mcp");
    expect(removeCommand("claude")).toBe("claude mcp remove browseros-neo -s user");
    expect(removeCommand("codex")).toBe("codex mcp remove browseros-neo");
    // The entry's real name, because that is what a remove has to name: `claude mcp remove browseros-neo -s user`
    // exits 1 with `No MCP server named "browseros-neo" in user scope` when the person called theirs something else.
    expect(removeCommand("claude", "neo")).toBe("claude mcp remove neo -s user");
    expect(removeCommand("codex", "browserclaw")).toBe("codex mcp remove browserclaw");
    expect(removeCommand("gemini", "neo")).toBe("gemini mcp remove neo --scope user");
    // Anything that couldn't go on a command line as it is falls back to the name Crosstalk gives its own entry.
    for (const odd of ["neo; rm -rf ~", "a b", "$(x)", "", "-flag", "x".repeat(80)]) expect([odd, removeCommand("claude", odd)]).toEqual([odd, "claude mcp remove browseros-neo -s user"]);
  });
});

// ---------------------------------------------------------------- the command line

describe("crosstalk-hub browseros", () => {
  const facts = (over: Partial<Parameters<typeof describeFacts>[0]> = {}): Parameters<typeof describeFacts>[0] => ({
    installed: { path: "/Applications/BrowserOS neo.app", version: "0.51.2.3", bundleId: "com.browseros.BrowserClaw", kind: "dmg", running: false },
    target: mac(),
    newest: pickBuild(payload, mac()),
    releases: { ok: true },
    mcp: { url: "http://127.0.0.1:9010/mcp", port: 9010, from: "proxy", serverName: "browseros-neo", serverVersion: "0.0.80" },
    links: [{ agent: "claude", name: "browseros-neo", url: "http://127.0.0.1:9010/mcp" }],
    agents: ["claude", "codex"],
    ...over,
  });

  test("check says what's there, what's newest, and the command for the agent that hasn't got it", async () => {
    const lines: string[] = [];
    const code = await runBrowserOsCli(["check"], { say: (l) => lines.push(l), agents: () => ["claude", "codex"], facts: async () => facts() });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Installed: 0.51.2.3");
    expect(text).toContain("Newest build for this machine: 0.51.2.3");
    expect(text).toContain("Claude Code: connected");
    expect(text).toContain("Codex: not added — codex mcp add browseros-neo --url http://127.0.0.1:9010/mcp");
    expect(text).toContain("starts");
  });

  test("a stale entry is named with the address it should point at, and with its own name", () => {
    const lines = describeFacts(facts({ links: [{ agent: "claude", name: "neo", url: "http://127.0.0.1:9210/mcp" }] }));
    const text = lines.join("\n");
    expect(text).toContain("points at http://127.0.0.1:9210/mcp, which isn't where it answers");
    expect(text).toContain("claude mcp remove neo -s user; claude mcp add --scope user --transport http browseros-neo http://127.0.0.1:9010/mcp");
    // An entry written the other way round still reaches it: that is connected, not something to fix.
    expect(describeFacts(facts({ links: [{ agent: "claude", name: "browseros-neo", url: "http://localhost:9010/mcp/" }] })).join("\n")).toContain("Claude Code: connected");
  });

  test("install refuses with words when GitHub couldn't be asked, and when it's already newest", () => {
    expect(chooseToInstall(facts({ releases: { ok: false, why: "rate", detail: "used up", retryAt: Date.parse("2026-10-30T18:21:00Z") } }))).toMatchObject({ problem: expect.stringContaining("Couldn't ask GitHub") });
    expect(chooseToInstall(facts())).toMatchObject({ problem: expect.stringContaining("already the newest") });
    expect(chooseToInstall(facts({ target: buildTarget("freebsd", "x64") }))).toMatchObject({ problem: expect.stringContaining("no build") });
    expect(chooseToInstall(facts({ installed: null }))).toMatchObject({ build: { version: "0.51.2.3" } });
  });

  test("install says which build it picked and which SHA-256 it is checking, before it does anything", async () => {
    const lines: string[] = [];
    const code = await runBrowserOsCli(["install"], {
      say: (l) => lines.push(l),
      agents: () => [],
      facts: async () => facts({ installed: null }),
      install: async () => ({ done: "installed", path: "/Applications/BrowserOS neo.app", version: "0.51.2.3", replaced: null }),
    });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("BrowserOS_neo_v0.51.2.3_arm64.dmg");
    expect(text).toContain("tagged browserclaw/v0.51.2.3");
    expect(text).toContain("71de41267c6a9bd991c2d560125304082aa32a45a86f572fd819ce6e521e8a56");
  });

  test("a copy that's open is the one refusal with a way forward, and the person has to ask for it by name", async () => {
    const lines: string[] = [];
    const code = await runBrowserOsCli(["install"], {
      say: (l) => lines.push(l),
      agents: () => [],
      facts: async () => facts({ installed: { path: "/Applications/BrowserOS neo.app", version: "0.51.2.3", bundleId: "com.browseros.BrowserClaw", kind: "dmg", running: true }, newest: { ...pickBuild(payload, mac())!, version: "0.52.0.0" } }),
      install: async () => ({ done: "failed", why: "running", detail: "BrowserOS neo is open, and replacing it now would close it and lose whatever is in it. Quit it first, or say to replace it anyway." }),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("--replace-running");
    expect(lines.join("\n")).toContain("your profile stays");
  });

  test("a failed install exits non-zero and says why, without claiming anything was installed", async () => {
    const lines: string[] = [];
    const code = await runBrowserOsCli(["install"], {
      say: (l) => lines.push(l),
      agents: () => [],
      facts: async () => facts({ installed: null }),
      install: async () => ({ done: "failed", why: "checksum", detail: "The download doesn't match the SHA-256 GitHub reports." }),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("doesn't match the SHA-256");
    expect(lines.join("\n")).not.toContain("Installed 0.51");
  });
});
