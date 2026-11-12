# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who run Claude Code or Codex on their own projects and have installed crank-mem from its public repository. They read the dashboard cold: they did not build crank-mem and know its internals only through the README and the command output.

They open the dashboard to answer three questions, in this order:

1. **Trust check (Health).** Is capture working for this project: digests on, the daemon alive, nothing parked in the spool or stopped on a credential?
2. **Review curation (Curation).** What did consolidation accept, reject, flag stale or archive, and why?
3. **Cost and usage (Usage).** What do digests cost this month at list price, and do agents actually use recall (`search`, `timeline`, `get`) and code reading (`outline`, `unfold`)?

Browsing stored observations (Memory) supports these jobs; users did not name it as a reason to open the dashboard.

## Product Purpose

crank-mem is project memory for coding agents. It records what a project's files contain (the anatomy) and what past agent sessions learned (the store and `cerebrum.md`), and hands both to each new session. Agents stay unaware of memory upkeep (ADR 0010): digests turn finished and live Claude Code sessions into observations, and consolidation checks what sessions proposed against the code before it edits `cerebrum.md`.

Because that upkeep happens out of sight, the dashboard (`crank-mem dashboard`) exists so a developer can see it: confirm memory capture is healthy, audit what consolidation decided and why, and judge whether memory pays for its cost. Success is a developer who trusts their projects' memory because they can check it, not because they are told to.

## Positioning

- Memory keeps itself: no agent writes `cerebrum.md`, and no hook asks an agent to keep memory. Digests read transcripts, and consolidation verifies each proposal and stale flag against the code with read-only tools before it accepts it (ADR 0011).
- Local and on the user's own account: the store lives in the project as `.crank/memory.db`, embeddings run on the local model in `~/.crank/models`, digests run the unmodified `claude` binary on the user's own login (ADR 0008), and the dashboard serves only on `127.0.0.1`.
- Every curation outcome carries its reason: rejections, stale flags and archived bullets each record why.

## Operating Context

- The developer runs `crank-mem dashboard` in a terminal. It prints a `http://127.0.0.1:<port>/?token=<token>` URL and opens it in the browser; the token trades for a session cookie. The server runs in the foreground until Ctrl-C.
- One dashboard covers every project in `~/.crank/projects.json`, which `init`, `upgrade` and the session-start hook add to and `uninstall` removes from.
- The page sits beside a terminal and an agent session on a desktop browser. It polls for fresh data, and the URL query holds the project, view, tab and selected item, so a reload reopens the same place.
- Next to the dashboard, `crank-mem stats` prints the same memory and capture health as text.

## Capabilities and Constraints

- **Read-only, always.** The dashboard never changes project memory. The server opens each store read-only; consolidation alone keeps `cerebrum.md`. This is a settled product decision, not a phase.
- Four views, as tabs in job order: Health (every project's capture status in one table, with the command that fixes a stalled project, then the selected project's figures and per-day charts), Curation, Usage and Memory. A project switcher in the top bar picks the project the views show. Lists move with j/k and the arrow keys.
- Local only: the server answers only `127.0.0.1` and `localhost` Host headers on its port, requires the token or session cookie, and serves the static build from `dashboard/dist/`.
- Built by `crank-mem setup` (and rebuilt by `upgrade`) with Vite, React, Tailwind and Radix; the package has no dev server, and the CLI refuses to serve a build whose `.crank-version` stamp is missing or not the running crank-mem's version.
- The wire shapes the page reads live in `src/hooks/lib/wire.ts`.
- Codex sessions are not digested; only Claude Code sessions reach the store. Digest costs are list-price figures, not billed amounts.
- Sensitive files are never indexed and secrets are redacted before storage; the dashboard must not show what crank-mem keeps out of the index.
- Terminology: `GLOSSARY.md` is the project's canonical vocabulary, with words to avoid. UI copy uses its terms (project, checkout, observation, digest, consolidation, proposal, stale flag, cerebrum, store).

## Brand Commitments

- The name is `crank-mem`, lowercase, the same as the command.
- The dashboard looks like the developer tools it sits beside, at the craft level of Vercel's dashboard and GitHub Actions and Insights: a neutral ground, one blue accent, status colour only where it carries meaning, tables and small charts. It does not develop a distinct visual identity.
- Voice, as in the README, the glossary and the dashboard's own copy: plain, active, concrete. Empty states state the fact and, when one exists, the command that changes it ("No projects yet: run crank-mem init in a project.").

## Evidence on Hand

- `README.md`, `GLOSSARY.md` and the probe-verified ADRs in `docs/adr/`.
- Real data in each registered project's `.crank/memory.db`, `cerebrum.md`, `cerebrum-archive.md` and `usage.jsonl`.
- No testimonials, user counts, benchmarks or published cost studies exist. Future work must not invent them.

## Product Principles

1. **Show the evidence and the reason.** Trust comes from inspection: every number and outcome links back to the observation, bullet or run behind it, with the reason consolidation recorded.
2. **A window, not a control panel.** The dashboard reports what memory upkeep did; it never offers to edit, accept or reject.
3. **Health answers first.** A developer reading cold should tell within seconds whether capture works for a project and, when it does not, which command fixes it.
4. **Local and private by construction.** Nothing leaves the machine, and nothing the index excludes appears on the page.
5. **One vocabulary.** The page, the CLI output and the README use the glossary's words for the same things.
