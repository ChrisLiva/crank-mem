import { useEffect } from "react";

/** True when keystrokes belong to a text field rather than the list. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable;
}

/**
 * j and ArrowDown select the row after `selected`, k and ArrowUp the row before it,
 * clamped to `[0, count)`. With no row selected (`selected` is -1), either key selects row 0.
 */
export function useListKeys(count: number, selected: number, select: (i: number) => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (count === 0 || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      let step = 0;
      if (e.key === "j" || e.key === "ArrowDown") step = 1;
      else if (e.key === "k" || e.key === "ArrowUp") step = -1;
      if (step === 0) return;
      e.preventDefault();
      select(selected < 0 ? 0 : Math.min(count - 1, Math.max(0, selected + step)));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [count, selected, select]);
}
