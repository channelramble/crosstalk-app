import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { CornerDownLeft, FolderUp, Loader2, Mic, Plus, ShieldAlert, Square, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { MESSAGE_MAX, PROVIDER_INFO, isServiceOnlyAgent, messageTooLongWords, type AskChoice, type Member, type Message, type Room, type Upload } from "@crosstalk/shared";
import { api, uploadFile } from "../api";
import { hubStore, machineOfRoom, pendingApprovals, useStore, type RoomData } from "../store";
import { withSent } from "../sent";
import { STOP_FAILED, stopChat, useStopping } from "../stop";
import { Dialog, MemberAvatar, useAutosize, useIsMobile, useTouchScreen, useMedia } from "../ui";
import { ApprovalCard } from "./ApprovalCard";
import { Arrive, WorkingPanel } from "./WorkingPanel";
import { droppedItems, formatBytes, pickedFolderFiles, toFolders, uuid, type FolderFile, type PendingFile, type PendingFolder } from "../folders";
import { makeZip } from "../zip";
import { deskFor, dropEmptyDesk, waitingAttachments, type AttachmentDesk, type Job } from "../jobs";
import { recipientPreview } from "../teamwork";
import { ChatControls } from "./ChatControls";
import { useDictation } from "../dictation";
import { caretPlan, withMention, withQuote, type CaretWish } from "../caret";
import { afterAsked, askButtonLabel, askButtonName, askProblem, copiedUntil, hasMention, insertQuote, mentionedChoices, sendPlan, withoutMention, withoutMentions, type SendAction, type SendPlan } from "../asks";
import { postAsks } from "../askApi";
import { AskChips, AskMentionPop, useAskCompose, useQuoteInsert, type AskNotice } from "./AskCompose";
import { answersLine, sendLabel, sendName, whoAnswers } from "../groupChat";
import { Users } from "lucide-react";
import { FlipGroup, leave, useEntrance } from "../motion";

const DRAFT_KEY = (id: string) => `crosstalk.draft.${id}`;

/** Where an attachment's background upload has got to, in words (it starts as soon as the file is attached). */
function jobLabel(j: Job | undefined): string {
  if (!j) return "";
  switch (j.phase) {
    case "packing": return `Packing ${j.done.toLocaleString()} of ${j.total.toLocaleString()} files`;
    case "uploading": return `Uploading ${j.total ? Math.floor((j.done / j.total) * 100) : 0}% of ${formatBytes(j.total)}`;
    case "unpacking": return "Unpacking on the hub…";
    case "done": return "Ready";
    case "error": return j.error ?? "Upload failed";
  }
}

/**
 * `stoppable`: Stop shows (a chat whose agent is working, even while its history reloads or couldn't load); by default
 * when `busy`. `onSent`: your message is in the chat (the chat scrolls to it).
 */
export function Composer({ room, members, busy, working, queued, onRoomSettings, stoppable = busy, onSent }: { room: Room; members: Member[]; busy: boolean; working: Member[]; queued: Member[]; onRoomSettings: () => void; stoppable?: boolean; onSent?: () => void }) {
  const mobile = useIsMobile();
  // On a touch screen (even unfolded or turned sideways) Enter adds a line: there's a send button, and a half-written
  // message mustn't go to the agent because the screen got wider.
  const touch = useTouchScreen();
  const narrow = useMedia("(max-width: 760px)");
  const enterAddsLine = narrow || touch;
  const approvals = useStore(useShallow((s) => pendingApprovals(s, room.id)));
  const [reviewing, setReviewing] = useState(false);
  const toast = useStore((s) => s.toast);
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_KEY(room.id)) ?? "";
    } catch {
      return "";
    }
  });
  const [sending, setSending] = useState(false);
  // This chat's waiting attachments live on its own desk, so leaving the chat and coming back finds them still here
  // (and still uploading). The box only mirrors them for drawing.
  const deskRef = useRef<AttachmentDesk | null>(null);
  if (!deskRef.current?.jobs.alive) deskRef.current = deskFor(room.id);
  const desk = deskRef.current;
  const jobs = desk.jobs;
  const [files, setFiles] = useState<PendingFile[]>(desk.files);
  const pending = useRef<PendingFile[]>(desk.files);
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const zipPicker = useRef<HTMLInputElement>(null);
  const [folderMenu, setFolderMenu] = useState(false);
  const [folders, setFolders] = useState<PendingFolder[]>(desk.folders);
  const pendingFolders = useRef<PendingFolder[]>(desk.folders);
  const updateFolders = (items: PendingFolder[]) => { pendingFolders.current = items; if (deskRef.current) deskRef.current.folders = items; setFolders(items); };
  // Uploads run in the background from the moment something is attached; Send only waits for what's left.
  const [, setTick] = useState(0);
  const lastPaint = useRef(0);
  const repaint = (force = false) => {
    const now = Date.now();
    if (force || now - lastPaint.current > 150) { lastPaint.current = now; setTick((n) => n + 1); }
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    // React dev mode mounts twice, and the first unmount may have let an empty desk go: take the live one, and draw
    // from it (the state above was read off the one this render had).
    if (!deskRef.current?.jobs.alive) deskRef.current = deskFor(room.id);
    const d = deskRef.current;
    d.notify = repaint;
    pending.current = d.files;
    pendingFolders.current = d.folders;
    if (d.files !== files) setFiles(d.files);
    if (d.folders !== folders) setFolders(d.folders);
    return () => {
      mounted.current = false;
      // Nothing is cancelled here: an upload outlives a look at another chat. Only an empty desk is let go.
      if (d.notify === repaint) d.notify = null;
      dropEmptyDesk(room.id);
      useStore.setState({ pendingAttachments: waitingAttachments() });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const runJob = (id: string, work: (job: Job, signal: AbortSignal) => Promise<string>) => deskRef.current?.jobs.run(id, work);
  // The hub this chat lives on, read when an upload starts: one that outlives a look at another machine still goes to
  // the right place.
  const roomHub = () => {
    const key = machineOfRoom(room.id);
    return (key !== null ? hubStore(key)?.getState().conn : null) ?? useStore.getState().conn;
  };
  const startFile = (item: PendingFile) =>
    runJob(item.id, async (job, signal) => {
      job.total = item.file.size;
      const u = await uploadFile<Upload>(`/api/rooms/${room.id}/uploads?name=${encodeURIComponent(item.file.name)}`, item.file, {
        signal,
        onProgress: (loaded) => { job.done = loaded; repaint(); },
      }, roomHub());
      item.upload = u;
      return u.filename;
    });
  const startFolder = (folder: PendingFolder) =>
    runJob(folder.id, async (job, signal) => {
      let body: Blob = folder.zip ?? new Blob();
      if (!folder.zip) {
        // Pack the folder into one archive: a single upload can't half-finish, and every name survives as is.
        job.phase = "packing";
        job.total = folder.files.length;
        body = await makeZip(folder.files, (done) => { if (signal.aborted) throw new Error("cancelled"); job.done = done; repaint(); });
      }
      job.phase = "uploading";
      job.done = 0;
      job.total = body.size;
      repaint(true);
      const saved = await uploadFile<{ folder: string; files: number }>(`/api/rooms/${room.id}/uploads?unzip=1&name=${encodeURIComponent((folder.zip?.name ?? folder.name + ".zip"))}`, body, {
        signal,
        onProgress: (loaded) => { job.done = loaded; repaint(); },
        onSent: () => { job.phase = "unpacking"; repaint(true); },
      }, roomHub());
      if (!folder.zip && saved.files !== folder.files.length) throw new Error(`The hub received ${saved.files} of ${folder.files.length} files. Retry.`);
      folder.token = saved.folder;
      return saved.folder;
    });
  const removeJob = (id: string) => deskRef.current?.jobs.remove(id);
  // Tell the update banner how many unsent attachments a reload would lose — in every chat, not only this one.
  useEffect(() => {
    useStore.setState({ pendingAttachments: waitingAttachments() });
  }, [files.length, folders.length]);
  const addZip = (zip: File | undefined) => {
    if (!zip || sending) return;
    if (!/\.zip$/i.test(zip.name)) { toast("error", "Choose a .zip file."); return; }
    const folder: PendingFolder = { id: uuid(), name: zip.name.replace(/\.zip$/i, ""), files: [], bytes: zip.size, skipped: [], zip, sent: 0 };
    updateFolders([...pendingFolders.current, folder]);
    startFolder(folder);
  };
  const addFolderFiles = (list: FolderFile[], truncated?: ReadonlySet<string>) => {
    if (sending || !list.length) return;
    // Some phone browsers ignore folder picking and hand back loose files without paths.
    if (list.every((f) => !f.rel.includes("/"))) { toast("error", "This browser can't pick folders. Attach a .zip of the folder instead."); setFolderMenu(true); return; }
    const { folders: added, errors } = toFolders(list, truncated);
    for (const e of errors) toast("error", e);
    if (!added.length) return;
    updateFolders([...pendingFolders.current, ...added]);
    for (const f of added) startFolder(f);
  };
  const [dragging, setDragging] = useState(false);
  const [sendStatus, setSendStatus] = useState("");
  const updateFiles = (items: PendingFile[]) => { pending.current = items; if (deskRef.current) deskRef.current.files = items; setFiles(items); };
  const addFiles = (selected: File[]) => {
    if (sending) return;
    const next = [...pending.current];
    const added: PendingFile[] = [];
    for (const file of selected) {
      const item = { id: uuid(), file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined };
      next.push(item);
      added.push(item);
    }
    updateFiles(next);
    for (const item of added) startFile(item);
  };
  const removeFile = (id: string) => {
    const item = pending.current.find((f) => f.id === id);
    // Its picture goes a moment later: the copy that fades where it was (motion.ts FlipGroup) still shows it.
    const preview = item?.preview;
    if (preview) setTimeout(() => URL.revokeObjectURL(preview), 1000);
    removeJob(id);
    updateFiles(pending.current.filter((f) => f.id !== id));
  };
  const [pop, setPop] = useState<{ query: string; start: number; index: number } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const textNow = useRef(text);
  textNow.current = text;
  const dictation = useDictation((said) => {
    const cur = textNow.current;
    const next = cur + (cur && !/\s$/.test(cur) ? " " : "") + said;
    setText(next);
    saveDraft(next);
  }, (msg) => toast("error", msg));
  useAutosize(ta, text);

  // A pick fills the box in (an @name, a quoted answer) and wants the caret after what it inserted. It's put there in
  // the layout pass that draws that text, so nothing typed afterwards can be stepped on: a frame later is too late
  // (caret.ts). The wish is used once, by the render that applies its text, then dropped.
  const caretWish = useRef<CaretWish | null>(null);
  useLayoutEffect(() => {
    const wish = caretWish.current;
    if (!wish) return;
    caretWish.current = null;
    const el = ta.current;
    if (!el) return;
    const plan = caretPlan(wish, el, document.activeElement);
    if (!plan) return;
    if (plan.focus) el.focus();
    el.setSelectionRange(plan.pos, plan.pos);
  });

  const saveDraft = (v: string) => {
    try {
      if (v) localStorage.setItem(DRAFT_KEY(room.id), v);
      else localStorage.removeItem(DRAFT_KEY(room.id));
    } catch {
      // ignore
    }
  };

  // "Send to the chat" on an answer card puts the quoted answer here, after what's written, with the caret under it.
  useQuoteInsert(room.id, (quote) => {
    const next = insertQuote(textNow.current, quote);
    textNow.current = next;
    caretWish.current = withQuote(next, document.activeElement);
    setText(next);
    saveDraft(next);
  });

  // A chat has one agent: nobody to @mention in the room's sense; its @ asks other agents instead (Ask others). In a group
  // chat @name means that agent answers (as in the rooms before them); Ask others is in a message's actions there.
  const group = !!room.chat?.group;
  const chat = !!room.chat && !group;
  // A chat Crosstalk's own agent or OpenCode runs is its service's (NanoGPT's, Refuseless's), so it's that name you message, not the agent's.
  const accounts = useStore((s) => s.accounts);
  const serviceName = chat && isServiceOnlyAgent(members[0]?.provider) ? Object.values(accounts).find((a) => a.provider === members[0].provider && a.id === (members[0].config as { account?: string } | undefined)?.account)?.label : undefined;
  const agentName = chat && members[0] ? (serviceName ?? PROVIDER_INFO[members[0].provider].name) : null;
  const candidates = useMemo(() => {
    if (!pop || chat) return [];
    const q = pop.query.toLowerCase();
    const list = members.filter((m) => m.handle.startsWith(q) || PROVIDER_INFO[m.provider].name.toLowerCase().includes(q));
    const all = "all".startsWith(q) && members.length > 1 ? [{ id: "__all", handle: "all" } as unknown as Member] : [];
    return [...list, ...all].slice(0, 8);
  }, [pop, members, chat]);
  const ask = useAskCompose(room.id, chat, members[0], text, pop?.query ?? null);
  // What Enter or Tab can pick in the @ popup (in a chat, the agents that can be asked).
  const popHandles = chat ? ask.rows.filter((c) => c.available).map((c) => c.handle) : candidates.map((m) => m.handle);
  // The highlighted row, kept inside the list: the list can get shorter while the popup is open (an agent leaves the
  // chat, a machine stops answering), and Enter must pick a row that is still there.
  const popIndex = pop ? Math.min(pop.index, Math.max(0, popHandles.length - 1)) : 0;
  // The popup is a listbox the message box points into, as a combobox does: a screen reader hears that it opened, and
  // which name Enter picks as the arrow keys move.
  const popId = useId();
  const popOpen = !!pop && (chat ? ask.rows.length > 0 : candidates.length > 0);
  const popActive = popOpen && popHandles.length > 0 ? `${popId}-${popIndex}` : undefined;

  // What Send does with this draft (`sendPlan`): one that names other agents asks only them, so the chat's own agent
  // never gets it. Worked out again from the latest messages and attachments when Send has waited for the list.
  const chatData = useStore((s) => s.roomData[room.id]);
  const planFacts = useRef({ messages: null as Message[] | null, copiedBefore: 0 });
  planFacts.current = { messages: chat && chatData?.loaded ? chatData.messages : null, copiedBefore: chatData?.loaded ? copiedUntil(chatData.messages, room.createdAt, chatData.hasMore) : 0 };
  const makePlan = (draft: string, chips: AskChoice[], choices: "ready" | "loading" | "failed"): SendPlan =>
    sendPlan({ text: draft, chips, typed: hasMention(draft), choices, messages: planFacts.current.messages, attachments: pending.current.length + pendingFolders.current.length, copiedBefore: planFacts.current.copiedBefore });
  const plan: SendPlan = chat ? makePlan(text, ask.chips, ask.state) : { kind: "chat" };
  // Asking was refused (the hub's words, with the way out); the draft stays. A new notice per blocked tap.
  const [askFailure, setAskFailure] = useState<ReturnType<typeof askProblem> | null>(null);
  const [nudge, setNudge] = useState(0);
  const setView = useStore((s) => s.setView);
  useEffect(() => setAskFailure(null), [text]);

  const onChange = (v: string) => {
    setText(v);
    saveDraft(v);
    const el = ta.current;
    const caret = el?.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const m = (chat ? /(^|\s)@([\w.-]*)$/ : /(^|\s)@([\w-]*)$/).exec(before);
    if (m) setPop({ query: m[2], start: caret - m[2].length - 1, index: 0 });
    else setPop(null);
    if (chat && v.includes("@")) ask.load();
  };

  const insertMention = (handle: string) => {
    if (!pop) return;
    const caret = ta.current?.selectionStart ?? text.length;
    const wish = withMention(text, pop.start, caret, handle, document.activeElement);
    setPop(null);
    if (!wish) return; // the caret left the half-typed name: the pick is stale (caret.ts)
    caretWish.current = wish;
    setText(wish.text);
    saveDraft(wish.text);
  };

  const sendingNow = useRef(false);
  /** The draft names others: nothing goes to the chat. They're asked about the newest message; the draft goes once they're accepted. */
  const askOthers = async (todo: Extract<SendPlan, { kind: "ask" }>, draft: string) => {
    sendingNow.current = true;
    setSending(true);
    setSendStatus("Asking…");
    setAskFailure(null);
    try {
      await postAsks({ roomId: room.id, messageId: todo.messageId, targets: todo.targets, note: todo.note });
      onSent?.();
      dictation.stop();
      // The draft is gone once they're asked (what was typed or dictated meanwhile, after it, stays).
      const rest = afterAsked(textNow.current, draft);
      if (rest !== textNow.current) {
        setText(rest);
        textNow.current = rest;
        saveDraft(rest);
      }
    } catch (e) {
      setAskFailure(askProblem(e));
    } finally {
      sendingNow.current = false;
      setSending(false);
      setSendStatus("");
      if (!enterAddsLine) ta.current?.focus();
    }
  };
  // A draft longer than one message holds goes as a file instead, with one tap: attached here (it starts uploading at
  // once), and the box is free for a line about it. Only while this box is on screen: a notice tapped after leaving the
  // chat leaves its draft as it was.
  const draftToFile = () => {
    const draft = textNow.current;
    if (!mounted.current || sendingNow.current || !draft.trim()) return;
    addFiles([new File([draft], "message.txt", { type: "text/plain" })]);
    setText("");
    textNow.current = "";
    saveDraft("");
    ta.current?.focus();
  };
  const tooLong = text.trim().length > MESSAGE_MAX;
  /** `asIs`: the person chose to send a draft that names others to the chat anyway: the only way it reaches the chat's agent. */
  const send = async ({ asIs = false }: { asIs?: boolean } = {}) => {
    const t = text.trim();
    if ((!t && !files.length && !folders.length) || sendingNow.current || !members.length) return;
    // More than one message holds: nothing is sent and every word stays in the box; the notice says how long a message
    // can be, with the way out (the hub would refuse it in the same words, after the whole draft had gone up to it).
    if (t.length > MESSAGE_MAX) return toast("error", messageTooLongWords(t.length), { action: { label: "Attach as a file", run: draftToFile } });
    let todo: SendPlan = asIs ? { kind: "chat" } : plan;
    if (todo.kind === "wait") {
      // Names someone before the list of who can be asked is here: wait for it (the draft stays), then decide again.
      const draft = text;
      sendingNow.current = true;
      setSending(true);
      setSendStatus("Checking who you can ask…");
      let list: AskChoice[] | null = null;
      try {
        list = await ask.check();
      } finally {
        sendingNow.current = false;
        setSending(false);
        setSendStatus("");
      }
      if (textNow.current !== draft) return;
      todo = makePlan(draft, list ? mentionedChoices(draft, list) : [], list ? "ready" : "failed");
    }
    if (todo.kind === "blocked") return setNudge((n) => n + 1);
    if (todo.kind === "ask") return askOthers(todo, text);
    sendingNow.current = true;
    setSending(true);
    // Clear the box right away (and put the text back if sending fails). Waiting until the hub answered, with the box
    // disabled meanwhile, let Safari put the sent text back when it committed autocorrect or predictive text.
    const draft = text;
    setText("");
    textNow.current = "";
    // Keep the saved draft until delivery succeeds, including when navigating away mid-upload.
    setPop(null);
    let sent = false;
    try {
      const items = [...pending.current.map((f) => f.id), ...pendingFolders.current.map((f) => f.id)];
      const failed = items.filter((id) => jobs.get(id)?.phase === "error");
      if (failed.length) throw new Error("An attachment didn't upload. Retry it or remove it, then send.");
      if (items.some((id) => jobs.get(id)?.phase !== "done")) {
        setSendStatus("Finishing uploads…");
        await Promise.all(items.map((id) => jobs.get(id)?.promise));
        if (items.some((id) => jobs.get(id)?.phase !== "done")) throw new Error("An attachment didn't upload. Retry it or remove it, then send.");
      }
      setSendStatus("Sending…");
      const attachments = [...pending.current.map((f) => f.upload!.filename), ...pendingFolders.current.map((f) => `folder:${f.token}`)];
      const saved = await api<Message | undefined>("POST", `/api/rooms/${room.id}/messages`, { text: t, ...(attachments.length ? { attachments } : {}) });
      sent = true;
      // In the chat at once, as the hub saved it: its live event may be late, or lost on a connection that only looks
      // open (just after unlocking the phone).
      if (saved?.id && saved.roomId === room.id) {
        // Into the chat's own machine store: the app's view mirrors it, so a later update there can't drop the message.
        const key = machineOfRoom(room.id);
        const machine = key !== null ? hubStore(key) : undefined;
        const add = (roomData: Record<string, RoomData>): { roomData: Record<string, RoomData> } | Record<string, never> => {
          const rd = roomData[room.id];
          if (!rd) return {};
          const messages = withSent(rd.messages, saved);
          return messages === rd.messages ? {} : { roomData: { ...roomData, [room.id]: { ...rd, messages } } };
        };
        if (machine) machine.setState((st) => add(st.roomData));
        else useStore.setState((st) => add(st.roomData));
      }
      onSent?.();
      if (!textNow.current.trim() || textNow.current === draft) saveDraft("");
      dictation.stop();
      for (const item of pending.current) if (item.preview) URL.revokeObjectURL(item.preview);
      jobs.clear();
      updateFiles([]);
      updateFolders([]);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
      // Nothing was sent: give the text back, unless something new was typed meanwhile.
      if (!textNow.current.trim()) {
        setText(draft);
        saveDraft(draft);
      }
    } finally {
      sendingNow.current = false;
      setSending(false);
      setSendStatus("");
      if (!enterAddsLine) ta.current?.focus();
      if (sent) {
        // If the browser re-inserted exactly what was just sent (a late autocorrect commit), clear it again.
        const recheck = () => {
          if (textNow.current.trim() === t) {
            setText("");
            saveDraft("");
          }
        };
        requestAnimationFrame(recheck);
        setTimeout(recheck, 300);
      }
    }
  };

  // Stop: "Stopping…" at once, until the hub has stopped the agent (it can take a few seconds). In a chat with a message
  // of yours waiting behind the reply, it asks first whether to answer that message or stop everything.
  const stopping = useStopping((s) => !!s.rooms[room.id]);
  // In a group chat, the next agent's turn for the same message (everyone in turn, @all) isn't a message of yours waiting.
  const waitingTurn = useStore((s) => {
    const turns = Object.values(s.roomData[room.id]?.turns ?? {});
    const answering = new Set(turns.filter((t) => t.status === "running").map((t) => t.triggerMessageId));
    return turns.some((t) => t.status === "queued" && !(room.chat?.group && answering.has(t.triggerMessageId)));
  });
  // A message handed to the reply that it hasn't read yet (Send now, or by itself while helpers work) is the same question.
  const unreadByReply = useStore((s) => Object.values(s.roomData[room.id]?.turns ?? {}).some((t) => t.status === "running" && !!t.unread?.length));
  // No reply running: a message held for the agent's helpers. Stop has no reply to stop then, and leaves the helpers working.
  const replyRuns = useStore((s) => Object.values(s.roomData[room.id]?.turns ?? {}).some((t) => t.status === "running"));
  const [askStop, setAskStop] = useState(false);
  const stopNow = async (keepWaiting = false) => {
    setAskStop(false);
    if (!(await stopChat(room.id, { keepWaiting }))) toast("error", STOP_FAILED);
  };
  // (Hubs before "Stop and answer my message" say nothing about what the agent read, and stop everything.)
  const stop = () => ((chat || group) && (waitingTurn || unreadByReply) && members[0]?.readSeq !== undefined ? setAskStop(true) : void stopNow());

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pop && popHandles.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPop({ ...pop, index: (popIndex + 1) % popHandles.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPop({ ...pop, index: (popIndex - 1 + popHandles.length) % popHandles.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(popHandles[popIndex]);
        return;
      }
      if (e.key === "Escape") {
        setPop(null);
        return;
      }
    }
    // Ctrl or ⌘ with Enter sends on every device (a tablet with a keyboard, say).
    if (e.key === "Enter" && !e.shiftKey && (!enterAddsLine || e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  // What stands in the way, above the box: why Send won't do it with a way out, or that who can be asked couldn't be looked up.
  const takeOff = () => {
    const next = withoutMentions(text, ask.chips);
    setText(next);
    saveDraft(next);
    ta.current?.focus();
  };
  const action = (a: SendAction): AskNotice["actions"][number] =>
    a === "retry" ? { label: ask.hint?.busy ? "Checking…" : "Try again", run: ask.retry, busy: !!ask.hint?.busy } : a === "take-off" ? { label: "Take off @names", run: takeOff, busy: sending } : { label: "Send to the chat as it is", run: () => void send({ asIs: true }), busy: sending };
  const notice: AskNotice | null =
    plan.kind === "blocked"
      ? { text: plan.actions.includes("retry") && ask.hint ? `${plan.reason} ${ask.hint.why}` : plan.reason, actions: plan.actions.map(action) }
      : askFailure
        ? { text: askFailure.text, actions: [{ label: "Try again", run: () => void send(), busy: sending }, ...(askFailure.fix ? [{ label: askFailure.fix === "limit" ? "Raise limit" : "Open settings", run: () => setView("settings") }] : [])] }
        : ask.hint
          ? { text: `Couldn't check who you can ask. ${ask.hint.why}`, actions: [action("retry")] }
          : null;
  // A group chat's draft that says who answers: the button says so too ("Send to @codex"), the chip row in full.
  const answering = group ? whoAnswers(room, members, text) : null;
  const askLabel = chat ? askButtonLabel(ask.chips, agentName) : answering ? sendLabel(answering) : null;
  // The accessible name and tooltip say it in full (the machine too); the button's own words are short.
  const askName = chat ? askButtonName(ask.chips, agentName) : answering && askLabel ? sendName(answering) : null;

  const target = recipientPreview(room, members, text);
  // Send has something to send.
  const ready = !((!text.trim() && !files.length && !folders.length) || sending || !members.length);

  return (
    <div className={`composer-wrap ${dragging ? "file-drag" : ""}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        // Reading a dropped folder takes a while; if the composer closed or the room changed meanwhile, drop the result.
        const q = jobs;
        void droppedItems(e.dataTransfer)
          .then(({ files: dropped, folderFiles, truncated }) => {
            if (!mounted.current || !q.alive || q !== deskRef.current?.jobs) return;
            addFiles(dropped);
            addFolderFiles(folderFiles, truncated);
          })
          .catch(() => toast("error", "Couldn't read the dropped folder."));
      }}
    >
      <div className="composer-work"><WorkingPanel key={room.id} room={room} members={members} /></div>
      {approvals.length > 0 && (
        <Arrive>
          {(entering) => (
            <div className={`composer-approvals${entering ? " m-drop" : ""}`}>
              <button className="btn approval-review" onClick={() => setReviewing(true)}>
                <ShieldAlert size={18} /> {approvals.every((a) => a.kind === "question") ? `Answer question${approvals.length > 1 ? `s (${approvals.length})` : ""}` : `Review approval (${approvals.length})`}
              </button>
            </div>
          )}
        </Arrive>
      )}
      {askStop && (
        <Dialog title={`Stop ${agentName ?? (group ? "the agents" : "the agent")}?`} icon={<Square size={14} fill="currentColor" />} onClose={() => setAskStop(false)} footer={<button className="btn" onClick={() => setAskStop(false)}>Cancel</button>}>
          <p className="small" style={{ marginTop: 0 }}>{waitingTurn ? (replyRuns ? "Your message is waiting for this reply to finish." : "Your message is waiting for the helpers to finish.") : `${agentName ?? "The agent"} hasn't read your message yet.`}</p>
          <div className="choice-cards">
            <button type="button" className="choice-card" onClick={() => void stopNow(true)}>
              <span className="choice-card-title">Stop and answer my message</span>
              <span className="choice-card-help">{!replyRuns ? (group ? "Who your message is for answers it now. Helpers keep working." : `${agentName ?? "The agent"} answers what you sent now. Its helpers keep working.`) : group ? "The reply stops, then who your message is for answers it." : `${agentName ?? "The agent"} stops this reply, then answers what you sent.`}</span>
            </button>
            <button type="button" className="choice-card" onClick={() => void stopNow(false)}>
              <span className="choice-card-title">Stop everything</span>
              <span className="choice-card-help">Your message stays in the chat, not answered.{replyRuns ? "" : " Helpers keep working."} Tap Answer now on it when you want a reply.</span>
            </button>
          </div>
        </Dialog>
      )}
      {reviewing && (
        <Dialog title={`Approvals · ${room.name}`} onClose={() => setReviewing(false)} footer={<button className="btn" onClick={() => setReviewing(false)}>Done</button>}>
          {approvals.length ? approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} member={members.find((m) => m.id === a.memberId)} />
          )) : <p role="status">All caught up. Nothing is waiting for your approval.</p>}
        </Dialog>
      )}
      {/* Always there (empty, it's nothing): an attachment fades in, and one taken off leaves a copy that fades while the
          others close up (motion.ts FlipGroup). Not when they all go at once, as they do when the message is sent. */}
      <FlipGroup className={files.length ? "composer-files" : undefined} aria-label={files.length ? "Attachments" : undefined} order={files.map((f) => f.id).join("\n")} exit={files.length ? "row" : undefined}>
        {files.map((item) => <AttachmentChip key={item.id} id={item.id}>
          {item.preview && <img src={item.preview} alt="" />}
          <span className="composer-file-text">
            <span title={item.file.name}>{item.file.name}</span>
            <JobStatus job={jobs.get(item.id)} onRetry={() => startFile(item)} />
          </span>
          <button className="icon-btn" aria-label={`Remove ${item.file.name}`} disabled={sending} onClick={() => removeFile(item.id)}><X size={16} /></button>
        </AttachmentChip>)}
      </FlipGroup>
      {folderMenu && (
        <Dialog title="Attach" onClose={() => setFolderMenu(false)}>
          <div className="choice-cards">
            <button type="button" className="choice-card" onClick={() => { setFolderMenu(false); picker.current?.click(); }}>
              <span className="choice-card-title">Files or photos</span>
              <span className="choice-card-help">As many as you like, any size.</span>
            </button>
            <button type="button" className="choice-card" onClick={() => { setFolderMenu(false); folderPicker.current?.click(); }}>
              <span className="choice-card-title">A folder</span>
              <span className="choice-card-help">Every file in it, any size. Works in desktop and most Android browsers.</span>
            </button>
            <button type="button" className="choice-card" onClick={() => { setFolderMenu(false); zipPicker.current?.click(); }}>
              <span className="choice-card-title">A zipped folder</span>
              <span className="choice-card-help">Works everywhere. On iPhone: in the Files app, long-press the folder, tap Compress, then pick the .zip here.</span>
            </button>
          </div>
        </Dialog>
      )}
      <FlipGroup className={folders.length ? "composer-files" : undefined} aria-label={folders.length ? "Attached folders" : undefined} order={folders.map((f) => f.id).join("\n")} exit={folders.length ? "row" : undefined}>
        {folders.map((f) => <AttachmentChip key={f.id} id={f.id}>
          <FolderUp size={16} aria-hidden="true" />
          <span className="composer-file-text">
            <span title={f.skipped.length ? `Not included: ${f.skipped.join(", ")} (agents can reinstall or re-clone these)` : f.name}>
              {f.name}/ · {f.zip ? `zipped, ${formatBytes(f.bytes)}` : `${f.files.length.toLocaleString()} file${f.files.length === 1 ? "" : "s"}, ${formatBytes(f.bytes)}`}
              {f.skipped.length > 0 && <span className="muted"> · without {f.skipped.join(", ")}</span>}
            </span>
            <JobStatus job={jobs.get(f.id)} onRetry={() => startFolder(f)} />
          </span>
          <button className="icon-btn" aria-label={`Remove folder ${f.name}`} disabled={sending} onClick={() => { removeJob(f.id); updateFolders(pendingFolders.current.filter((x) => x.id !== f.id)); }}><X size={16} /></button>
        </AttachmentChip>)}
      </FlipGroup>
      {sending && <div className="composer-hint" role="status">{sendStatus || "Sending…"}</div>}
      {dragging && <div className="composer-hint" role="status">Drop files or folders to attach them</div>}
      {tooLong && (
        <div className="composer-hint" role="status">
          <span>Too long for one message: {MESSAGE_MAX.toLocaleString("en-US")} characters at most.</span>
          <button className="btn small ghost" onClick={draftToFile} disabled={sending}>Attach as a file</button>
        </div>
      )}
      {chat && <AskChips chips={ask.chips} ownName={agentName} notice={notice} noticeKey={nudge} onRemove={(c) => { const next = withoutMention(text, c, ask.usable); setText(next); saveDraft(next); ta.current?.focus(); }} />}
      {answering && (
        // Who answers what you're writing, and in what order: the chat's own choice, or who the draft @mentions.
        <p className={`group-answers ${answering.how === "named" || answering.how === "all" ? "named" : ""}`} role="status" aria-live="polite">
          <Users size={14} aria-hidden="true" />
          <span>{answersLine(answering)}</span>
        </p>
      )}
      <div className={`composer${askLabel ? " asking" : ""}`}>
        <input ref={picker} type="file" multiple hidden onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} aria-label="Choose attachments" />
        {/* One + for everything: it opens a choice of files, a folder, or a zipped folder (what iPhones can send). */}
        <button className="composer-icon attach-button" onClick={() => setFolderMenu(true)} disabled={sending} aria-label="Attach files or a folder" title="Attach files or a folder"><Plus size={20} /></button>
        <input ref={folderPicker} type="file" hidden {...{ webkitdirectory: "", directory: "" }} onChange={(e) => { addFolderFiles(pickedFolderFiles(e.target.files)); e.target.value = ""; }} aria-label="Choose a folder" />
        <input ref={zipPicker} type="file" hidden accept=".zip,application/zip" onChange={(e) => { addZip(e.target.files?.[0]); e.target.value = ""; }} aria-label="Choose a zipped folder" />
        {pop && chat && ask.rows.length > 0 && <AskMentionPop id={popId} rows={ask.rows} index={popIndex} onPick={insertMention} />}
        {pop && candidates.length > 0 && (
          <div className="mention-pop" role="listbox" id={popId} aria-label="Agents">
            {candidates.map((m, i) => (
              <button key={m.id} id={`${popId}-${i}`} className={i === popIndex ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => insertMention(m.handle)} role="option" aria-selected={i === popIndex}>
                {m.id === "__all" ? <div className="avatar sm" style={{ ["--c" as string]: "#8e8e93" }}>All</div> : <MemberAvatar member={m} size="sm" />}
                <span style={{ fontWeight: 600 }}>@{m.handle}</span>
                <span className="muted small">{m.id === "__all" ? "every agent" : PROVIDER_INFO[m.provider].name}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={dictation.listening ? "Listening…" : agentName ? `Message ${agentName}` : group ? (members.length ? "Message the group" : "Add an agent to start") : members.length ? `Message ${room.name}${mobile ? "" : " — @ to mention an agent"}` : "Add an agent to start"}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          onPaste={(e) => { const pasted = Array.from(e.clipboardData.files); if (pasted.length) { if (!e.clipboardData.getData("text/plain")) e.preventDefault(); addFiles(pasted); } }}
          onBlur={() => setTimeout(() => setPop(null), 150)}
          aria-label="Message"
          aria-autocomplete="list"
          aria-expanded={popOpen}
          aria-controls={popOpen ? popId : undefined}
          aria-activedescendant={popActive}
          enterKeyHint={enterAddsLine ? "enter" : "send"}
        />
        {stoppable && (
          stopping ? (
            <SwapButton className="send stop stopping" disabled aria-label="Stopping…" title="Stopping…">
              <Loader2 size={15} className="spin" />
            </SwapButton>
          ) : (
            <SwapButton className="send stop" onClick={stop} aria-label={chat ? "Stop" : "Stop all agents"} title={chat ? "Stop" : "Stop all agents"}>
              <Square size={12} fill="currentColor" />
            </SwapButton>
          )
        )}
        {(!stoppable || text.trim() || files.length > 0 || folders.length > 0) && (
          <SwapButton className={`send${askLabel ? " ask" : ""}`} onClick={() => void send()} disabled={!ready} aria-label={askName ?? "Send"} title={askName ?? "Send"}>
            {/* A new face when it gets something to send: it pops in (motion-chat.css), and only then. */}
            <SendFace key={ready ? "ready" : "idle"} ready={ready} label={askLabel} />
          </SwapButton>
        )}
        {dictation.supported && (
          <button className={`composer-icon mic ${dictation.listening ? "on" : ""}`} onClick={dictation.toggle} disabled={sending} aria-pressed={dictation.listening} aria-label={dictation.listening ? "Stop dictation" : "Dictate"} title={dictation.listening ? "Stop dictation" : "Dictate"}>
            <Mic size={18} />
          </button>
        )}
      </div>
      {chat && members[0] && <ChatControls room={room} member={members[0]} />}
      {group && members.length > 0 && <ChatControls room={room} member={members[0]} members={members} />}
      {!chat && !group && <div className="composer-hint composer-recipient">
        <span>{target ? `Goes to ${target}` : "Add an agent to send messages"}</span>
        {members.length > 0 && <span className="muted">Type @ to choose an agent</span>}
      </div>}
      {!chat && !group && members.length > 1 && room.mode === "direct" && (
        <div className="composer-hint" aria-label="Automatic hand-offs">
          <span>Automatic hand-offs are off.</span>
          <button className="btn small ghost" onClick={onRoomSettings}>Change teamwork</button>
        </div>
      )}
      {!chat && !group && <div className="composer-hint">
        {working.length > 0 ? (
          <span>
            {working.map((m) => `@${m.handle}`).join(", ")} {working.length > 1 ? "are" : "is"} {working.some((m) => m.status === "approval") ? "waiting for approval" : "working"}
            {queued.length ? ` · next: ${queued.map((m) => `@${m.handle}`).join(", ")}` : ""}
          </span>
        ) : queued.length > 0 ? (
          <span>Waiting for a turn: {queued.map((m) => `@${m.handle}`).join(", ")}</span>
        ) : null}
        {busy && text.trim() && (
          <button className="btn small ghost danger" onClick={stop}>
            Stop agents
          </button>
        )}
      </div>}
    </div>
  );
}

/**
 * Send and Stop, which take each other's place in the message box: the one that appears fades in as its icon pops, and
 * the one that goes is gone at once while a copy of it fades where it was (motion.ts `leave`, motion-chat.css).
 */
function SwapButton({ className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const button = useRef<HTMLButtonElement>(null);
  const entering = useEntrance();
  useLayoutEffect(() => () => leave(button.current, "menu"), []);
  return <button ref={button} className={`${className}${entering ? " m-swap" : ""}`} {...rest} />;
}

/**
 * An attachment waiting in the message box. One added while the chat is up fades in (motion-chat.css `.m-fresh`), at its
 * full size, so its Remove is a finger's size from its first frame; FlipGroup moves the others when one goes.
 */
function AttachmentChip({ id, children }: { id: string; children: ReactNode }) {
  const fresh = useEntrance() ? " m-fresh" : "";
  return (
    <div className={`composer-file${fresh}`} data-flip={id}>
      {children}
    </div>
  );
}

/** What Send shows: its arrow, or who it asks. Drawn anew when Send gets something to send, and then it pops in. */
function SendFace({ ready, label }: { ready: boolean; label: string | null }) {
  const pop = useEntrance() && ready ? "m-ready" : undefined;
  return label ? <span className={`ask-label${pop ? ` ${pop}` : ""}`}>{label}</span> : <CornerDownLeft size={17} strokeWidth={2.25} className={pop} />;
}

/** One attachment's upload progress: a status line, a bar while it's moving, and Retry if it failed. */
function JobStatus({ job, onRetry }: { job: Job | undefined; onRetry: () => void }) {
  if (!job) return null;
  const pct = job.phase === "done" || job.phase === "unpacking" ? 100 : job.total ? Math.min(100, (job.done / job.total) * 100) : 0;
  return (
    <span className={`upload-status ${job.phase}`} role="status">
      <span className="upload-status-line">
        <span>{jobLabel(job)}</span>
        {job.phase === "error" && <button className="btn small ghost" onClick={onRetry}>Retry</button>}
      </span>
      {job.phase !== "done" && job.phase !== "error" && (
        <span className="upload-bar" aria-hidden="true">
          <span className={job.phase === "unpacking" ? "indeterminate" : ""} style={{ ["--fill" as string]: pct / 100 }} />
        </span>
      )}
    </span>
  );
}
