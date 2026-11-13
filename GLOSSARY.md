# crank-mem

Project memory for coding agents: crank-mem records what a project's files contain and what past agent sessions learned, and hands both to each new session.

## Language

### Projects

**Project memory**:
Everything crank-mem keeps for a project: its anatomy, its cerebrum and its store.
_Avoid_: Memory (unqualified), context, knowledge

**Project**:
A codebase that crank-mem is installed into.
_Avoid_: Target project, repo, workspace

**Checkout**:
One working copy of a project, such as a teammate's copy or a linked worktree.
_Avoid_: Clone, copy, worktree

**Linked project**:
Another installed project that this project's store names, so recall and citations reach it.
_Avoid_: Linked repo, related project

**Clone**:
The copy of the crank-mem repository made by `git clone` and run from its own directory, used for development.
_Avoid_: Install, source, checkout

**Installed copy**:
A release unpacked under `<crank home>/versions/`, run through the `current` link.
_Avoid_: Install dir, release dir

**Self-update**:
Replacing the installed copy with the latest release, or the one `--to` names, then repairing every registered project with the new version.
_Avoid_: Upgrade, update (unqualified)

### Agents and sessions

**Agent**:
A coding assistant that crank-mem serves: Claude Code or Codex.
_Avoid_: Assistant, model, LLM

**Session**:
One conversation between a user and an agent in a project.
_Avoid_: Thread, conversation, chat

**Subagent**:
An agent that a session starts to do part of its work in a separate context.
_Avoid_: Child agent, worker

**Transcript**:
The record an agent keeps of a session's messages and tool calls.
_Avoid_: Session log, history

**Hook**:
A crank-mem program that an agent runs at a fixed point in a session, such as its start or a file write.
_Avoid_: Plugin, callback

**Advisory-only**:
The rule that a hook never fails, blocks or interrupts a session, whatever goes wrong inside it.
_Avoid_: Best-effort, fail-safe

**Injection**:
Text that a hook adds to an agent's context.
_Avoid_: Prompt, nudge, context dump

**Pointer**:
A line in an injection that names the commands an agent can run to read the code or the store.
_Avoid_: Hint, instruction

**Hook channel**:
A route by which a hook's output leaves the hook; each agent shows its model some hook channels and not others.
_Avoid_: Channel (unqualified), output stream

**Model-visible**:
Said of hook output that reaches the agent's model, as opposed to output only the user sees.
_Avoid_: Visible, shown

**Probe**:
A live experiment against an agent that establishes how it behaves, recorded in an ADR.
_Avoid_: Spike, manual test

### Anatomy

**Anatomy**:
The per-file record of a project: each indexed file's description, token size, symbols with their line ranges and the repo files it imports.
_Avoid_: The index, anatomy index, file map

**Indexable file**:
A file that the anatomy may hold; binaries, lockfiles, tests and sensitive files are not.
_Avoid_: Tracked file, source file

**Sensitive file**:
A file that may hold secrets, which crank-mem never indexes and no setting can admit.
_Avoid_: Secret file, private file

**Scan**:
A full rebuild of the anatomy from the project's files.
_Avoid_: Reindex, crawl

**Refresh**:
A time-limited pass that brings the anatomy in line with the files changed since the last one.
_Avoid_: Rescan, sync, update

**Churn**:
How often recent commits changed a file.
_Avoid_: Activity, hotness

**Active file**:
A file the anatomy ranks first because an agent wrote it or its churn is high.
_Avoid_: Hot file, recent file

### Cerebrum

**Cerebrum**:
The short list of facts that every session on a project should start with.
_Avoid_: Semantic memory, notes, knowledge base

**Bullet**:
One fact in the cerebrum.
_Avoid_: Entry, item, line

**Preference**:
A bullet that records something the user asked for or corrected.
_Avoid_: Setting, rule

**Memory bullet**:
A bullet that is not a preference: a fact about the project that a session learned.
_Avoid_: Memory (unqualified), fact, note

**Excerpt**:
The part of the cerebrum that an injection carries when the whole does not fit.
_Avoid_: Summary, slice

**Citation**:
A file path or basename in backticks inside a bullet, which the excerpts, consolidation and `stats` check on disk; the anatomy only places a cited basename.
_Avoid_: Reference, file link

**Cerebrum archive**:
The record of bullets that consolidation removed or replaced, each with its reason.
_Avoid_: Trash, history

**Audit**:
A review the user starts that checks every bullet against recent sessions and the current code, then rewrites the cerebrum.
_Avoid_: Cleanup, review

### Capture

**Capture**:
The turning of sessions into observations in the store.
_Avoid_: Ingestion, recording, logging

**Live session**:
A session that is still running, which crank-mem digests at intervals rather than waiting for its end.
_Avoid_: Open session, mid-session, active session

