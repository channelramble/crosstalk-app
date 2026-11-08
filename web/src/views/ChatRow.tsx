// A chat's row in the chat list, with its options: pin it to the top, unpin it, or move it among the pinned (pins.ts).
// The options open from the row's ⋯ button, a long press on a phone or a right click, in a tray under the row (a menu
// floating over the list could be cut off where it scrolls). Move up and Move down work everywhere, by touch, keyboard
// and screen reader; on a desktop, pinned rows can be dragged into place too.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Ellipsis, Pin, PinOff } from "lucide-react";
import { newPinOrder, pinnedFirst, PINNED_GROUP } from "../chatList";
import { leave } from "../motion";
import { movePin, pinFailed, setPin, type PinRow } from "../pins";
import { useTouchScreen } from "../ui";
import { revealInList } from "./ChatListMotion";
import { FoldableGroup, type GroupFold } from "./GroupFold";

export type { PinRow } from "../pins";

/** How long a finger rests on a row before its options open. */
const LONG_PRESS_MS = 500;
/** A finger that moves further than this is scrolling the list, not pressing. */
const PRESS_SLOP_PX = 8;
/** What a dragged pinned row carries (not text: dropped on the message box, it adds nothing). */
const DRAG_TYPE = "application/x-crosstalk-chat";

type Control = "more" | "up" | "down" | "pin";

/** A pinned row being dragged into place on a desktop (see usePinnedList). */
export interface RowDrag {
  dragging: boolean;
  /** Where the dragged row would land: just above or below this one. */
  drop: "above" | "below" | null;
  onDragStart(e: DragEvent): void;
  onDragOver(e: DragEvent): void;
  onDrop(e: DragEvent): void;
  onDragEnd(): void;
}

/** What a row's options show and do. */
export interface RowPins {
  open: boolean;
  /** A pin or a move is on its way (one at a time). */
  busy: boolean;
  pinned: boolean;
  /** Its place among the pinned, when it can move (several pinned, and no search: its neighbours would be misleading). */
  place: { index: number; count: number } | null;
  onOpen(open: boolean): void;
  onPin(): void;
  onUnpin(): void;
  onMove(to: number): void;
  drag: RowDrag | null;
}

const lowerHalf = (e: DragEvent) => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
};

/**
 * The chat list's pins: its rows split into the pinned ones (every machine's, in your order) and the rest, and what
 * each row's options do. One request at a time, and nothing moves until its machine has said so. `unfold` is told
 * where a chat went — Pinned, or the group it drops back into — so a folded one opens rather than swallowing the row.
 */
