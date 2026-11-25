import { expect, test } from "bun:test";
import { fitZoom, keysFor, screenHeading, screenSocketUrl, windowButtons, windowLabel, windowPlace, KEY } from "./screen";

test("the live view's address: the machine's own, as a WebSocket, without this device's sign-in in it", () => {
  expect(screenSocketUrl({ baseUrl: "", token: "a b" }, "https://mini.example.ts.net")).toBe("wss://mini.example.ts.net/api/screen/ws");
  expect(screenSocketUrl({ baseUrl: "http://127.0.0.1:7420", token: "t" }, "https://elsewhere")).toBe("ws://127.0.0.1:7420/api/screen/ws");
  // A machine on an older version takes it only there.
  expect(screenSocketUrl({ baseUrl: "", token: "a b" }, "https://mini.example.ts.net", true)).toBe("wss://mini.example.ts.net/api/screen/ws?token=a%20b");
});

test("a window fills the view's width, never past twice life size, never smaller than the whole screen", () => {
  expect(fitZoom(390, 1920)).toBeCloseTo(0.203, 3);
  // An 800-wide window in a 390-wide view: 0.4875 of life size, scrolled to its corner.
  expect(windowPlace({ x: 100, y: 50, width: 800 }, 390, 1920)).toEqual({ zoom: 0.4875, left: 48.75, top: 24.375 });
  // A tiny dialog isn't blown up past 2×.
  expect(windowPlace({ x: 700, y: 300, width: 120 }, 390, 1920).zoom).toBe(2);
  // One wider than the screen fits like the whole screen.
  expect(windowPlace({ x: 0, y: 0, width: 4000 }, 390, 1920).zoom).toBeCloseTo(fitZoom(390, 1920), 6);
});

test("window buttons: an agent's windows first, named by app and title", () => {
  const w = (id: number, app: string, agent: boolean, title = "") => ({ id, app, title, x: 0, y: 0, width: 100, height: 100, agent });
  expect(windowButtons([w(1, "Finder", false), w(2, "BrowserOS neo", true), w(3, "Terminal", false), w(4, "Simulator", true)]).map((x) => x.id)).toEqual([2, 4, 1, 3]);
  expect(windowLabel(w(1, "BrowserOS neo", true, "Amazon.com: a very long page title that goes on"))).toBe("BrowserOS neo: Amazon.com: a very long pag…");
  expect(windowLabel(w(1, "Terminal", false))).toBe("Terminal");
  expect(windowLabel(w(1, "Finder", false, "Finder"))).toBe("Finder");
});

test("the setup card's heading says what's in the way", () => {
  expect(screenHeading({ state: "off", hasPassword: false }, "Mac mini")).toBe("Turn on screen sharing on Mac mini");
  expect(screenHeading({ state: "auth", hasPassword: false }, "Mac mini")).toBe("Give Crosstalk Mac mini's screen sharing password");
  expect(screenHeading({ state: "auth", hasPassword: true }, "Mac mini")).toBe("That password didn't work");
  // A Mac's own Screen Sharing: signed in to as the Mac's account.
  expect(screenHeading({ state: "auth", hasPassword: false, account: "sam" }, "Mac mini")).toBe("Sign in to see Mac mini's screen");
  expect(screenHeading({ state: "problem", hasPassword: true }, "Mac mini")).toBe("The screen can't be reached");
});

test("typing: Shift for capitals and shifted symbols, Return for a new line, Unicode past Latin-1", () => {
  expect(keysFor("aB!\n")).toEqual([
    { sym: 0x61, shift: false },
    { sym: 0x42, shift: true },
    { sym: 0x21, shift: true },
    { sym: KEY.return, shift: false },
  ]);
  expect(keysFor("é€")).toEqual([
    { sym: 0xe9, shift: false },
    { sym: 0x010020ac, shift: false },
  ]);
});
