import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { USAGE_CHANNELS } from "../src/hooks/lib/wire.ts";

// The real dashboard page, rendered in happy-dom against stubbed /api answers.
const DASHBOARD = new URL("../dashboard/", import.meta.url).pathname;
/** The page's globals: happy-dom registers them, and the root tsconfig's lib does not type them. */
const dom = globalThis as any;
let React: any;
let ReactDOM: any;
let App: any;

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:4777/?view=health" });
  dom.IS_REACT_ACT_ENVIRONMENT = true;
  // From the dashboard's own install, so the test and the page share one React.
  React = await import(DASHBOARD + "node_modules/react/index.js");
  ReactDOM = await import(DASHBOARD + "node_modules/react-dom/client.js");
  ({ App } = await import(DASHBOARD + "src/App.tsx"));
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** Answers the page's fetches by path: an Error rejects the fetch, a path not listed is a 404. */
function serve(routes: Record<string, unknown>): void {
  dom.fetch = async (input: unknown) => {
    const answer = routes[new URL(String(input), dom.location.href).pathname];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) return new Response("{}", { status: 404 });
    return Response.json(answer);
  };
}

/** Renders the page, lets its first fetches settle, and returns its root element and an unmount. */
async function openPage(): Promise<{ page: any; unmount: () => Promise<void> }> {
  const page = dom.document.createElement("div");
  dom.document.body.replaceChildren(page);
  const root = ReactDOM.createRoot(page);
  await React.act(async () => root.render(React.createElement(App)));
  await React.act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return { page, unmount: () => React.act(async () => root.unmount()) };
}

/** The stat tile element labelled `label`. */
function tileOf(page: any, label: string): any {
  const el = [...page.querySelectorAll("div")].find(
    (d: any) => d.firstElementChild?.textContent === label && d.children.length > 1,
  );
  if (el === undefined) throw new Error(`no ${label} tile`);
  return el;
}

/** The text of the stat tile labelled `label`, after the label. */
function tile(page: any, label: string): string {
  return tileOf(page, label).textContent.slice(label.length);
}

const PROJECT = { id: "p", name: "proj", root: "/p", memory: "/p/.crank/memory.db" };
const HEALTHY = {
  digest: "on",
  stopReason: null,
  daemonAlive: true,
  spool: { waiting: 0, parked: 0 },
  store: "open",
  memory: {
    observations: 7,
    unembedded: 0,
    lastDigestMs: null,
    monthCostUsd: 0,
    pendingProposals: 0,
    staleFlags: 0,
    lastConsolidation: null,
  },
  lastSnapshotMs: null,
  embedderReady: true,
  status: { tone: "ok", label: "Healthy", fix: null },
};

test("a page whose projects fetch fails shows the error and the command that restarts the server", async () => {
  serve({ "/api/projects": new TypeError("Failed to fetch") });
  const { page, unmount } = await openPage();
  expect(page.textContent).toContain("Failed to fetch");
  expect(page.textContent).toContain("run crank-mem dashboard again");
  await unmount();
});

test("a machine with no projects says so and names crank-mem init", async () => {
  serve({ "/api/projects": { projects: [] } });
  const { page, unmount } = await openPage();
  expect(page.textContent).toContain("No projects yet: run crank-mem init in a project.");
  await unmount();
});

test("the focused project's tiles name its digest state and whether its observations are searchable", async () => {
  const cases: [string, object, string, string][] = [
    ["on", {}, "On", "searchable"],
    ["off", { digest: "off" }, "Off", "searchable"],
    ["stopped", { digest: "stopped", stopReason: "login" }, "Stopped", "searchable"],
    ["store older", { store: "older", memory: null }, "On", "older"],
    ["waiting", { memory: { ...HEALTHY.memory, unembedded: 5 } }, "On", "5 waiting for embeddings"],
    ["embedder", { embedderReady: false }, "On", "embedder not ready"],
  ];
  for (const [name, change, digest, observations] of cases) {
    serve({
      "/api/projects": { projects: [PROJECT] },
      "/api/projects/p/health": { ...HEALTHY, ...change },
    });
    const { page, unmount } = await openPage();
    expect(`${name}: ${tile(page, "Digest")}`).toStartWith(`${name}: ${digest}`);
    expect(`${name}: ${tile(page, "Observations")}`).toContain(observations);
    await unmount();
  }
});