export function usePinnedList(chats: PinRow[], searching: boolean, unfold?: { pinned?: () => void; unpinned?: (c: PinRow) => void }) {
  const { pinned, rest } = useMemo(() => pinnedFirst(chats, (c) => c.room), [chats]);
  const touch = useTouchScreen();
  // Whose options are open, and whether it was pinned then: they close as its pin or unpin lands, in the same redraw
  // that moves the row (a move among the pinned keeps them open).
  const [open, setOpen] = useState<{ key: string; pinned: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  // The row being dragged (a ref: the next dragover can come before React has drawn this one), and where it would land.
  const dragged = useRef<string | null>(null);
  const [drag, setDrag] = useState<{ from: string; over: string | null; below: boolean } | null>(null);
  // Chats unpinned here stay in view in their agent's group (even past Show all), so you see where they went.
  const [unpinned, setUnpinned] = useState<ReadonlySet<string>>(() => new Set());
  // Where focus goes once a change is on screen: React may have moved the row, and focus with it is lost. At once, and
  // the row brought into view from where it now is in the list: a focus move's own scrolling would go by where its
  // glide draws it for the moment (ChatListMotion.ts), and leave it out of sight once it lands.
  const refocus = useRef<{ key: string; controls: Control[] } | null>(null);
  useLayoutEffect(() => {
    const want = refocus.current;
    if (!want || busy) return;
    refocus.current = null;
    const row = [...document.querySelectorAll<HTMLElement>("[data-pin-row]")].find((el) => el.dataset.pinRow === want.key);
    const el = want.controls.map((c) => row?.querySelector<HTMLElement>(`[data-pin-control="${c}"]`)).find(Boolean);
    if (!row || !el) return;
    el.focus({ preventScroll: true });
    revealInList(row);
  });

  const keyOf = (c: PinRow) => `${c.machine.key}/${c.room.id}`;
  const run = async (key: string, work: () => Promise<unknown>, after: { close?: boolean; focus: Control[] }) => {
    if (running.current) return;
    running.current = true;
    setBusy(key);
    try {
      await work();
      if (after.close) setOpen(null);
      refocus.current = { key, controls: after.focus };
    } catch (e) {
      pinFailed(e);
    } finally {
      running.current = false;
      setBusy(null);
    }
  };

  const dragFor = (key: string, index: number): RowDrag => ({
    dragging: drag?.from === key,
    drop: drag && drag.over === key && drag.from !== key ? (drag.below ? "below" : "above") : null,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(DRAG_TYPE, key);
      dragged.current = key;
      setOpen(null);
      setDrag({ from: key, over: null, below: false });
    },
    onDragOver: (e) => {
      const from = dragged.current;
      // Only a pinned row of this list lands here (not a file, say).
      if (!from) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const below = lowerHalf(e);
      if (drag?.over !== key || drag.below !== below) setDrag({ from, over: key, below });
    },
    onDrop: (e) => {
      e.preventDefault();
      const from = pinned.findIndex((p) => keyOf(p) === dragged.current);
      dragged.current = null;
      setDrag(null);
      if (from < 0 || from === index) return;
      // Just above or below this row, among the others.
      const to = (index > from ? index - 1 : index) + (lowerHalf(e) ? 1 : 0);
      if (to !== from) void run(keyOf(pinned[from]), () => movePin(pinned, from, to), { focus: [] });
    },
    onDragEnd: () => {
      dragged.current = null;
      setDrag(null);
    },
  });

  /** A row's options (it's one of `chats`). */
  const row = (c: PinRow): RowPins => {
    const key = keyOf(c);
    const index = pinned.indexOf(c);
    const place = index >= 0 && !searching && pinned.length > 1 ? { index, count: pinned.length } : null;
    return {
      open: open?.key === key && open.pinned === index >= 0,
      busy: busy !== null,
      pinned: index >= 0,
      place,
      onOpen: (v) => setOpen(v ? { key, pinned: index >= 0 } : null),
      // A new pin goes above every machine's pins.
      onPin: () =>
        void run(key, async () => {
          await setPin(c.machine, c.room.id, { pinned: true, order: newPinOrder(pinned.map((p) => p.room)) });
          // Pinned may be folded away, and the row has left its agent's group: it opens, so the row is there to see
          // and to put focus back on, instead of the chat and the focus both vanishing.
          unfold?.pinned?.();
        }, { close: true, focus: ["more"] }),
      onUnpin: () =>
        void run(key, async () => {
          await setPin(c.machine, c.room.id, { pinned: false });
          setUnpinned((s) => new Set(s).add(key));
          // The group it lands in may be folded away: it opens, so the row is there to see and to put focus back on.
          unfold?.unpinned?.(c);
        }, { close: true, focus: ["more"] }),
      // The tray stays open, on the same button when it's still there.
      onMove: (to) => void run(key, () => movePin(pinned, index, to), { focus: to < index ? ["up", "down", "more"] : ["down", "up", "more"] }),
      drag: place && !touch ? dragFor(key, index) : null,
    };
  };

  return { pinned, rest, row, kept: (c: PinRow) => unpinned.has(keyOf(c)) };
}

/** The list's first section: every machine's pinned chats. It folds away like any other group (GroupFold.tsx). */
export function PinnedSection({ children, ...fold }: GroupFold & { children: ReactNode }) {
  return (
    <FoldableGroup
      className="csb-pinned"
      group={PINNED_GROUP}
      label="Pinned"
      title="pinned"
      heading={
        <h2 className="csb-heading">
          <Pin size={13} aria-hidden="true" />
          Pinned
        </h2>
      }
      {...fold}
    >
      {children}
    </FoldableGroup>
  );
}