**Digest**:
The result of reading one stretch of a session's transcript: a summary, observations, proposals and stale flags. To digest a session is to produce one.
_Avoid_: Summary, compaction

**Summary**:
The part of a digest that states what the user asked for, what the session investigated, learned and completed, and what it left open.
_Avoid_: Digest, recap

**Observation**:
One typed, titled record of something a session did or learned, with the files it read and modified.
_Avoid_: Memory, note, row, entry

**Store**:
A project's database of digests, observations and proposals.
_Avoid_: Memory (unqualified), memory database, DB

**Snapshot**:
A dated copy of the store that a restore can put back.
_Avoid_: Backup, dump

**Spool**:
The per-user queue of sessions that wait for a digest.
_Avoid_: Queue, inbox

**Spool entry**:
One session's place in the spool.
_Avoid_: Signal, job, task

**Parked entry**:
A spool entry set aside because no digest job can finish it; it returns when its session writes again.
_Avoid_: Failed entry, dead letter

**Digest job**:
One run that digests one spool entry.
_Avoid_: Task, worker

**Daemon**:
The per-user background process that runs digest jobs, one at a time across all projects.
_Avoid_: Service, server, worker

**Gateway**:
The one place where crank-mem asks a model for work, always through the user's own agent login.
_Avoid_: Client, API call

**Redaction**:
The removal of secrets from transcript text before a model or the store sees it.
_Avoid_: Scrubbing, masking

**Stopped**:
The per-user state in which no digest runs until the user resumes, entered when the gateway cannot use the user's login.
_Avoid_: Paused, off, disabled

### Curation

**Curation**:
The judging of what project memory says: proposals, stale flags, consolidation and audits.
_Avoid_: Upkeep, maintenance, cleanup

**Proposal**:
A bullet that a digest suggests for the cerebrum, pending until consolidation accepts or rejects it.
_Avoid_: Suggestion, candidate

**Stale flag**:
A mark on an observation that a later session showed it to be wrong or replaced, with the reason.
_Avoid_: Outdated, invalid, deleted

**Stale**:
Said only of an observation that carries a stale flag.
_Avoid_: Stale anatomy (say behind), stale hooks (say drift), stale hash (say outdated)

**Consolidation**:
The pass after a digest that checks pending proposals, stale flags and affected bullets against the code, then edits the cerebrum.
_Avoid_: Cleanup, compaction, merge

**Upkeep**:
The housekeeping of the store: taking snapshots and deleting observations that have stayed stale too long.
_Avoid_: Curation, maintenance, pruning

### Recall

**Recall**:
An agent's reading of the store through search, timeline and get.
_Avoid_: Retrieval, lookup, query

**Timeline**:
The observations that surround one observation in time.
_Avoid_: History, context

**File history**:
The observations stored about one file, shown to an agent when it reads that file.
_Avoid_: File notes, blame

**Surfaced**:
Said of an observation that crank-mem has shown to an agent.
_Avoid_: Hit, returned

**Usage channel**:
One of the routes by which project memory reaches an agent, which the usage log counts: an injection, file history, or a recall or code-reading command.
_Avoid_: Channel (unqualified), source

**Usage log**:
The always-on record of each time project memory reached an agent, one line per use of a usage channel.
_Avoid_: Analytics, telemetry

**Recall reach**:
The share of Claude sessions that ran at least one search, timeline or get.
_Avoid_: Recall rate, adoption

**Surfaced follow-through**:
The share of observations surfaced to a Claude session that the session later opened with get or timeline.
_Avoid_: Follow-through, open rate

### Install

**Wiring**:
The entries in an agent's settings that make it run crank-mem's hooks.
_Avoid_: Registration, hook config

**Vendored hooks**:
The copy of the running crank-mem's hooks, from a clone or an installed copy, that a project keeps, so that its hooks run without that crank-mem.
_Avoid_: Installed hooks, bundled hooks

**Drift**:
The state of a project whose vendored hooks lag the crank-mem that installed them, a clone or an installed copy.
_Avoid_: Stale hooks, version mismatch

**Backup**:
A copy of a file taken before crank-mem changes it, such as an agent's settings file or the cerebrum.
_Avoid_: Snapshot, copy

**Upgrade**:
Repairing one project's install, or every registered project's with `--all`.
_Avoid_: Update, migrate

**Git mode**:
The choice made at init of how git treats crank-mem's files in a project: commit, ignore or exclude.
_Avoid_: Tracking mode

**Registry**:
The per-user list of projects that the dashboard shows and that `crank-mem upgrade --all` repairs.
_Avoid_: Project list, index

**Dashboard**:
The read-only local web page that shows each registered project's observations, curation, health and usage.
_Avoid_: UI, console, admin
