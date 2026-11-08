import { expect, test } from "bun:test";
import { deskFor, dropEmptyDesk, waitingAttachments, UploadJobs } from "./jobs";

test("after a chat's desk is let go, nothing new can start and running uploads are cancelled", async () => {
  const q = new UploadJobs(() => {});
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const running = q.run("a", (_job, s) => { signal = s; return new Promise<string>((ok) => { release = () => ok("done"); }); })!;
  q.dispose();
  expect(signal?.aborted).toBe(true);
  release();
  await running.promise;
  expect(running.phase).not.toBe("done"); // a cancelled upload never reports success
  // A folder that finishes reading after the room changed tries to start its upload: it must not run.
  let started = false;
  expect(q.run("late", async () => { started = true; return "x"; })).toBeUndefined();
  expect(started).toBe(false);
  expect(q.alive).toBe(false);
});

test("restarting an upload (Retry) cancels the previous attempt", async () => {
  const q = new UploadJobs(() => {});
  let first: AbortSignal | undefined;
  q.run("a", (_j, s) => { first = s; return new Promise<string>(() => {}); });
  const second = q.run("a", async () => "ok")!;
  await second.promise;
  expect(first?.aborted).toBe(true);
  expect(second.phase).toBe("done");
  expect(q.get("a")).toBe(second);
});

// EXPECTED TO FAIL before the fix: the composer made its own UploadJobs per mount and disposed it on unmount, so a
// look at another chat dropped every attachment and cancelled every upload in flight, without a word — while the typed
// draft came back from localStorage. The attachments now wait on their chat's own desk, which outlives the box.
test("an attachment waiting to be sent, and its upload, outlive a look at another chat", async () => {
  const desk = deskFor("room-1");
  let signal: AbortSignal | undefined;
  desk.jobs.run("f1", (_job, s) => { signal = s; return new Promise<string>(() => {}); });
  desk.files = [{ id: "f1", file: new File(["keep me"], "notes.txt") }];
  expect(waitingAttachments()).toBe(1);

  // Off to another chat: the box unmounts, which lets go of a desk that holds nothing. This one holds a file.
  dropEmptyDesk("room-1");
  // Back again: the same desk, the same file, and the upload was never cancelled.
  expect(deskFor("room-1")).toBe(desk);
  expect(desk.files[0].file.name).toBe("notes.txt");
  expect(signal?.aborted).toBe(false);
  expect(desk.jobs.get("f1")?.phase).toBe("uploading");
  expect(waitingAttachments()).toBe(1);

  // Sent (or taken off): now there is nothing to keep, so the desk goes and its uploads with it.
  desk.files = [];
  dropEmptyDesk("room-1");
  expect(waitingAttachments()).toBe(0);
  expect(signal?.aborted).toBe(true);
  expect(desk.jobs.alive).toBe(false);
  expect(deskFor("room-1")).not.toBe(desk);
  dropEmptyDesk("room-1");
});

test("what a reload would lose counts every chat, not only the one on screen", () => {
  const here = deskFor("room-a");
  const there = deskFor("room-b");
  here.files = [{ id: "a1", file: new File(["a"], "a.txt") }];
  there.folders = [{ id: "b1", name: "src", files: [], bytes: 1, skipped: [], sent: 0 }];
  expect(waitingAttachments()).toBe(2);
  here.files = [];
  dropEmptyDesk("room-a");
  expect(waitingAttachments()).toBe(1);
  there.folders = [];
  dropEmptyDesk("room-b");
  expect(waitingAttachments()).toBe(0);
});
