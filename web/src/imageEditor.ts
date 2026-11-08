import type { ImageEditorStatus } from "@crosstalk/shared";

// What Settings → Image editor says (views/ImageEditorSection.tsx).

/** 2.2 GB, or 310 MB under a GB. */
export const memoryText = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`);

/** The line under the switch: what it's doing, in a few words. */
export function imageEditorLine(s: ImageEditorStatus, machine: string): string {
  switch (s.state) {
    case "off":
      return "Off. Uses no memory.";
    case "starting":
      return `Starting on ${machine}…`;
    case "loading":
      return "Loading the model…";
    case "ready":
      return ["On", s.busy ? "editing" : null, s.memoryMB ? `${memoryText(s.memoryMB)} of memory` : null].filter(Boolean).join(" · ");
    case "stopping":
      return "Turning off…";
    case "error":
      return s.failed === "stop" ? "Didn't turn off." : "Stopped.";
  }
}
