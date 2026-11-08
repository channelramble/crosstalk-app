import { useEffect, useRef, useState } from "react";

// The browser's speech recognition (Safari and Chrome name it differently; Firefox has none).
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionCtor = new () => Recognition;

const Ctor: RecognitionCtor | undefined =
  typeof window === "undefined" ? undefined : ((window as unknown as Record<string, RecognitionCtor | undefined>).SpeechRecognition ?? (window as unknown as Record<string, RecognitionCtor | undefined>).webkitSpeechRecognition);

/** Speech to text for the message box. `onText` gets each finished phrase; nothing is shown where the browser can't do it. */
export function useDictation(onText: (said: string) => void, onError: (message: string) => void) {
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const handlers = useRef({ onText, onError });
  handlers.current = { onText, onError };

  useEffect(() => () => rec.current?.abort(), []);

  const stop = () => rec.current?.stop();
  const start = () => {
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const said = e.results[i].isFinal ? e.results[i][0].transcript.trim() : "";
        if (said) handlers.current.onText(said);
      }
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      handlers.current.onError(e.error === "not-allowed" || e.error === "service-not-allowed" ? "Dictation needs microphone permission for this site." : `Dictation stopped (${e.error}).`);
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
    };
    try {
      r.start();
      rec.current = r;
      setListening(true);
    } catch (e) {
      handlers.current.onError(e instanceof Error ? e.message : "Dictation couldn't start.");
    }
  };

  return { supported: !!Ctor, listening, start, stop, toggle: () => (rec.current ? stop() : start()) };
}
