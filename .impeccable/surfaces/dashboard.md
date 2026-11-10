---
version: 1
slug: "dashboard"
primary_target: "dashboard"
related_targets: []
---

# Dashboard surface brief

Scope: the whole `crank-mem dashboard` page (`dashboard/src/`). Mode: Operate.

Audience and job: a developer reading cold, beside a terminal, who checks first whether capture works in each project, then reviews curation, then judges cost and agent usage. Memory browsing supports those jobs. Read-only always.

Constraints: data from the `/api` routes only (typed health, `/activity` per-day upkeep, `/usage`, paged curation and observation lists); URL query keeps project, view, tab and item; j/k keyboard lists; light and dark follow the system.

## Direction contract

THESIS: The category standard played straight. The page is the developer-tool dashboard a user already knows: overview table first, then per-project views. It refuses the old one-layout-fits-all three-column mail-client arrangement.

OWN-WORLD: White ground (zinc-950 in dark), zinc text, hairline zinc borders, one blue accent (#2563eb) for links, selection and the primary data series. Green, amber, red and grey status only where they carry state. System UI sans with tabular figures, and mono for paths, ids, models and commands. 8px radius cards, small pills for state, quiet tables.

STORY: The visitor sees every project's capture health at once, spots the one that needs a look and the command that fixes it, then opens a project to read its health, curation decisions, cost and usage trends, and its observations.

FIRST VIEWPORT: Top bar: the crank-mem mark, a project switcher whose dot carries the project's status tone, and a host pill reading read-only; under it the views as tabs (Health, Curation, Usage, Memory). Health: a "Projects" heading with a count and the number needing attention, then one row per project (name and root, one status pill, spool, last digest, month cost, observations, 30-day digest sparkline) with the fact and copyable command that fix a stalled project under its row; below `lg` the rows become stacked cards. Below it, the focused project: a fix banner when one applies, six stat cards (digest, daemon, spool, observations, pending proposals, month cost), a 7/30/90-day window, per-day charts (digests, cost, consolidation decisions) and the last consolidation as borderless key/value rows.

FORM: canon (the category standard), chosen at the direction round; seed:8180458f0a61d492. Quality bar: Vercel dashboard, GitHub Actions and Insights.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- None at build start.
