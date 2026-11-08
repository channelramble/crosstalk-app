import { expect, test } from "bun:test";
import { ggufMetadata, kvShape } from "../src/gguf";
import { ggufBytes, qwenLike } from "./fixtures/gguf";

// A GGUF file's header, read for the "fits this machine?" verdict (Settings → Local models): the memory a model's context takes.

test("the shape of a model from its header: KV heads × head size × layers, and the context it was trained for", () => {
  const meta = ggufMetadata(qwenLike())!;
  expect(meta.get("general.architecture")).toBe("qwen3");
  expect(meta.get("qwen3.block_count")).toBe(36);
  // A vocabulary is skipped, not kept.
  expect(meta.get("tokenizer.ggml.tokens")).toBeNull();
  // 36 layers × 8 KV heads × (128 + 128) × 2 bytes: 144 KiB a token.
  expect(kvShape(meta)).toEqual({ bytesPerToken: 36 * 8 * 256 * 2, contextLength: 40960 });
  // Without key_length, a head is the embedding over the heads (Llama 3 8B: 4096 / 32 = 128).
  const llama = ggufBytes([["general.architecture", "llama"], ["llama.block_count", 32], ["llama.embedding_length", 4096], ["llama.attention.head_count", 32], ["llama.attention.head_count_kv", 8], ["llama.context_length", 131072]]);
  expect(kvShape(ggufMetadata(llama)!)).toEqual({ bytesPerToken: 131072, contextLength: 131072 });
});

test("a header cut short still gives what came before the cut; one cut before the shape gives none", () => {
  const whole = qwenLike();
  // Cut inside the vocabulary: the shape came before it.
  const cut = whole.subarray(0, whole.length - 5000);
  expect(kvShape(ggufMetadata(cut)!)).toEqual({ bytesPerToken: 147456, contextLength: 40960 });
  // Cut before block_count: not enough to say.
  const early = ggufMetadata(whole.subarray(0, 120))!;
  expect(early.get("general.architecture")).toBe("qwen3");
  expect(kvShape(early)).toBeNull();
  // Not GGUF, or too short to be.
  expect(ggufMetadata(new TextEncoder().encode("<!doctype html><html>not a model</html>"))).toBeNull();
  expect(ggufMetadata(whole.subarray(0, 10))).toBeNull();
  const v1 = whole.slice(0, 64);
  new DataView(v1.buffer).setUint32(4, 1, true);
  expect(ggufMetadata(v1)).toBeNull();
  // An unknown value type ends the reading there.
  const odd = ggufBytes([["general.architecture", "qwen3"], ["qwen3.block_count", 36]]);
  const bad = odd.slice();
  // The second entry's type (after its key) becomes 99.
  const at = bad.length - 4 - 4;
  new DataView(bad.buffer).setUint32(at, 99, true);
  const partly = ggufMetadata(bad)!;
  expect(partly.get("general.architecture")).toBe("qwen3");
  expect(partly.has("qwen3.block_count")).toBe(false);
});

