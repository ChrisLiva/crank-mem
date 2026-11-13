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
export type EntryShare = Share & { summary: DigestSummary; links: string[] };

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

/** The entry-project row id `handle` names when the input showed that row (`#5`, or `<entry name>#5`), else null. */
function entryShownId(handle: string, root: string, shown: Map<string, Shown>): number | null {
  const h = parseHandle(handle);
  if (h === null || (h.project !== "" && h.project !== projectName(root))) return null;
  return shown.get("")!.ids.includes(h.id) ? h.id : null;
}

/**
 * The entry project's share (summary, every proposal, the stale flags on its shown rows, observations without an
 * owned file, and links to each other project an observation modifies) and one share per other owning project.
 */
export function route(
  output: Digest,
  entry: { projectRoot: string; cwd: string },
  shown: Map<string, Shown>,
  ownerOf: (p: string) => Owner,
): { entry: EntryShare; others: Share[] } {
  const root = entry.projectRoot;
  const names = new Map<string, string>();
  const nameOf = (r: string) => names.get(r) ?? names.set(r, projectName(r)).get(r)!;
  const copies = new Map<string, NewObservation[]>([[root, []]]);
  const links = new Set<string>();
  for (const o of output.observations) {
    const base = { type: o.type, title: o.title, narrative: o.narrative, facts: o.facts };
    const files = ownedFiles(o, entry.cwd, ownerOf);
    if (files.size === 0)
      copies.get(root)!.push({ ...base, filesRead: [], filesModified: [], refs: [] });
    for (const [owner, own] of files) {
      if (owner !== root && own.modified.size > 0) links.add(nameOf(owner));
      const copy = { ...base, filesRead: [...own.read], filesModified: [...own.modified] };
      copies.set(owner, [
        ...(copies.get(owner) ?? []),
        { ...copy, refs: refsBeside(files, owner, nameOf) },
      ]);
    }
  }
  return {
    entry: {
      root,
      observations: copies.get(root)!,
      proposals: output.proposals.map(({ kind, bullet }) => ({ kind, bullet })),
      stale: output.stale.flatMap((f) => {
        const id = entryShownId(f.id, root, shown);
        return id === null ? [] : [{ id, reason: f.reason }];
      }),
      summary: output.summary,
      links: [...links].sort(),
    },
    others: [...copies]
      .filter(([r]) => r !== root)
      .map(([r, observations]) => ({ root: r, observations, proposals: [], stale: [] })),
  };
}
