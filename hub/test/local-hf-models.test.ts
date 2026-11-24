// Hugging Face GGUF models for Settings → Local models (hub/src/local/models.ts) against a fake Hugging Face on
// 127.0.0.1: reading repo names and quants, a repo's models, downloads that are pinned and pick up where they stopped,
// and the Trash. Nothing is downloaded from the internet.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { HfModel } from "@crosstalk/shared";
import { HOME } from "../src/config";
import { HttpError } from "../src/engine/engine";
import { aliasFor, checkModel, choices, download, groupModels, modelFilesOnDisk, modelPath, modelsDir, parseRepoInput, quantOf, revisionFile, toTrash } from "../src/local/models";
import { fakeHuggingFace, sha256, type FakeRepo } from "./fixtures/local-fakes";

const TOKEN = "hf_testtoken0123456789";

const work = realpathSync(mkdtempSync(join(tmpdir(), "ct-hf-")));
const savedUrl = process.env.CROSSTALK_HF_URL;

const bytes = (n: number, seed: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7 + (i >> 8)) & 255;
  return b;
};
const FILES = {
  "Tiny-Q4_K_M.gguf": bytes(300_000, 1),
  "Tiny-Q8_0.gguf": bytes(520_000, 2),
  "Tiny-UD-Q6_K_XL.gguf": bytes(410_000, 3),
  "mmproj-Tiny-F16.gguf": bytes(90_000, 4),
  "BF16/Tiny-BF16-00002-of-00002.gguf": bytes(350_000, 5),
  "BF16/Tiny-BF16-00001-of-00002.gguf": bytes(400_000, 6),
  "IQ4_XS/Tiny-IQ4_XS-00001-of-00003.gguf": bytes(100_000, 7),
  "Slow-Q2_K.gguf": bytes(1_200_000, 8),
  "README.md": new TextEncoder().encode("# Tiny"),
};
/** A repo whose file is uploaded again during the tests (Hugging Face keeps the old commit). */
const changing: FakeRepo = { files: { "Changing-Q4_K_M.gguf": bytes(600_000, 11) } };

let hf: ReturnType<typeof fakeHuggingFace>;

const model = (file: keyof typeof FILES, repo = "acme/Tiny-GGUF"): HfModel => ({ repo, files: [file], quant: quantOf(file), sizeBytes: FILES[file].length, gated: false });
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected it to fail");
};

beforeAll(() => {
  hf = fakeHuggingFace(
    {
      "acme/Tiny-GGUF": { files: FILES },
      "acme/Gated-GGUF": { gated: "manual", files: { "Gated-Q4_K_M.gguf": bytes(200_000, 9) } },
      "acme/Docs": { files: { "README.md": new TextEncoder().encode("no models") } },
      "acme/Changing-GGUF": changing,
    },
    { token: TOKEN, pageSize: 4 },
  );
  hf.slow.add("acme/Tiny-GGUF/Slow-Q2_K.gguf");
  process.env.CROSSTALK_HF_URL = hf.url;
});