test("the usage view shows recall reach and surfaced follow-through first, and a null figure as a dash", async () => {
  const zero = Object.fromEntries(USAGE_CHANNELS.map((c) => [c, 0]));
  const perDay = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-11-0${i + 1}`,
    counts: { ...zero },
  }));
  dom.history.replaceState(null, "", "?view=usage");
  try {
    serve({
      "/api/projects": { projects: [PROJECT] },
      "/api/projects/p/usage": {
        perDay,
        searches: 0,
        zeroResultShare: null,
        keywordShare: null,
        followThrough: null,
        recallReach: 0.5,
        surfacedFollowThrough: null,
        topQueries: [],
        surfaced: [],
        neverSurfacedShare: null,
        filesWithoutMemory: [],
      },
    });
    const { page, unmount } = await openPage();
    const labels = [...tileOf(page, "Searches").parentElement.children].map(
      (c: any) => c.firstElementChild.textContent,
    );
    expect(labels).toEqual([
      "Recall reach",
      "Surfaced follow-through",
      "Searches",
      "Zero-result searches",
      "Keyword-only searches",
      "Search follow-through",
      "Never surfaced",
    ]);
    expect(tile(page, "Recall reach")).toBe("50%sessions that searched or opened memory");
    expect(tile(page, "Surfaced follow-through")).toBe("—surfaced ids the agent opened");
    expect(tile(page, "Search follow-through")).toBe("—results the agent opened");
    await unmount();
  } finally {
    dom.history.replaceState(null, "", "?view=health");
  }
});

const UPDATES = {
  installed: "1.0.0",
  installedCopy: true,
  latest: {
    version: "9.9.9",
    releasedAt: "2026-11-09T00:00:00Z",
    notesUrl: "http://example.test/r/tag/v9.9.9",
  },
  available: true,
  checkedAtMs: Date.now() - 3_600_000,
  error: null,
  auto: false,
  checkDaily: true,
  behind: [{ root: "/p", name: "proj", vendored: "0.9.0" }],
};

test("the Updates section shows both versions and the self-update command, and a failed fetch leaves the page whole", async () => {
  const routes = {
    "/api/projects": { projects: [PROJECT] },
    "/api/projects/p/health": HEALTHY,
  };
  serve({ ...routes, "/api/updates": UPDATES });
  let { page, unmount } = await openPage();
  const section = page.querySelector("[aria-labelledby=updates-heading]");
  expect(section?.textContent).toContain("1.0.0");
  expect(section?.textContent).toContain("9.9.9");
  expect(section?.textContent).toContain("crank-mem self-update");
  expect(section?.querySelector("a")?.getAttribute("href")).toBe(UPDATES.latest.notesUrl);
  expect(section?.textContent).toContain("Checked once a day against the latest release");
  await unmount();

  serve({ ...routes, "/api/updates": { ...UPDATES, checkDaily: false } });
  ({ page, unmount } = await openPage());
  const unchecked = page.querySelector("[aria-labelledby=updates-heading]")?.textContent;
  expect(unchecked).toContain("Daily checks are off");
  expect(unchecked).not.toContain("Checked once a day");
  await unmount();

  serve(routes);
  ({ page, unmount } = await openPage());
  expect(tile(page, "Digest")).toStartWith("On");
  expect(page.querySelector("[aria-labelledby=updates-heading]")).toBeNull();
  expect(page.textContent).not.toContain("/api/updates");
  await unmount();

  serve({ ...routes, "/api/updates": { ...UPDATES, installedCopy: false, available: false } });
  ({ page, unmount } = await openPage());
  expect(page.textContent).toContain(
    "Running from a clone — update with git pull, then crank-mem upgrade --all",
  );
  expect(page.textContent).not.toContain("crank-mem self-update");
  await unmount();
});

test("the Not installed section lists each repo with crank-mem init, and an empty or failed fetch shows nothing", async () => {
  const routes = {
    "/api/projects": { projects: [PROJECT] },
    "/api/projects/p/health": HEALTHY,
    "/api/updates": UPDATES,
  };
  const day = 24 * 60 * 60 * 1000;
  const repos = [
    { root: "/work/scratch-one", lastSeenMs: Date.now() - day, sessions: ["s1"] },
    { root: "/work/scratch-two", lastSeenMs: Date.now() - 2 * day, sessions: [] },
  ];
  serve({ ...routes, "/api/untouched": { repos } });
  let { page, unmount } = await openPage();
  const section = page.querySelector("[aria-labelledby=untouched-heading]");
  const updates = page.querySelector("[aria-labelledby=updates-heading]");
  expect(section).not.toBeNull();
  expect(
    updates.compareDocumentPosition(section) & dom.Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(section.querySelector("#untouched-heading")?.textContent).toBe("Not installed");
  expect(section.textContent).toContain("/work/scratch-one");
  expect(section.textContent).toContain("/work/scratch-two");
  expect([...section.querySelectorAll("time")].map((t: any) => t.getAttribute("datetime"))).toEqual(
    repos.map((r) => new Date(r.lastSeenMs).toISOString()),
  );
  expect(section.textContent.split("crank-mem init").length - 1).toBe(1);
  await unmount();

  serve({ ...routes, "/api/untouched": { repos: [] } });
  ({ page, unmount } = await openPage());
  expect(page.querySelector("[aria-labelledby=untouched-heading]")).toBeNull();
  await unmount();

  serve(routes);
  ({ page, unmount } = await openPage());
  expect(tile(page, "Digest")).toStartWith("On");
  expect(page.querySelector("[aria-labelledby=untouched-heading]")).toBeNull();
  await unmount();
});

/** Runs `body` with the page's URL query set to `query`, then puts back the Health view. */
async function at(query: string, body: () => Promise<void>): Promise<void> {
  dom.history.replaceState(null, "", query);
  try {
    await body();
  } finally {
    dom.history.replaceState(null, "", "?view=health");
  }
}

/** Presses `key` on the page, then lets the fetches it starts settle. */
async function press(key: string): Promise<void> {
  await React.act(async () => {
    dom.document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await React.act(() => new Promise((resolve) => setTimeout(resolve, 20)));
}

/** The text of the list row the page marks as selected, or null when none is. */
function selectedRow(page: any): string | null {
  return page.querySelector("[data-row][aria-current]")?.textContent ?? null;
}

/** The text of the page's `name` section: "List" or "Detail". */
function section(page: any, name: "List" | "Detail"): string {
  return page.querySelector(`section[aria-label=${name}]`)?.textContent ?? "";
}

/** The `item` the page's URL holds. */
const urlItem = () => new URLSearchParams(dom.location.search).get("item");

const OBS = "/api/projects/p/observations";
const line = (id: number, title: string) => ({
  id,
  createdAtMs: Date.UTC(2026, 10, 1),
  type: "discovery",
  title,
  stale: false,
});
const observation = (id: number, title: string) => ({
  ...line(id, title),
  sessionId: "s1",
  narrative: `narrative of ${title}`,
  facts: [],
  filesRead: [],
  filesModified: [],
  staleFlag: null,
});

test("the Memory view selects the first row, moves with j, counts the page and keeps an off-page item", async () => {
  serve({
    "/api/projects": { projects: [PROJECT] },
    [OBS]: { rows: [line(11, "First line"), line(12, "Second line")], next: null, mode: "keyword" },
    [`${OBS}/11`]: observation(11, "First line"),
    [`${OBS}/12`]: observation(12, "Second line"),
    [`${OBS}/99`]: observation(99, "Off-page line"),
  });
  await at("?view=memory", async () => {
    const { page, unmount } = await openPage();
    expect(selectedRow(page)).toContain("First line");
    expect(urlItem()).toBe("11");
    expect(section(page, "Detail")).toContain("narrative of First line");
    expect(section(page, "List")).toContain("2 shown");
    expect(section(page, "List")).toContain("keyword search");

    await press("j");
    expect(selectedRow(page)).toContain("Second line");
    expect(urlItem()).toBe("12");
    expect(section(page, "Detail")).toContain("narrative of Second line");
    await unmount();
  });

  await at("?project=p&view=memory&item=99", async () => {
    const { page, unmount } = await openPage();
    expect(urlItem()).toBe("99");
    expect(selectedRow(page)).toBeNull();
    expect(section(page, "Detail")).toContain("narrative of Off-page line");
    await unmount();
  });

  await at("?project=p&view=memory&item=98", async () => {
    const { page, unmount } = await openPage();
    expect(urlItem()).toBe("11");
    expect(selectedRow(page)).toContain("First line");
    expect(section(page, "Detail")).toContain("narrative of First line");
    await unmount();
  });
});

test("an empty Memory page says nothing matches and selects nothing", async () => {
  serve({ "/api/projects": { projects: [PROJECT] }, [OBS]: { rows: [], next: null } });
  await at("?view=memory", async () => {
    const { page, unmount } = await openPage();
    expect(section(page, "List")).toContain("Nothing matches.");
    expect(section(page, "List")).toContain("0 shown");
    expect(section(page, "List")).not.toContain("search");
    expect(urlItem()).toBeNull();
    await unmount();
  });
});

test("a Memory fetch that fails shows its error in the pane it was filling", async () => {
  const rows = { rows: [line(11, "First line")], next: null };
  serve({
    "/api/projects": { projects: [PROJECT] },
    [OBS]: rows,
    [`${OBS}/11`]: new TypeError("Failed to fetch"),
  });
  await at("?view=memory", async () => {
    const { page, unmount } = await openPage();
    expect(selectedRow(page)).toContain("First line");
    expect(section(page, "Detail")).toContain("Failed to fetch");
    await unmount();
  });

  serve({ "/api/projects": { projects: [PROJECT] }, [OBS]: new TypeError("Failed to fetch") });
  await at("?view=memory", async () => {
    const { page, unmount } = await openPage();
    expect(section(page, "List")).toContain("Failed to fetch");
    expect(page.querySelector("[data-row]")).toBeNull();
    await unmount();
  });
});

const PROPOSALS = "/api/projects/p/proposals";
const proposal = (id: number, bullet: string) => ({
  id,
  kind: "add",
  bullet: `- ${bullet}`,
  state: "pending",
  reason: null,
  createdAtMs: Date.UTC(2026, 10, 1),
  decidedAtMs: null,
});

test("the Curation proposals list selects the first proposal, moves with j and counts the page", async () => {
  serve({
    "/api/projects": { projects: [PROJECT] },
    [PROPOSALS]: {
      rows: [proposal(21, "First proposal"), proposal(22, "Second proposal")],
      next: null,
    },
  });
  await at("?view=curation", async () => {
    const { page, unmount } = await openPage();
    expect(selectedRow(page)).toContain("First proposal");
    expect(urlItem()).toBe("21");
    expect(section(page, "Detail")).toContain("First proposal");
    expect(section(page, "List")).toContain("2 shown");

    await press("j");
    expect(selectedRow(page)).toContain("Second proposal");
    expect(urlItem()).toBe("22");
    expect(section(page, "Detail")).toContain("Second proposal");
    await unmount();
  });
});

test("an empty Curation proposals page says nothing is here yet", async () => {
  serve({ "/api/projects": { projects: [PROJECT] }, [PROPOSALS]: { rows: [], next: null } });
  await at("?view=curation", async () => {
    const { page, unmount } = await openPage();
    expect(section(page, "List")).toContain("Nothing here yet.");
    expect(page.querySelector("[data-row]")).toBeNull();
    expect(urlItem()).toBeNull();
    await unmount();
  });
});

test("a usage fetch that fails shows its error on the Usage view", async () => {
  serve({
    "/api/projects": { projects: [PROJECT] },
    "/api/projects/p/usage": new TypeError("Failed to fetch"),
  });
  await at("?view=usage", async () => {
    const { page, unmount } = await openPage();
    expect(page.textContent).toContain("Failed to fetch");
    await unmount();
  });
});
