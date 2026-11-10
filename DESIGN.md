---
name: crank-mem dashboard
description: A read-only window on project memory upkeep, built to the developer-tool dashboard standard.
colors:
  background: "#fafafa"
  foreground: "#18181b"
  card: "#ffffff"
  muted: "#f4f4f5"
  muted-foreground: "#63636b"
  accent: "#f4f4f5"
  border: "#e4e4e7"
  input: "#d4d4d8"
  ring: "#2563eb"
  link: "#1d4ed8"
  selected: "#eff6ff"
  destructive: "#b91c1c"
  ok: "#15803d"
  ok-soft: "#f0fdf4"
  ok-line: "#bbf7d0"
  warn: "#a16207"
  warn-soft: "#fefce8"
  warn-line: "#fde68a"
  bad: "#b91c1c"
  bad-soft: "#fef2f2"
  bad-line: "#fecaca"
  off: "#52525b"
  off-soft: "#f4f4f5"
  off-line: "#e4e4e7"
  series-1: "#2a78d6"
  series-2: "#eb6834"
  series-3: "#1baf7a"
  grid: "#ececef"
  axis: "#d4d4d8"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.025em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.375
  figure:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
    fontFeature: "tnum"
  section:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
  axis:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    fontFeature: "tnum"
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  hairline: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "40px"
components:
  pill-ok:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.ok}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "20px"
  pill-warn:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "20px"
  pill-bad:
    backgroundColor: "{colors.bad-soft}"
    textColor: "{colors.bad}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "20px"
  pill-off:
    backgroundColor: "{colors.off-soft}"
    textColor: "{colors.off}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "20px"
  command:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.mono}"
    rounded: "{rounded.md}"
    padding: "2px 2px 2px 8px"
  stat-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  panel-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "16px"
  segmented:
    backgroundColor: "{colors.card}"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.md}"
    padding: "2px"
  segmented-option-pressed:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    height: "24px"
    padding: "0 10px"
  view-tab:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.body}"
    height: "40px"
    padding: "0 12px"
  view-tab-current:
    textColor: "{colors.foreground}"
  list-row:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    padding: "10px 16px"
  list-row-selected:
    backgroundColor: "{colors.selected}"
  select:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 8px"
  link:
    textColor: "{colors.link}"
    typography: "{typography.label}"
---

# Design System: crank-mem dashboard

## Overview

**Creative North Star: "The Instrument Panel Beside the Terminal"**

The dashboard is the developer-tool dashboard a user already knows, played straight: an overview table first, then per-project views, on a neutral zinc ground with hairline borders, one blue accent, and small charts. It sits beside a terminal and an agent session and is read cold, so every surface answers a question in a glance and points at the command that changes the answer. It is a window, not a control panel: nothing on the page edits, accepts or rejects.

Density is medium-high and calm. Cards are flat white on an off-white ground (near-black in dark mode), separated by 1px zinc lines rather than shadows. Colour is spent only where it carries meaning: blue for links, focus, selection and the first data series; green, amber, red and grey only for state, and always beside a word. The system does not develop its own visual identity; the quality bar is Vercel's dashboard and GitHub Actions and Insights.

Light and dark follow the system (`prefers-color-scheme`). Dark values are their own steps tuned for the dark surface, not an inversion; they live in the sidecar's `colorMeta.<token>.dark`.

**Key Characteristics:**
- Neutral zinc ground, white cards, 1px hairline borders, no decorative shadow.
- One blue accent for links, focus ring, selection tint and series 1.
- Status tones (ok, warn, bad, off) each come as text, soft fill and line, and never appear without words.
- System UI sans with tabular figures; mono for paths, ids, models, queries and commands.
- 8px-radius cards, fully rounded pills, small charts on one axis with a Table toggle.
- Every fix sentence pairs with a copyable command.

## Colors

A zinc greyscale carries almost everything; one blue and four state tones are the only hues, plus three categorical chart series.

### Primary
- **Signal Blue** (ring): the focus outline (2px, 2px offset), text selection tint (28% mix), the checkbox accent, and the pressed "Include stale" border. The single accent of the system.
- **Link Blue** (link): text links and in-text actions such as "Open Curation" and observation ids (`#42`), underlined on hover with a 3px offset.
- **Selection Wash** (selected): the background of the selected list row, project row or card, and the highlighted pair in a key/value card.

### Neutral
- **Paper Zinc** (background): the page ground behind cards.
- **Card White** (card): every card, table, top bar, list column and list foot.
- **Ink Zinc** (foreground): body text, headings, figures, the wordmark and the current tab's underline.
- **Quiet Zinc** (muted-foreground): labels, notes, metadata lines, axis labels, inactive tabs and empty-state text.
- **Wash Zinc** (muted / accent): the command chip and kbd fill, bar-list tracks, the table header tint (50%), the hover fill on rows (60–70%) and the pressed segment.
- **Hairline Zinc** (border): every card edge, row divider and table rule.
- **Field Zinc** (input): form-control borders and the scrollbar thumb.