test("sliding-window layers aren't counted per token in the families llama.cpp windows; the header's pattern wins over the family's", () => {
  // Gemma 3 12B: 48 layers, 8 KV heads of 256; 5 in 6 layers only see a 1024-token window.
  const gemma = (extra: Parameters<typeof ggufBytes>[0] = []) =>
    ggufMetadata(ggufBytes([["general.architecture", "gemma3"], ["gemma3.block_count", 48], ["gemma3.attention.head_count", 16], ["gemma3.attention.head_count_kv", 8], ["gemma3.attention.key_length", 256], ["gemma3.attention.value_length", 256], ["gemma3.attention.sliding_window", 1024], ["gemma3.context_length", 131072], ...extra]))!;
  expect(kvShape(gemma())!.bytesPerToken).toBe(8 * 8 * 512 * 2);
  // A pattern in the header: every other layer is windowed.
  expect(kvShape(gemma([["gemma3.attention.sliding_window_pattern", [1, 0, 1, 0, 1, 0], "bool"]]))!.bytesPerToken).toBe(24 * 8 * 512 * 2);
  // A family llama.cpp doesn't window counts every layer, whatever its header says (more memory, never less).
  const other = ggufMetadata(ggufBytes([["general.architecture", "newarch"], ["newarch.block_count", 10], ["newarch.attention.head_count_kv", 4], ["newarch.attention.key_length", 64], ["newarch.attention.sliding_window", 4096]]))!;
  expect(kvShape(other)!.bytesPerToken).toBe(10 * 4 * 128 * 2);
  // Phi-3.5-mini carries a window that llama.cpp turns off: 32 layers × 32 KV heads of 96, 384 KiB a token.
  const phi = ggufMetadata(ggufBytes([["general.architecture", "phi3"], ["phi3.block_count", 32], ["phi3.embedding_length", 3072], ["phi3.attention.head_count", 32], ["phi3.attention.head_count_kv", 32], ["phi3.attention.sliding_window", 262144], ["phi3.context_length", 131072]]))!;
  expect(kvShape(phi)).toEqual({ bytesPerToken: 384 * 1024, contextLength: 131072 });
  // gpt-oss is windowed by llama.cpp: every other layer.
  const oss = ggufMetadata(ggufBytes([["general.architecture", "gpt-oss"], ["gpt-oss.block_count", 24], ["gpt-oss.attention.head_count_kv", 8], ["gpt-oss.attention.key_length", 64], ["gpt-oss.attention.sliding_window", 128]]))!;
  expect(kvShape(oss)!.bytesPerToken).toBe(12 * 8 * 128 * 2);
  // Qwen3-Next: only every fourth layer attends.
  const next = ggufMetadata(ggufBytes([["general.architecture", "qwen3next"], ["qwen3next.block_count", 48], ["qwen3next.attention.head_count_kv", 2], ["qwen3next.attention.key_length", 256], ["qwen3next.full_attention_interval", 4]]))!;
  expect(kvShape(next)!.bytesPerToken).toBe(12 * 2 * 512 * 2);
});

test("per-layer KV heads (hybrid models), DeepSeek's compressed cache, and recurrent models", () => {
  // Granite hybrid: 4 attention layers of 8 KV heads, the rest recurrent (0).
  const heads = Array.from({ length: 40 }, (_, i) => (i % 10 === 5 ? 8 : 0));
  const hybrid = ggufMetadata(ggufBytes([["general.architecture", "granitehybrid"], ["granitehybrid.block_count", 40], ["granitehybrid.attention.head_count", 32], ["granitehybrid.attention.head_count_kv", heads], ["granitehybrid.embedding_length", 4096]]))!;
  expect(kvShape(hybrid)!.bytesPerToken).toBe(4 * 8 * 256 * 2);
  // DeepSeek V3 / Kimi K2 (MLA): one 512 + 64 vector per layer.
  const mla = ggufMetadata(ggufBytes([["general.architecture", "deepseek2"], ["deepseek2.block_count", 61], ["deepseek2.attention.kv_lora_rank", 512], ["deepseek2.rope.dimension_count", 64], ["deepseek2.context_length", 163840]]))!;
  expect(kvShape(mla)).toEqual({ bytesPerToken: 61 * 576 * 2, contextLength: 163840 });
  // Mamba keeps a state, nothing per token.
  expect(kvShape(ggufMetadata(ggufBytes([["general.architecture", "mamba"], ["mamba.block_count", 64]]))!)).toEqual({ bytesPerToken: 0, contextLength: null });
  // Not enough said: no layers, no heads, no architecture.
  expect(kvShape(ggufMetadata(ggufBytes([["general.architecture", "llama"], ["llama.attention.head_count_kv", 8]]))!)).toBeNull();
  expect(kvShape(ggufMetadata(ggufBytes([["general.architecture", "llama"], ["llama.block_count", 32]]))!)).toBeNull();
  expect(kvShape(ggufMetadata(ggufBytes([["general.name", "nameless"]]))!)).toBeNull();
});

test("every value type reads as written", () => {
  const meta = ggufMetadata(ggufBytes([["a.u8", 7, "u8"], ["a.i32", -5, "i32"], ["a.f32", 0.5, "f32"], ["a.u64", 5_000_000_000n, "u64"], ["a.bool", true], ["a.text", "héllo"], ["a.list", [1, 2, 3]]]))!;
  expect(Object.fromEntries(meta)).toEqual({ "a.u8": 7, "a.i32": -5, "a.f32": 0.5, "a.u64": 5_000_000_000, "a.bool": true, "a.text": "héllo", "a.list": [1, 2, 3] });
});
