// Codex apply_patch text parser. Writes arrive as tool_name "apply_patch"
// with tool_input.command = raw patch text (ADR 0003):
//   *** Begin Patch
//   *** Add File: <path> | *** Update File: <path> | *** Delete File: <path>

export interface PatchOp {
  path: string;
  deleted: boolean;
}

/** Parse apply_patch text: Add/Update ⇒ reindex, Delete ⇒ drop. */
export function parseApplyPatch(patchText: string): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const line of patchText.split("\n")) {
    let m = line.match(/^\*\*\* (Add|Update) File: (.+)$/);
    if (m) {
      ops.push({ path: m[2]!.trim(), deleted: false });
      continue;
    }
    m = line.match(/^\*\*\* Delete File: (.+)$/);
    if (m) ops.push({ path: m[1]!.trim(), deleted: true });
  }
  return ops;
}