### Status tones
- **Ok Green**, **Warn Amber**, **Bad Red**, **Off Grey** (ok, warn, bad, off): text colour for a state word. Each has a `-soft` fill and a `-line` border used together for pills and banners.
- **Destructive** (destructive): error text when a request fails, the same red as bad.

### Chart
- **Series 1 / 2 / 3** (series-1 blue, series-2 orange, series-3 green): the first three slots of a validated categorical order, checked for light and dark. Series 1 is the default for single-series charts, sparklines and bar lists.
- **Grid** and **Axis** (grid, axis): tick lines and the zero baseline. A sparkline with no activity draws in axis grey.

### Named Rules
**The State Has Words Rule.** A status tone never stands alone: a pill carries its label ("Healthy", "Stopped", "stale"), a toned figure sits under its label, and a fix sentence states the fact in words.

**The Quiet When Healthy Rule.** An ok state does not tint figures. Stat values take a tone only for warn, bad or off; healthy values stay ink.

**The Series Are Not Status Rule.** Charts draw with series-1..3 in a fixed order, never with the ok/warn/bad tones, even when a series means "accepted" or "rejected".

## Typography

**Body Font:** system UI sans (ui-sans-serif, system-ui, -apple-system, Segoe UI)
**Label/Mono Font:** ui-monospace (SF Mono, Menlo)

**Character:** The platform's own sans, as in the tools beside it, with tabular figures wherever numbers line up; mono marks anything a user might type or paste.

### Hierarchy
- **Headline** (600, 20px, tight tracking): the page heading of a scrolling view ("Projects", "Usage").
- **Title** (600, 18px, snug): the focused project's name and the heading of a detail pane (a proposal's bullet, an observation's title). List-column heads in Curation and Memory step down to 16px semibold.
- **Figure** (600, 24px, tight, tabular): the value in a stat card.
- **Section** (600, 14px): the title of a card, chart or list.
- **Body** (400, 14px, 1.5): table cells, prose, reasons and narratives; detail panes cap at 768px.
- **Label** (500 or 400, 12px): column heads, stat labels, field labels, notes under titles, pills and metadata lines. Sentence case, never uppercase.
- **Axis** (400, 11px, tabular): chart ticks and dates, kbd keys.
- **Mono** (400, 12px): project roots, file paths, observation ids, models, queries, channels and commands.

### Named Rules
**The Typed Things Are Mono Rule.** Paths, ids, model names, search queries, channel names and commands set in mono; everything else is sans.

**The Columns Line Up Rule.** Counts, costs, times and axis labels use tabular figures; numeric table columns align right.

## Layout

Two layouts carry the page. Scrolling views (Health, Usage) center a column up to 1400px wide with 16px side padding (24px from `md`), 24–32px top padding, and 40px between the projects overview and the focused project (24px between Usage sections). List-and-detail views (Curation, Memory) split the screen: a card-white list column of 20–28rem with a right hairline, then a scrolling detail pane whose body caps at 768px with 24px gaps and 24–32px padding. Below `md` the split stacks and the list caps at 70% of the viewport height.

The top bar is sticky: a 56px row (wordmark, project switcher, spacer, host pill reading read-only) over a 40px row of view tabs. Stat cards run 2 columns, 3 from `md`, 6 (Health) or 5 (Usage) from `xl`, with 12px gaps. Charts pair two-up from `lg` with 16px gaps; the Usage calls chart takes 2fr beside a 1fr bar-list card.

Spacing steps on a 4px base: 2px hairline gaps inside segmented controls and stacked bars, 4–8px inside rows, 12px between cards, 16px card padding, 24–40px between sections.

### Named Rules
**The Cards Below Large Rule.** Below `lg` (1024px) the projects table becomes a list of stacked cards: name and status pill, root in mono, one metadata line, and the fix line under it. The table only renders from `lg` up.

**The Place Is the URL Rule.** Project, view, tab and selected item live in the query string, so a reload reopens the same place.

## Elevation & Depth

The system is flat. Depth comes from tonal layering (white cards on an off-white ground, a 50% wash on table heads) and 1px hairline borders. The only shadow is the chart tooltip's, which floats over the plot; the stock outline button carries a hairline `shadow-xs` from its library.

### Shadow Vocabulary
- **Tooltip lift** (`box-shadow: 0 4px 12px rgb(0 0 0 / 0.08)`): chart tooltips only.

### Named Rules
**The Hairline Not Shadow Rule.** Cards, tables and banners separate with a 1px border, never a shadow.

## Shapes