/** A chat's row (`children`: the button that opens it) with its ⋯ button and its options' tray. */
export function ChatRow({ id, name, pins, children }: { id: string; name: string; pins: RowPins; children: ReactNode }) {
  const tray = useId();
  const item = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  // A long press opened the options: the click it ends with isn't a tap on the chat.
  const pressed = useRef(false);
  const onOpen = useRef(pins.onOpen);
  onOpen.current = pins.onOpen;
  const { open, busy, pinned, place, drag } = pins;

  // The tray closes on a tap anywhere else, or Escape (back on the ⋯ button).
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!item.current?.contains(e.target as Node)) onOpen.current(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onOpen.current(false);
      more.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => endPress, []);

  const button = (control: Control, icon: ReactNode, label: string, act: () => void) => (
    // aria-disabled, not disabled: a disabled button would lose focus while its move is on its way.
    <button className="csb-tray-btn" data-pin-control={control} aria-disabled={busy || undefined} onClick={() => !busy && act()}>
      {icon}
      {label}
    </button>
  );

  return (
    <div
      ref={item}
      className={`csb-item ${open ? "open" : ""} ${drag?.dragging ? "dragging" : ""} ${drag?.drop ? `drop-${drag.drop}` : ""}`}
      data-pin-row={id}
      draggable={drag ? true : undefined}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
    >
      <div
        className="csb-row"
        onPointerDown={(e) => {
          pressed.current = false;
          if (e.pointerType !== "touch" || !e.isPrimary) return;
          endPress();
          const timer = setTimeout(() => {
            press.current = null;
            pressed.current = true;
            navigator.vibrate?.(10);
            onOpen.current(true);
          }, LONG_PRESS_MS);
          press.current = { x: e.clientX, y: e.clientY, timer };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > PRESS_SLOP_PX) endPress();
        }}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onClickCapture={(e) => {
          // A keyboard's click (no detail) is always meant.
          const swallow = pressed.current && e.detail > 0;
          pressed.current = false;
          if (!swallow) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        // A right click, and Android's long press (any click after it isn't a tap on the chat either).
        onContextMenu={(e) => {
          e.preventDefault();
          endPress();
          pressed.current = true;
          onOpen.current(true);
        }}
      >
        {children}
        <button ref={more} className="icon-btn csb-row-more" data-pin-control="more" aria-label={`Options for ${name}`} title="Options" aria-expanded={open} aria-controls={open ? tray : undefined} onClick={() => onOpen.current(!open)}>
          <Ellipsis size={16} />
        </button>
      </div>
      {open && (
        <RowTray id={tray} name={name}>
          {pinned ? (
            <>
              {place && (
                <span className="csb-row-place" aria-live="polite">
                  {place.index + 1} of {place.count}
                </span>
              )}
              {place && place.index > 0 && button("up", <ArrowUp size={15} aria-hidden="true" />, "Move up", () => pins.onMove(place.index - 1))}
              {place && place.index < place.count - 1 && button("down", <ArrowDown size={15} aria-hidden="true" />, "Move down", () => pins.onMove(place.index + 1))}
              {button("pin", <PinOff size={15} aria-hidden="true" />, "Unpin", pins.onUnpin)}
            </>
          ) : (
            button("pin", <Pin size={15} aria-hidden="true" />, "Pin to top", pins.onPin)
          )}
        </RowTray>
      )}
    </div>
  );
}

/**
 * A row's options, under it. They drop in (motion-lists.css); closed, they're gone at once and a copy fades where they
 * were, while the rows below glide up (ChatListMotion.ts). Never a copy of options no one saw: closed before they were
 * drawn, they simply go.
 */
function RowTray({ id, name, children }: { id: string; name: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    let drawn = false;
    const frame = requestAnimationFrame(() => (drawn = true));
    return () => {
      cancelAnimationFrame(frame);
      if (drawn) leave(el, "row");
    };
  }, []);
  return (
    <div ref={box} id={id} className="csb-row-tray" role="group" aria-label={`Options for ${name}`}>
      {children}
    </div>
  );
}
