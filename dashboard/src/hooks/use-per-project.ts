import { useState } from "react";
import type { Project } from "@/api";
import { usePoll } from "./use-poll";

/** `load` for every project, polled together; a project whose answer fails keeps its last one. */
export function usePerProject<T>(
  projects: Project[],
  load: (id: string) => Promise<T>,
): Record<string, T | undefined> {
  const [loaded, setLoaded] = useState<Record<string, T>>({});
  usePoll(async () => {
    const answers = await Promise.allSettled(
      projects.map(async (p) => [p.id, await load(p.id)] as const),
    );
    setLoaded((prev) => {
      const next = { ...prev };
      for (const a of answers) if (a.status === "fulfilled") next[a.value[0]] = a.value[1];
      return next;
    });
  }, [projects.map((p) => p.id).join()]);
  return loaded;
}