Gently rounded throughout from one 8px base radius: cards, tables, banners and chart panels at 8px; controls, selects, commands and the segmented frame at 6px; segment buttons at 5px; kbd keys, code spans and column tops at 4px; legend swatches at 2px. Pills, status dots, bar-list bars and the current-tab underline are fully round. Chart columns round only their top corners and only on the top segment of a stack.

## Components

### Pill
Small and wordy: the state's word in a soft-tinted capsule.
- **Shape:** fully round, 20px tall, 8px side padding, 1px border.
- **Colour:** the tone's `-soft` fill, `-line` border and text tone; 12px medium.
- **Use:** project status, proposal state (pending warn, accepted ok, rejected bad, expired off), consolidation outcome (ok, retry warn, other bad), stale observations (bad). One status pill per project row.

### Status Dot
An 8px round mark (10px beside the focused project's title) in the tone's solid colour. It accompanies a word, as in the focused project heading followed by its status label.

### Command
A copyable command in mono: muted fill, hairline border, 6px radius, 12px mono text, and a 20px copy button whose icon switches to a check for 1.5s after copying.

### Fix Line
The fact that stalls capture, in the tone's text colour, followed by its Command. It sits under a stalled project's row or card, and as a banner above the focused project's stats (bad and warn banners take the soft fill and line border; others sit on card white).

### Stat Card
Card white, 8px radius, 12px by 16px padding: a 12px label, a 24px semibold figure, and a 12px context line ("list price, not billed").

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** card white on the paper ground.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1px hairline zinc.
- **Internal Padding:** 16px for chart and list cards; card heads 12px by 16px with a bottom rule.

### Pairs
Key/value rows in a 7–10rem label column: 12px quiet labels, body values, hairline rules between rows. In its own bordered card by default; the bare variant drops the card when it already sits inside one (the Last consolidation panel). One highlighted pair takes the selection wash.

### Segmented Control
A card-white frame with a hairline border, 6px radius and 2px padding holding 24px buttons; the pressed option takes the wash fill and ink text. Used for the 7/30/90-day window.

### Navigation
View tabs sit under the top bar: 14px quiet text, 40px tall; hover turns ink; the current view is medium ink with a 2px fully-round ink underline inset 8px. The project switcher is a native select (32px, 6px radius, field border) led by its project's status dot, whose label screen readers hear as the select's description and pointers see as its title. The host pill shows the host in mono and a "read-only" chip.

### List Row
A full-width button: 10px by 16px padding, hairline bottom rule, a medium title line and a 12px metadata line. Hover takes a 70% wash; the selected row takes the selection wash and keeps it on hover. j/k and the arrow keys move the selection, and the List Foot shows the kbd hint and an "Older" control when more pages exist.

### Day Columns Chart
A titled card: section title, a one-line note stating the window's totals, a legend when there is more than one series, and a Table toggle that swaps the plot for the same numbers by day. Stacked columns up to 24px wide sit on one count axis with four "nice" ticks (1, 2 or 5 times a power of ten), grid lines, an axis-grey baseline, and dates ending in "Today". Hover or arrow keys pick a day, wash its band, and show a tooltip listing every series with a total.

### Sparkline and Bar List
The sparkline is a 96 by 24px series-1 line with an end dot on its own zero-based axis; flat and axis-grey when every value is zero. The bar list ranks rows on 8px round bars over a wash track, with label, bar and a right-aligned tabular count.

### Named Rules
**The Fix Has a Command Rule.** Every fix sentence that has a remedy carries it as a copyable Command; a fix without a command (parked entries) says why none applies.

**The One Axis Rule.** A chart plots on one axis, stacks its series in a fixed order, and offers a Table toggle with the same numbers.

**The Shared Scale Rule.** Bar lists shown side by side share one maximum, so equal counts draw equal bars.

**The Empty States Say What Happened Rule.** An empty list or chart states the fact plainly and, when one exists, the command that changes it ("No projects yet: run crank-mem init in a project.").

## Do's and Don'ts

### Do:
- **Do** pair every status tone with its word: a Pill label, a figure under its label, or a fix sentence.
- **Do** give each project row exactly one status pill, from the first problem in capture order.
- **Do** put a copyable Command beside every fix sentence that has a remedy.
- **Do** plot charts on one axis with series-1, series-2, series-3 in that order, and keep the Table toggle.
- **Do** pass one shared `max` to bar lists that sit side by side.
- **Do** switch the projects table to stacked cards below `lg` (1024px).
- **Do** set paths, ids, models, queries and commands in mono, and numbers in tabular figures.
- **Do** write empty states as the fact plus the command, in GLOSSARY.md's words.

### Don't:
- **Don't** add a second accent hue; blue is the only one.
- **Don't** use ok/warn/bad/off tones for decoration, chart series or category tags.
- **Don't** separate cards with shadows; use the 1px hairline.
- **Don't** add controls that edit, accept or reject memory; the dashboard is read-only.
- **Don't** set labels in uppercase or add eyebrow text above headings.
