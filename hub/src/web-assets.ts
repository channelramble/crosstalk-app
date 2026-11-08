import { ASSETS } from "./web-assets.gen";

/** Web app files embedded into the compiled hub binary (empty in development; served from disk instead). */
export function embeddedAsset(path: string): Blob | null {
  const p = ASSETS[path];
  return p ? Bun.file(p) : null;
}
