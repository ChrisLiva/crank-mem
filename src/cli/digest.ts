import { saveConfig } from "../hooks/lib/config.ts";
import { ensureDaemon } from "../hooks/lib/spool.ts";
import { clearStopState } from "../hooks/lib/user-state.ts";
import { openNearestProject } from "./project.ts";
import { REPO_ROOT } from "./version.ts";

export async function run(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "resume") {
    clearStopState();
    ensureDaemon({ clone_root: REPO_ROOT });
    console.log("crank-mem: digests resumed.");
    return 0;
  }
  if (sub !== "on" && sub !== "off") {
    console.error("Usage: crank-mem digest on|off|resume");
    return 1;
  }
  const project = openNearestProject();
  if (!project) return 1;
  saveConfig(project.crankDir, { ...project.config, digest: sub === "on" });
  console.log(
    sub === "on"
      ? "crank-mem: digests on. They run on your Claude login through `claude -p`."
      : "crank-mem: digests off. Stored memory stays readable."
  );
  return 0;
}
