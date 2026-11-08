import type { ServerEvent } from "@crosstalk/shared";

type Listener = (e: ServerEvent) => void;

/** In-process fan-out of hub events to WebSocket clients (and tests). */
export class Bus {
  private listeners = new Set<Listener>();

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ServerEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // a broken socket must not stop delivery to the others
      }
    }
  }
}
