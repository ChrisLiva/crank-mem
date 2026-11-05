import { useEffect, useRef } from "react";

const POLL_MS = 10_000;

/**
 * Runs `load` when `deps` change, then every 10 s while the tab is visible. A hidden
 * tab fetches nothing; becoming visible again runs `load` at once and restarts the timer.
 */
export function usePoll(load: () => Promise<void>, deps: unknown[]): void {
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      latest.current().catch(() => {});
    };
    const start = () => {
      if (timer === null) timer = setInterval(run, POLL_MS);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        run();
        start();
      } else stop();
    };
    run();
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, deps);
}
