import { expect, test } from "bun:test";
import type { ImageEditorStatus } from "@crosstalk/shared";
import { imageEditorLine, memoryText } from "./imageEditor";

const status = (s: Partial<ImageEditorStatus>): ImageEditorStatus => ({ installed: true, state: "off", detail: null, failed: null, url: null, memoryMB: null, busy: false, ...s });

test("the line under the image editor's switch says what it's doing in a few words", () => {
  expect(imageEditorLine(status({}), "Mac mini")).toBe("Off. Uses no memory.");
  expect(imageEditorLine(status({ state: "starting" }), "Mac mini")).toBe("Starting on Mac mini…");
  expect(imageEditorLine(status({ state: "loading" }), "Mac mini")).toBe("Loading the model…");
  expect(imageEditorLine(status({ state: "ready", memoryMB: 2236 }), "Mac mini")).toBe("On · 2.2 GB of memory");
  expect(imageEditorLine(status({ state: "ready", memoryMB: 8704, busy: true }), "Mac mini")).toBe("On · editing · 8.5 GB of memory");
  expect(imageEditorLine(status({ state: "ready" }), "Mac mini")).toBe("On");
  expect(imageEditorLine(status({ state: "stopping" }), "Mac mini")).toBe("Turning off…");
  expect(imageEditorLine(status({ state: "error", failed: "start", detail: "It stopped." }), "Mac mini")).toBe("Stopped.");
  expect(imageEditorLine(status({ state: "error", failed: "stop", detail: "It didn't turn off." }), "Mac mini")).toBe("Didn't turn off.");
  expect(memoryText(310)).toBe("310 MB");
  expect(memoryText(0.4)).toBe("1 MB");
  expect(memoryText(1024)).toBe("1.0 GB");
});
