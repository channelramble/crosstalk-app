// A GGUF file's header (llama.cpp's model format), read from its first bytes: how the model is built, so the memory its
// context takes (the KV cache) can be worked out before it's downloaded or started. Only what the "fits this machine?"
// verdict needs (Settings → Local models); the tensors themselves are never read.

export type GgufValue = number | string | boolean | number[] | null;

const MAGIC = 0x46554747; // "GGUF", little-endian
/** Bytes of each fixed-size value type (GGUF types 0-7 and 10-12; 8 is a string, 9 an array). */
const SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
/** Number arrays longer than this (none of the shape's are) are skipped, not kept. */
const MAX_KEPT = 4096;

class Short extends Error {}
class Bad extends Error {}

/**
 * The metadata in a GGUF file's first bytes, as far as they go: a header cut short gives what came before the cut (the
 * shape comes before the tokenizer's long lists in the files llama.cpp's tools write). Lists of strings (a vocabulary)
 * are skipped and kept as null. Null when the bytes aren't a GGUF v2 or v3 file.
 */
export function ggufMetadata(bytes: Uint8Array): Map<string, GgufValue> | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) return null;
  const version = view.getUint32(4, true);
  if (version !== 2 && version !== 3) return null;
  let at = 16; // magic, version, tensor count
  const need = (n: number) => {
    if (!Number.isFinite(n) || at + n > bytes.length) throw new Short();
  };
  const u32 = () => {
    need(4);
    const v = view.getUint32(at, true);
    at += 4;
    return v;
  };
  const u64 = () => {
    need(8);
    const v = view.getBigUint64(at, true);
    at += 8;
    return v > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(v);
  };
  const text = () => {
    const n = u64();
    need(n);
    const s = new TextDecoder().decode(bytes.subarray(at, at + n));
    at += n;
    return s;
  };
  const number = (type: number): number => {
    need(SIZE[type]);
    const v =
      type === 0 || type === 7 ? view.getUint8(at) :
      type === 1 ? view.getInt8(at) :
      type === 2 ? view.getUint16(at, true) :
      type === 3 ? view.getInt16(at, true) :
      type === 4 ? view.getUint32(at, true) :
      type === 5 ? view.getInt32(at, true) :
      type === 6 ? view.getFloat32(at, true) :
      type === 10 ? Number(view.getBigUint64(at, true)) :
      type === 11 ? Number(view.getBigInt64(at, true)) :
      view.getFloat64(at, true);
    at += SIZE[type];
    return v;
  };
  const value = (type: number): GgufValue => {
    if (type === 8) return text();
    if (type === 7) return number(7) !== 0;
    if (SIZE[type]) return number(type);
    if (type !== 9) throw new Bad();
    const of = u32();
    const n = u64();
    if (of === 8) {
      for (let i = 0; i < n; i++) {
        const len = u64();
        need(len);
        at += len;
      }
      return null;
    }
    if (!SIZE[of]) throw new Bad();
    need(SIZE[of] * n);
    if (n > MAX_KEPT) {
      at += SIZE[of] * n;
      return null;
    }
    return Array.from({ length: n }, () => number(of));
  };
  const out = new Map<string, GgufValue>();
  try {
    need(8);
    const kvs = u64();
    for (let i = 0; i < kvs; i++) {
      const key = text();
      out.set(key, value(u32()));
    }
  } catch (e) {
    if (!(e instanceof Short) && !(e instanceof Bad)) throw e;
  }
  return out;
}

/** A model's shape: what its context costs in memory, and the context it was trained for. */
export interface KvShape {
  /** Bytes each token of context takes in the KV cache (f16, llama.cpp's default) over the layers that keep every token. */
  bytesPerToken: number;
  contextLength: number | null;
}

/**
 * The families whose layers llama.cpp gives a sliding window, with the share of their layers that sees the whole
 * context (the rest only their window) when the header doesn't say. Others may carry a window in their header that
 * llama.cpp doesn't use: it runs Phi-3's with full attention (ggml-org/llama.cpp#13676), so all their layers count.
 */
const WINDOWED: Record<string, number> = { gemma3: 1 / 6, gemma3n: 1 / 5, gemma2: 1 / 2, "gpt-oss": 1 / 2, cohere2: 1 / 4, llama4: 1 / 4 };
/** Models without attention layers: a fixed state, nothing per token. */
const RECURRENT = /^(mamba2?|rwkv\d*|rwkv\d*_qwen\d*|arwkv\d*)$/;

const num = (v: GgufValue | undefined): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const each = (v: GgufValue | undefined, layers: number): number[] | null => {
  if (Array.isArray(v)) return v.length === layers ? v.map((x) => (Number.isFinite(x) && x > 0 ? x : 0)) : null;
  const n = num(v);
  return n === null ? null : Array.from({ length: layers }, () => n);
};

/**
 * The KV cache a model takes per token, from its metadata: 2 (keys and values) × each layer's KV heads × head size × 2
 * bytes. Layers that only see a sliding window (Gemma, gpt-oss) hold a few thousand tokens however long the context is,
 * so they aren't counted per token (their fixed part fits in the verdict's overhead), in the families llama.cpp windows
 * (a window in another family's header counts every layer: more memory, never less); DeepSeek-style models keep one
 * compressed vector per layer (MLA); recurrent layers keep none. Null when the header doesn't say enough.
 */
export function kvShape(meta: Map<string, GgufValue>): KvShape | null {
  const arch = meta.get("general.architecture");
  if (typeof arch !== "string" || !arch) return null;
  const key = (k: string) => meta.get(`${arch}.${k}`);
  const contextLength = num(key("context_length"));
  if (RECURRENT.test(arch)) return { bytesPerToken: 0, contextLength };
  const layers = num(key("block_count"));
  if (!layers || layers > 4096) return null;
  const lora = num(key("attention.kv_lora_rank"));
  if (lora) return { bytesPerToken: Math.round(layers * (lora + (num(key("rope.dimension_count")) ?? 0)) * 2), contextLength };
  const heads = each(key("attention.head_count"), layers);
  const kvHeads = each(key("attention.head_count_kv"), layers) ?? heads;
  if (!kvHeads) return null;
  const embedding = num(key("embedding_length"));
  const firstHeads = heads?.find((h) => h > 0) ?? null;
  const keyLength = num(key("attention.key_length")) ?? (embedding && firstHeads ? embedding / firstHeads : null);
  if (!keyLength) return null;
  const valueLength = num(key("attention.value_length")) ?? keyLength;
  let share = 1;
  const interval = num(key("full_attention_interval"));
  if (interval) share = 1 / interval;
  else if (WINDOWED[arch] && num(key("attention.sliding_window"))) {
    const pattern = key("attention.sliding_window_pattern");
    share = Array.isArray(pattern) && pattern.length ? pattern.filter((x) => !x).length / pattern.length : num(pattern) ? 1 / num(pattern)! : WINDOWED[arch];
  }
  const perLayer = kvHeads.reduce((n, h) => n + h, 0) / layers;
  return { bytesPerToken: Math.round(layers * share * perLayer * (keyLength + valueLength) * 2), contextLength };
}