afterAll(() => {
  hf?.stop();
  if (savedUrl === undefined) delete process.env.CROSSTALK_HF_URL;
  else process.env.CROSSTALK_HF_URL = savedUrl;
  // The hub's home is shared by the test run: leave no models for other tests to find.
  rmSync(modelsDir(), { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe("Hugging Face", () => {
  test("a model's name in chats comes from its repo", () => {
    expect(aliasFor("unsloth/Qwen3.8-27B-GGUF")).toBe("qwen3.8-27b");
    expect(aliasFor("orcarouter/Qwen3.8-27B-Instruct-GGUF")).toBe("qwen3.8-27b-instruct");
    expect(aliasFor("bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF")).toBe("kimi-linear-48b-a3b-instruct");
    expect(aliasFor("ggml-org/gpt-oss-20b-GGUF")).toBe("gpt-oss-20b");
    expect(aliasFor("acme/Tiny-GGUF")).toBe("tiny");
    expect(aliasFor("acme/---")).toBe("local-model");
  });

  test("reads repo names, repo links and file links", () => {
    expect(parseRepoInput("acme/Tiny-GGUF")).toEqual({ repo: "acme/Tiny-GGUF", file: null });
    expect(parseRepoInput(" https://huggingface.co/acme/Tiny-GGUF/ ")).toEqual({ repo: "acme/Tiny-GGUF", file: null });
    expect(parseRepoInput("https://huggingface.co/acme/Tiny-GGUF/tree/main")).toEqual({ repo: "acme/Tiny-GGUF", file: null });
    expect(parseRepoInput("huggingface.co/acme/Tiny-GGUF/blob/main/Tiny-Q8_0.gguf")).toEqual({ repo: "acme/Tiny-GGUF", file: "Tiny-Q8_0.gguf" });
    expect(parseRepoInput("https://hf.co/acme/Tiny-GGUF/resolve/main/BF16/Tiny-BF16-00001-of-00002.gguf?download=true")).toEqual({ repo: "acme/Tiny-GGUF", file: "BF16/Tiny-BF16-00001-of-00002.gguf" });
    for (const bad of ["", "acme", "https://example.com/acme/Tiny-GGUF", "https://huggingface.co/datasets/acme/x", "../etc/passwd", "acme/../x", "https://huggingface.co/acme/Tiny-GGUF/blob/main/..%2F..%2Fx.gguf"]) {
      expect(() => parseRepoInput(bad)).toThrow(HttpError);
    }
  });

  test("reads the quant from file names", () => {
    const cases: Record<string, string | null> = {
      "Qwen3-8B-Q4_K_M.gguf": "Q4_K_M",
      "Qwen3-8B-IQ4_XS.gguf": "IQ4_XS",
      "Qwen3-30B-A3B-UD-Q6_K_XL.gguf": "UD-Q6_K_XL",
      "UD-Q6_K/Qwen3-UD-Q6_K-00001-of-00002.gguf": "UD-Q6_K",
      "gpt-oss-20b-MXFP4.gguf": "MXFP4",
      "model-f16.gguf": "F16",
      "Model-BF16-00001-of-00003.gguf": "BF16",
      "llama-2-7b.Q8_0.gguf": "Q8_0",
      "DeepSeek-R1-UD-IQ1_S.gguf": "UD-IQ1_S",
      "Qwen2.5-Coder-7B-Instruct-IQ2_XXS.gguf": "IQ2_XXS",
      "tiny-Q4_0_4_4.gguf": "Q4_0_4_4",
      "plain-model.gguf": null,
    };
    for (const [name, quant] of Object.entries(cases)) expect([name, quantOf(name)]).toEqual([name, quant]);
  });

  test("groups split parts in order, leaves out mmproj files and incomplete models, smallest first", () => {
    const files = Object.entries(FILES).map(([path, b]) => ({ path, size: b.length }));
    const models = groupModels("acme/Tiny-GGUF", files, false);
    expect(models.map((m) => m.files)).toEqual([
      ["Tiny-Q4_K_M.gguf"],
      ["Tiny-UD-Q6_K_XL.gguf"],
      ["Tiny-Q8_0.gguf"],
      ["BF16/Tiny-BF16-00001-of-00002.gguf", "BF16/Tiny-BF16-00002-of-00002.gguf"],
      ["Slow-Q2_K.gguf"],
    ]);
    expect(models[3]).toEqual({ repo: "acme/Tiny-GGUF", files: ["BF16/Tiny-BF16-00001-of-00002.gguf", "BF16/Tiny-BF16-00002-of-00002.gguf"], quant: "BF16", sizeBytes: 750_000, gated: false });
  });

  test("choices: info and every page of the file tree; a file link puts its model first; the token only when given", async () => {
    const before = hf.requests.length;
    const c = await choices("acme/Tiny-GGUF");
    expect(c.repo).toBe("acme/Tiny-GGUF");
    expect(c.gated).toBe(false);
    expect(c.models.map((m) => m.quant)).toEqual(["Q4_K_M", "UD-Q6_K_XL", "Q8_0", "BF16", "Q2_K"]);
    const seen = hf.requests.slice(before);
    expect(seen[0].path).toBe("/api/models/acme/Tiny-GGUF");
    expect(seen.slice(1).map((r) => r.path)).toEqual([
      "/api/models/acme/Tiny-GGUF/tree/main?recursive=true",
      "/api/models/acme/Tiny-GGUF/tree/main?recursive=true&cursor=4",
      "/api/models/acme/Tiny-GGUF/tree/main?recursive=true&cursor=8",
    ]);
    expect(seen.every((r) => r.auth === null)).toBe(true);
    const linked = await choices("https://huggingface.co/acme/Tiny-GGUF/blob/main/BF16/Tiny-BF16-00002-of-00002.gguf", TOKEN);
    expect(linked.models[0].quant).toBe("BF16");
    expect(linked.models).toHaveLength(5);
    expect(hf.requests.at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
    const gated = await choices("acme/Gated-GGUF");
    expect(gated.gated).toBe(true);
    expect(gated.models[0]).toMatchObject({ files: ["Gated-Q4_K_M.gguf"], gated: true });
    expect((await rejection(choices("acme/Missing-GGUF"))).message).toContain("Couldn't find acme/Missing-GGUF on Hugging Face: check the name");
    expect((await rejection(choices("acme/Docs"))).message).toContain("has no GGUF model files");
  });

  test("download writes to the models folder; the token goes to Hugging Face only, never to its storage", async () => {
    const m = model("Tiny-Q8_0.gguf");
    const path = await download(m, TOKEN, () => {});
    expect(path).toBe(join(HOME, "models", "acme", "Tiny-GGUF", "Tiny-Q8_0.gguf"));
    expect(path).toBe(modelPath(m));
    expect(sha256(new Uint8Array(readFileSync(path)))).toBe(sha256(FILES["Tiny-Q8_0.gguf"]));
    expect(existsSync(`${path}.part`)).toBe(false);
    // From the repo's newest commit, which the download was pinned to when it began.
    expect(hf.requests.at(-2)).toMatchObject({ path: "/api/models/acme/Tiny-GGUF", auth: `Bearer ${TOKEN}` });
    // (Checked field by field: Bun's toMatchObject puts an expect.stringMatching into the object it checks.)
    expect(hf.requests.at(-1)!.path).toMatch(/^\/acme\/Tiny-GGUF\/resolve\/[0-9a-f]{40}\/Tiny-Q8_0\.gguf$/);
    expect(hf.requests.at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
    expect(hf.storageRequests.at(-1)).toMatchObject({ auth: null });
    expect(modelFilesOnDisk()).toContainEqual({ file: "acme/Tiny-GGUF/Tiny-Q8_0.gguf", bytes: 520_000, partial: false });
    // A split model: every part, in its folder.
    const split = groupModels("acme/Tiny-GGUF", Object.entries(FILES).map(([p, b]) => ({ path: p, size: b.length })), false).find((x) => x.quant === "BF16")!;
    expect(await download(split, null, () => {})).toBe(join(HOME, "models", "acme", "Tiny-GGUF", "BF16", "Tiny-BF16-00001-of-00002.gguf"));
    expect(hf.requests.at(-1)!.auth).toBeNull();
    expect(readFileSync(join(HOME, "models", "acme", "Tiny-GGUF", "BF16", "Tiny-BF16-00002-of-00002.gguf")).length).toBe(350_000);
  });

  test("an interrupted download picks up where it stopped (HTTP Range)", async () => {
    const m = model("Tiny-UD-Q6_K_XL.gguf");
    hf.cutOnce.add("acme/Tiny-GGUF/Tiny-UD-Q6_K_XL.gguf");
    const e = await rejection(download(m, null, () => {}));
    expect(e.message).toContain("picks up where it stopped");
    const part = `${modelPath(m)}.part`;
    const had = statSync(part).size;
    expect(had).toBe(205_000);
    expect(existsSync(modelPath(m))).toBe(false);
    await download(m, null, () => {});
    expect(hf.storageRequests.at(-1)!.range).toBe(`bytes=${had}-`);
    expect(sha256(new Uint8Array(readFileSync(modelPath(m))))).toBe(sha256(FILES["Tiny-UD-Q6_K_XL.gguf"]));
    expect(existsSync(part)).toBe(false);
  });

  test("a download stays with the version it began with: a file uploaded again meanwhile is never joined to the old bytes", async () => {
    const m: HfModel = { repo: "acme/Changing-GGUF", files: ["Changing-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: 600_000, gated: false };
    const first = changing.files["Changing-Q4_K_M.gguf"];
    const began = changing.sha!;
    hf.cutOnce.add("acme/Changing-GGUF/Changing-Q4_K_M.gguf");
    expect((await rejection(download(m, null, () => {}))).message).toContain("picks up where it stopped");
    // Pinned to the commit it began with, kept beside the unfinished file.
    expect(readFileSync(revisionFile(m), "utf8").trim()).toBe(began);
    const part = statSync(`${modelPath(m)}.part`).size;
    expect(part).toBeGreaterThan(0);
    // Uploaded again on main meanwhile (Hugging Face keeps the old commit).
    changing.history = { [began]: { "Changing-Q4_K_M.gguf": first } };
    changing.files = { "Changing-Q4_K_M.gguf": bytes(600_000, 12) };
    changing.sha = "c".repeat(40);
    await download(m, null, () => {});
    expect(Buffer.compare(readFileSync(modelPath(m)), Buffer.from(first))).toBe(0);
    expect(hf.requests.filter((r) => r.path.includes("/resolve/")).slice(-1)[0].path).toBe(`/acme/Changing-GGUF/resolve/${began}/Changing-Q4_K_M.gguf`);
    expect(existsSync(revisionFile(m))).toBe(false);

    // A commit that's gone (its history rewritten): a download with nothing finished starts again from the newest.
    rmSync(modelPath(m), { force: true });
    hf.cutOnce.add("acme/Changing-GGUF/Changing-Q4_K_M.gguf");
    await rejection(download(m, null, () => {}));
    expect(readFileSync(revisionFile(m), "utf8").trim()).toBe("c".repeat(40));
    changing.history = {};
    changing.files = { "Changing-Q4_K_M.gguf": bytes(600_000, 13) };
    changing.sha = "d".repeat(40);
    await download(m, null, () => {});
    expect(Buffer.compare(readFileSync(modelPath(m)), Buffer.from(changing.files["Changing-Q4_K_M.gguf"]))).toBe(0);
    expect(existsSync(revisionFile(m))).toBe(false);
  });

  test("progress comes at most twice a second", async () => {
    const m = model("Slow-Q2_K.gguf");
    const at: number[] = [];
    await download(m, null, (p) => {
      at.push(Date.now());
      expect(p.totalBytes).toBe(1_200_000);
      expect(p.file).toBe("Slow-Q2_K.gguf");
    });
    expect(at.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(495);
    rmSync(modelPath(m));
  });

  test("a gated model without the token says to accept its terms and save a token", async () => {
    const m: HfModel = { repo: "acme/Gated-GGUF", files: ["Gated-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: 200_000, gated: true };
    for (const token of [null, "hf_wrong_token_00000"]) {
      const e = await rejection(download(m, token, () => {}));
      expect(e.status).toBe(403);
      expect(e.message).toBe("Hugging Face won't let this download acme/Gated-GGUF yet: open huggingface.co/acme/Gated-GGUF, accept the model's terms, then save a Hugging Face token (from the same account) and try again.");
      expect(e.message).not.toContain("hf_wrong");
    }
    expect(await download(m, TOKEN, () => {})).toBe(modelPath(m));
  });

  test("refuses to start when the disk would be left with less than 2 GB free", async () => {
    const m: HfModel = { repo: "acme/Tiny-GGUF", files: ["Tiny-Q4_K_M.gguf"], quant: "Q4_K_M", sizeBytes: 10 ** 15, gated: false };
    const before = hf.requests.length;
    const e = await rejection(download(m, null, () => {}));
    expect(e).toMatchObject({ status: 507, code: "low_disk" });
    expect(e.message).toContain("Not enough free space");
    expect(e.message).toContain("pick a smaller quant");
    expect(hf.requests.length).toBe(before);
    expect(existsSync(`${modelPath(m)}.part`)).toBe(false);
  });

  test("checks a model a request names strictly", () => {
    const ok = model("Tiny-Q4_K_M.gguf");
    expect(checkModel(ok)).toEqual(ok);
    const bad: unknown[] = [
      null,
      { ...ok, repo: "../etc" },
      { ...ok, repo: "acme/Tiny-GGUF/extra" },
      { ...ok, files: ["../../secrets.gguf"] },
      { ...ok, files: ["/etc/passwd.gguf"] },
      { ...ok, files: ["Tiny-Q4_K_M.txt"] },
      { ...ok, files: [] },
      { ...ok, files: ["mmproj-Tiny-F16.gguf"] },
      { ...ok, files: ["BF16/Tiny-BF16-00001-of-00002.gguf"] },
      { ...ok, files: ["BF16/Tiny-BF16-00002-of-00002.gguf", "BF16/Tiny-BF16-00001-of-00002.gguf"] },
      { ...ok, files: ["a\\b.gguf"] },
      { ...ok, sizeBytes: -1 },
    ];
    for (const m of bad) expect(() => checkModel(m)).toThrow(HttpError);
  });

  test("toTrash moves files into the Trash under free names, never deleting them", async () => {
    const home = join(work, "trash-test");
    const a = join(work, "one", "Tiny-Q4_K_M.gguf");
    const b = join(work, "two", "Tiny-Q4_K_M.gguf");
    for (const p of [a, b]) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "model");
    }
    const moved = await toTrash([a, b, join(work, "missing.gguf")], { home, platform: "darwin" });
    expect(moved).toEqual([join(home, ".Trash", "Tiny-Q4_K_M.gguf"), join(home, ".Trash", "Tiny-Q4_K_M 2.gguf")]);
    expect(existsSync(a) || existsSync(b)).toBe(false);
    for (const p of moved) expect(readFileSync(p, "utf8")).toBe("model");
    // Linux without gio: the freedesktop.org Trash, with a .trashinfo for each.
    writeFileSync(a, "model");
    writeFileSync(b, "model");
    const linux = await toTrash([a, b], { home, platform: "linux", gio: false });
    const trash = join(home, ".local", "share", "Trash");
    expect(linux).toEqual([join(trash, "files", "Tiny-Q4_K_M.gguf"), join(trash, "files", "Tiny-Q4_K_M.2.gguf")]);
    const info = readFileSync(join(trash, "info", "Tiny-Q4_K_M.2.gguf.trashinfo"), "utf8");
    expect(info).toStartWith(`[Trash Info]\nPath=${b}\nDeletionDate=`);
    expect(info).toMatch(/DeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/);
  });

  test("a file on another drive goes in that drive's own Trash, never copied onto this disk; without one it stays where it is", async () => {
    const home = join(work, "trash-drive-home");
    const drive = join(work, "drive");
    const file = join(drive, "models", "acme", "Tiny-GGUF", "Tiny-Q4_K_M.gguf");
    mkdirSync(dirname(file), { recursive: true });
    const uid = String(process.getuid?.() ?? 0);
    // A pretend machine: the drive folder is another device than everything else.
    const deviceOf = (p: string) => (!existsSync(p) ? null : realpathSync(p) === drive || realpathSync(p).startsWith(drive + sep) ? 2 : 1);
    // A Mac: the Finder's <drive>/.Trashes/<uid>, made as the Finder makes it.
    writeFileSync(file, "model");
    expect(await toTrash([file], { home, platform: "darwin", deviceOf })).toEqual([join(drive, ".Trashes", uid, "Tiny-Q4_K_M.gguf")]);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(join(home, ".Trash"))).toEqual([]);
    expect(statSync(join(drive, ".Trashes")).mode & 0o7777).toBe(0o1333);
    // As the Finder makes it, no one can list it: opened up again so the test's folder can go.
    chmodSync(join(drive, ".Trashes"), 0o755);
    // Linux: the drive's .Trash-<uid>, its path from the drive's top; an administrator's shared .Trash when there is one.
    writeFileSync(file, "model");
    expect(await toTrash([file], { home, platform: "linux", gio: false, deviceOf })).toEqual([join(drive, `.Trash-${uid}`, "files", "Tiny-Q4_K_M.gguf")]);
    expect(readFileSync(join(drive, `.Trash-${uid}`, "info", "Tiny-Q4_K_M.gguf.trashinfo"), "utf8")).toStartWith("[Trash Info]\nPath=models/acme/Tiny-GGUF/Tiny-Q4_K_M.gguf\nDeletionDate=");
    expect(existsSync(join(home, ".local", "share", "Trash", "files", "Tiny-Q4_K_M.gguf"))).toBe(false);
    mkdirSync(join(drive, ".Trash"));
    chmodSync(join(drive, ".Trash"), 0o1777);
    writeFileSync(file, "model");
    expect(await toTrash([file], { home, platform: "linux", gio: false, deviceOf })).toEqual([join(drive, ".Trash", uid, "files", "Tiny-Q4_K_M.gguf")]);
    // A drive whose Trash can't be made: it stays, and the words say what to do instead.
    if (process.getuid?.() !== 0) {
      rmSync(join(drive, ".Trashes"), { recursive: true, force: true });
      rmSync(join(drive, ".Trash"), { recursive: true, force: true });
      rmSync(join(drive, `.Trash-${uid}`), { recursive: true, force: true });
      writeFileSync(file, "model");
      chmodSync(drive, 0o555);
      try {
        for (const platform of ["darwin", "linux"] as const) {
          const err = await toTrash([file], { home, platform, gio: false, deviceOf }).catch((e) => e);
          expect(err).toMatchObject({ status: 409, code: "no_trash" });
          expect(err.message).toBe(`Tiny-Q4_K_M.gguf is on another drive, and Crosstalk can't use that drive's Trash: delete it for good instead, or delete it in ${platform === "darwin" ? "the Finder" : "the file manager"}.`);
          expect(readFileSync(file, "utf8")).toBe("model");
        }
      } finally {
        chmodSync(drive, 0o755);
      }
    }
  });
});
