import { useEffect, useRef } from "react";

/** Calls `callback` every `ms` while the browser tab is visible, and when it becomes visible again. */
export function useVisibleInterval(callback: () => void, ms: number | null): void {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);
  useEffect(() => {
    if (ms === null) return;
    const tick = () => {
      if (document.visibilityState === "visible") saved.current();
    };
    const timer = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms]);
}
