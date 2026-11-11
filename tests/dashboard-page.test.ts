import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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

/** The text of the stat tile labelled `label`, after the label. */
function tile(page: any, label: string): string {
  const el = [...page.querySelectorAll("div")].find(
    (d: any) => d.firstElementChild?.textContent === label && d.children.length > 1,
  );
  if (el === undefined) throw new Error(`no ${label} tile`);
  return el.textContent.slice(label.length);
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
