// Tiny GGUF files for tests (the Local models verdict reads a model's shape from its header): the header as llama.cpp's
// tools write it (v3, little-endian), with the metadata a test gives, then filler instead of tensors.

type Entry = [key: string, value: number | string | boolean | string[] | number[] | bigint, type?: "u32" | "u64" | "f32" | "i32" | "u8" | "bool"];

const enc = new TextEncoder();

/** A GGUF v3 header with these keys (numbers are u32 unless a type is given; arrays of strings are kept as a vocabulary would be), then `padding` bytes. */
export function ggufBytes(entries: Entry[], padding = 0): Uint8Array {
  const parts: Uint8Array[] = [];
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const u64 = (n: number | bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return b;
  };
  const str = (s: string) => {
    const bytes = enc.encode(s);
    return [u64(bytes.length), bytes];
  };
  const scalar = (v: number | boolean | bigint, type: Entry[2]): [number, Uint8Array] => {
    const b = new Uint8Array(8);
    const view = new DataView(b.buffer);
    if (typeof v === "boolean" || type === "bool") return [7, new Uint8Array([v ? 1 : 0])];
    if (type === "u64" || typeof v === "bigint") return [10, u64(v as number)];
    if (type === "f32") {
      view.setFloat32(0, Number(v), true);
      return [6, b.subarray(0, 4)];
    }
    if (type === "i32") {
      view.setInt32(0, Number(v), true);
      return [5, b.subarray(0, 4)];
    }
    if (type === "u8") return [0, new Uint8Array([Number(v)])];
    return [4, u32(Number(v))];
  };
  parts.push(enc.encode("GGUF"), u32(3), u64(0), u64(entries.length));
  for (const [key, value, type] of entries) {
    parts.push(...str(key));
    if (typeof value === "string") {
      parts.push(u32(8), ...str(value));
    } else if (Array.isArray(value)) {
      if (value.length && typeof value[0] === "string") {
        parts.push(u32(9), u32(8), u64(value.length));
        for (const s of value as string[]) parts.push(...str(s));
      } else {
        const of = type === "bool" ? 7 : type === "i32" ? 5 : 4;
        parts.push(u32(9), u32(of), u64(value.length));
        for (const n of value as number[]) parts.push(of === 7 ? new Uint8Array([n ? 1 : 0]) : of === 5 ? scalar(n, "i32")[1] : u32(n));
      }
    } else {
      const [t, bytes] = scalar(value, type);
      parts.push(u32(t), bytes);
    }
  }
  parts.push(new Uint8Array(padding));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A Qwen3-8B-like header: 36 layers, 8 KV heads of 128 (144 KiB a token at f16), trained for 40,960 tokens, a vocabulary after the shape. */
export function qwenLike(padding = 0): Uint8Array {
  return ggufBytes(
    [
      ["general.architecture", "qwen3"],
      ["general.name", "Qwen3 8B"],
      ["qwen3.context_length", 40960],
      ["qwen3.embedding_length", 4096],
      ["qwen3.block_count", 36],
      ["qwen3.attention.head_count", 32],
      ["qwen3.attention.head_count_kv", 8],
      ["qwen3.attention.key_length", 128],
      ["qwen3.attention.value_length", 128],
      ["tokenizer.ggml.model", "gpt2"],
      ["tokenizer.ggml.tokens", Array.from({ length: 2000 }, (_, i) => `token${i}`)],
    ],
    padding,
  );
}
