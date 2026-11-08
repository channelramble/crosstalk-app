import { useEffect, useRef } from "react";
import { useStore } from "./store";

/**
 * Runs `fn` each time the machine on screen comes back: its connection opens again after it was down (the hub
 * restarted, the phone woke up). A card that couldn't load then loads again by itself.
 */
export function useReconnected(fn: () => void) {
  const status = useStore((s) => s.status);
  const was = useRef(status);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (status === "open" && was.current !== "open") latest.current();
    was.current = status;
  }, [status]);
}
