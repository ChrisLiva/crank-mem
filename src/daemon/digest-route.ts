import * as path from "node:path";
import { ownedPath } from "../hooks/lib/hook-io.ts";
import {
  parseHandle,
  type DigestInput,
  type DigestSummary,
  type NewObservation,
} from "../hooks/lib/memory.ts";
import { projectName, type Owner } from "../hooks/lib/owner.ts";
import type { Digest, Shown } from "./digest-prompt.ts";

// Split one digest across the stores that own its files: each owning project gets a copy of an observation
// with its own paths, and the other owners' paths as refs.

export type Share = {
  root: string;
  observations: NewObservation[];
  proposals: DigestInput["proposals"];
  stale: DigestInput["stale"];
};
/** An observation no entry-owned file cites: its copy for the entry store, kept when no `owners` store holds it. */
type Fallback = { owners: string[]; observation: NewObservation };
export type EntryShare = Share & { summary: DigestSummary; links: string[]; fallbacks: Fallback[] };

type Files = { read: Set<string>; modified: Set<string> };

/** Each owning root's files among the observation's paths, roots in first-cited order, each list deduped. */
function ownedFiles(
  o: Digest["observations"][number],
  cwd: string,
  ownerOf: (p: string) => Owner,
): Map<string, Files> {
  const byRoot = new Map<string, Files>();
  const add = (paths: string[], kind: keyof Files) => {
    for (const p of paths) {
      const owned = ownedPath(ownerOf(path.resolve(cwd, p)));
      if (owned === null) continue;
      let files = byRoot.get(owned.root);
      if (files === undefined)
        byRoot.set(owned.root, (files = { read: new Set(), modified: new Set() }));
      files[kind].add(owned.rel);
    }
  };
  add(o.files_read, "read");
  add(o.files_modified, "modified");
  return byRoot;
}

/** Every other owner's files of one observation, as refs by project name. */
function refsBeside(
  files: Map<string, Files>,
  owner: string,
  nameOf: (root: string) => string,
): NewObservation["refs"] {
  return [...files]
    .filter(([other]) => other !== owner)
    .flatMap(([other, f]) => [
      ...[...f.read].map((p) => ({ project: nameOf(other), path: p, kind: "read" as const })),
      ...[...f.modified].map((p) => ({
        project: nameOf(other),
        path: p,
        kind: "modified" as const,
      })),
    ]);
}

/** The store and row id a stale `handle` names when the input showed that row; the entry's own name counts as `#`. */
function shownRow(
  handle: string,
  root: string,
  shown: Map<string, Shown>,
): { root: string; id: number } | null {
  const h = parseHandle(handle);
  if (h === null) return null;
  const s = shown.get(h.project === projectName(root) ? "" : h.project);
  return s?.ids.includes(h.id) ? { root: s.root, id: h.id } : null;
}

/**
 * Each owning root's observation copies, the entry's first, the names of the other projects an observation
 * modifies, and a fallback for each observation that only other projects' files cite.
 */
function copiesByOwner(
  output: Digest,
  entry: { projectRoot: string; cwd: string },
  ownerOf: (p: string) => Owner,
  nameOf: (root: string) => string,
): { copies: Map<string, NewObservation[]>; links: Set<string>; fallbacks: Fallback[] } {
  const root = entry.projectRoot;
  const copies = new Map<string, NewObservation[]>([[root, []]]);
  const links = new Set<string>();
  const fallbacks: Fallback[] = [];
  for (const o of output.observations) {
    const base = { type: o.type, title: o.title, narrative: o.narrative, facts: o.facts };
    const files = ownedFiles(o, entry.cwd, ownerOf);
    const unowned = { ...base, filesRead: [], filesModified: [] };
    if (files.size === 0) copies.get(root)!.push({ ...unowned, refs: [] });
    else if (!files.has(root))
      fallbacks.push({
        owners: [...files.keys()],
        observation: { ...unowned, refs: refsBeside(files, root, nameOf) },
      });
    for (const [owner, own] of files) {
      if (owner !== root && own.modified.size > 0) links.add(nameOf(owner));
      const copy = { ...base, filesRead: [...own.read], filesModified: [...own.modified] };
      copies.set(owner, [
        ...(copies.get(owner) ?? []),
        { ...copy, refs: refsBeside(files, owner, nameOf) },
      ]);
    }
  }
  return { copies, links, fallbacks };
}

/**
 * The entry project's share (summary, its observations, including those without an owned file, its proposals and
 * stale flags, links to each other project an observation modifies, and fallbacks for the observations only other
 * projects' files cite) and one share per other project that gets
 * an observation copy, a proposal or a stale flag, by project name. A proposal goes to the listed project its
 * `project` names, else to the entry; a stale flag goes to the store whose shown row its handle names.
 */
export function route(
  output: Digest,
  entry: { projectRoot: string; cwd: string },
  shown: Map<string, Shown>,
  ownerOf: (p: string) => Owner,
): { entry: EntryShare; others: Share[] } {
  const root = entry.projectRoot;
  const names = new Map<string, string>();
  const nameOf = (r: string) => {
    let name = names.get(r);
    if (name === undefined) names.set(r, (name = projectName(r)));
    return name;
  };
  const { copies, links, fallbacks } = copiesByOwner(output, entry, ownerOf, nameOf);
  const shares = new Map<string, Share>();
  const shareOf = (r: string) => {
    let share = shares.get(r);
    if (share === undefined)
      shares.set(r, (share = { root: r, observations: [], proposals: [], stale: [] }));
    return share;
  };
  for (const [r, observations] of copies) shareOf(r).observations = observations;
  for (const { kind, bullet, project } of output.proposals)
    shareOf(shown.get(project)?.root ?? root).proposals.push({ kind, bullet });
  for (const f of output.stale) {
    const row = shownRow(f.id, root, shown);
    if (row !== null) shareOf(row.root).stale.push({ id: row.id, reason: f.reason });
  }
  return {
    entry: { ...shareOf(root), summary: output.summary, links: [...links].sort(), fallbacks },
    others: [...shares.values()]
      .filter((s) => s.root !== root)
      .sort((a, b) => (nameOf(a.root) < nameOf(b.root) ? -1 : 1)),
  };
}
