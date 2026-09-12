// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProject } from "../lib/agentProjects";
import { AgentProjectsView } from "./AgentProjectsView";

const api = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("../lib/agentProjects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/agentProjects")>()),
  loadAgentProjects: api.load,
  saveAgentProject: api.save,
  deleteAgentProject: api.remove,
  createAgentProject: api.create,
  subscribeAgentProjects: api.subscribe,
}));
vi.mock("../chrome/TitleBar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chrome/TitleBar")>()),
  OverlayNav: () => null,
}));
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../hooks/useInboxUnseen", () => ({ useInboxUnseen: () => false }));
vi.mock("../hooks/useProjectDiffStats", () => ({
  useProjectDiffStats: () => null,
}));
vi.mock("../hooks/useGitFileStatuses", () => ({
  useGitFileStatuses: () => ({ files: new Map(), dirs: new Map() }),
}));
vi.mock("../chrome/SidebarUpdate", () => ({ SidebarUpdateFooter: () => null }));
vi.mock("../chrome/FileTree", () => ({ FileTree: () => null }));

let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof AgentProjectsView>;
let records: AgentProject[];
let notify: () => void;

const project = (overrides: Partial<AgentProject> = {}): AgentProject => ({
  id: "project-1",
  cwd: "/workspace/repo",
  name: "Release readiness",
  goal: "Ship a reliable release",
  instructions: "",
  documents: [],
  members: [],
  subscriptions: [],
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});
async function render() {
  await act(async () => root.render(createElement(AgentProjectsView, props)));
}
function findButton(text: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (item) =>
      item.textContent?.trim() === text ||
      item.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}
async function click(text: string) {
  await act(async () => findButton(text).click());
}
async function type(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )!;
  expect(input).not.toBeNull();
  const prototype =
    input.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function check(label: string) {
  await act(async () =>
    document
      .querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
      .click(),
  );
}
async function selectProject() {
  const selected =
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Project list"] button[aria-current]',
    ) ??
    [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Project list"] button',
      ),
    ].find((item) => item.textContent?.includes("Release readiness"))!;
  await act(async () => selected.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  records = [project()];
  api.load.mockImplementation(async () => structuredClone(records));
  api.save.mockImplementation(async (value: AgentProject) => {
    const saved = { ...structuredClone(value), updatedAt: value.updatedAt + 1 };
    records = [...records.filter((item) => item.id !== saved.id), saved];
    return saved;
  });
  api.create.mockImplementation((cwd: string, name: string, goal: string) =>
    project({ id: "new-project", cwd, name, goal }),
  );
  api.remove.mockImplementation(async (id: string) => {
    records = records.filter((item) => item.id !== id);
  });
  api.subscribe.mockImplementation((listener: () => void) => {
    notify = listener;
    return vi.fn();
  });
  props = {
    cwd: "/workspace/repo",
    sessions: [],
    busySessionIds: new Set(),
    onClose: vi.fn(),
    onOpenSession: vi.fn(),
    onStartSession: vi.fn().mockResolvedValue(undefined),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  if (container.querySelector('button[aria-label="Close Projects"]')) {
    await click("Close Projects");
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((item) => item.textContent?.trim() === "Confirm");
    if (confirm) await act(async () => confirm.click());
  }
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Projects workspace", () => {
  it("requires a repository instead of trying to create projects in the global home view", async () => {
    props.cwd = "~";
    await render();
    expect(container.textContent).toContain("Choose a repository folder");
    expect(findButton("New project").disabled).toBe(true);
    expect(findButton("Create project").disabled).toBe(true);
    expect(api.load).not.toHaveBeenCalled();
  });

  it("accepts the bare Windows drive-root form used by repository recents", async () => {
    props.cwd = "C:";
    await render();
    expect(findButton("New project").disabled).toBe(false);
    expect(api.load).toHaveBeenCalledWith("C:");
  });

  it("explains concurrent schedules and the explicit team capacity cleanup", async () => {
    await render();
    await selectProject();
    await click("Subscriptions");
    expect(container.textContent).toContain(
      "concurrently in the same checkout",
    );
    expect(container.textContent).toContain("64 team members");
    expect(container.textContent).not.toContain("Busy projects");
    await click("Agents");
    expect(container.textContent).toContain("0/64 team members");
    expect(container.textContent).toContain("Unlink finished");
  });

  it("recovers unsaved context after external app navigation unmounts the workspace", async () => {
    await render();
    await selectProject();
    await click("Context");
    await type("Shared instructions", "Recover these instructions");
    await act(async () => root.render(null));
    await render();
    await selectProject();
    expect(container.textContent).toContain("Recovered your unsaved draft");
    await click("Context");
    expect(
      document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Shared instructions"]',
      )?.value,
    ).toBe("Recover these instructions");
    await click("Save changes");
    expect(records[0].instructions).toBe("Recover these instructions");
  });
  it("hides the inner project list when the rail already owns switching", async () => {
    await act(async () =>
      root.render(
        createElement(AgentProjectsView, {
          ...props,
          activeProjectId: "project-1",
        }),
      ),
    );
    const list = container.querySelector('[aria-label="Project list"]');
    expect(list?.className).toContain("hidden");
    expect(container.textContent).toContain("Release readiness");
    expect(container.textContent).not.toContain("← All projects");
  });

  it("renders beside the chat as a Project pane", async () => {
    await act(async () =>
      root.render(
        createElement(AgentProjectsView, {
          ...props,
          activeProjectId: "project-1",
          variant: "pane",
        }),
      ),
    );
    expect(container.querySelector('[aria-label="Project"]')).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Close Project"]'),
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="Project list"]')?.className).toContain(
      "hidden",
    );
  });

  it("loads only the current folder and creates a named initiative with a goal", async () => {
    records = [];
    await render();
    expect(api.load).toHaveBeenCalledWith(props.cwd);
    expect(container.textContent).toContain("No projects in this folder yet");
    await click("New project");
    expect(
      document.querySelector<HTMLButtonElement>(
        'form button:not([type="button"])',
      )?.disabled,
    ).toBe(true);
    await type("Project name", "  Next release  ");
    await type("Goal", "  Ship version two  ");
    const form = document.querySelector("form")!;
    await act(async () =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    expect(api.create).toHaveBeenCalledWith(
      props.cwd,
      "Next release",
      "Ship version two",
    );
    expect(api.save).toHaveBeenCalled();
    expect(container.textContent).toContain("Next release");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("filters projects by name and goal", async () => {
    await render();
    await type("Search projects", "unrelated");
    expect(container.textContent).toContain("No matching projects.");
    await type("Search projects", "reliable");
    expect(container.textContent).toContain("Release readiness");
  });

  it("shows synchronous creation validation failures without closing the form", async () => {
    await render();
    await click("New project");
    await type("Project name", "Invalid name");
    await type("Goal", "Release goal");
    api.create.mockImplementationOnce(() => {
      throw new Error("Invalid project name");
    });
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(
      document.querySelector('[role="dialog"] [role="alert"]')?.textContent,
    ).toContain("Invalid project name");
    expect(api.save).not.toHaveBeenCalled();
  });

  it("shows loading and recoverable load errors", async () => {
    let reject!: (reason: Error) => void;
    api.load.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    await render();
    expect(container.textContent).toContain("Loading projects");
    await act(async () => reject(new Error("Disk unavailable")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Disk unavailable",
    );
    await click("Retry loading");
    expect(container.textContent).toContain("Release readiness");
  });

  it("explicitly saves instructions and document CRUD, using the returned record", async () => {
    await render();
    await selectProject();
    await click("Context");
    await type("Shared instructions", "Use supervised tools.");
    await click("Add document");
    await type("Document 1 name", "Release checklist");
    await type("Document 1 content", "- Run tests");
    expect(api.save).not.toHaveBeenCalled();
    await click("Save changes");
    expect(records[0].instructions).toBe("Use supervised tools.");
    expect(records[0].documents).toEqual([
      expect.objectContaining({
        name: "Release checklist",
        content: "- Run tests",
      }),
    ]);
    expect(container.textContent).toContain(
      "Members receive this context on their next turn",
    );
    await type("Document 1 name", "Updated checklist");
    await click("Save changes");
    expect(api.save.mock.calls[1][0].updatedAt).toBe(2);
    await click("Remove document 1");
    await click("Save changes");
    expect(records[0].documents).toEqual([]);
  });

  it("keeps edits visible on save conflicts and confirms dirty navigation", async () => {
    await render();
    await selectProject();
    await click("Context");
    await type("Shared instructions", "Unsaved instructions");
    api.save.mockRejectedValueOnce(new Error("Project changed elsewhere"));
    await click("Save changes");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Your edits are still here",
    );
    expect(
      document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Shared instructions"]',
      )?.value,
    ).toBe("Unsaved instructions");
    await click("Close Projects");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Discard unsaved changes?");
    await click("Cancel");
    expect(props.onClose).not.toHaveBeenCalled();
    await click("Close Projects");
    await click("Confirm");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("preserves live members when saving context edited during a membership update", async () => {
    await render();
    await selectProject();
    await click("Context");
    await type("Shared instructions", "Keep my local edits");
    records = [
      project({
        updatedAt: 4,
        members: [{ sessionId: "new-worker", role: "worker", title: "Worker" }],
      }),
    ];
    await act(async () => notify());
    await click("Save changes");
    expect(api.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        updatedAt: 4,
        instructions: "Keep my local edits",
        members: records[0].members,
      }),
    );
  });

  it("keeps nested discard confirmations focused and leaves the schedule intact on Escape", async () => {
    await render();
    await selectProject();
    await click("Subscriptions");
    await click("Add schedule");
    await type("Schedule name", "Draft schedule");
    await click("Cancel");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Schedule name"]')
        ?.value,
    ).toBe("Draft schedule");
  });

  it("requires explicit consent before enabling recurring local prompts", async () => {
    await render();
    await selectProject();
    await click("Subscriptions");
    await click("Add schedule");
    await type("Schedule name", "Release check-in");
    await type("Schedule prompt", "Review release progress");
    await type("Interval in minutes", "15");
    await check("Enable schedule");
    expect(findButton("Save schedule").disabled).toBe(true);
    await check("Consent to local scheduled runs");
    expect(findButton("Save schedule").disabled).toBe(false);
    await click("Save schedule");
    expect(records[0].subscriptions).toEqual([
      expect.objectContaining({
        name: "Release check-in",
        prompt: "Review release progress",
        intervalMinutes: 15,
        enabled: true,
      }),
    ]);
    await check("Enable Release check-in");
    expect(records[0].subscriptions[0].enabled).toBe(false);
    await check("Enable Release check-in");
    expect(findButton("Save schedule").disabled).toBe(true);
  });

  it("rejects out-of-range schedules even on direct submit", async () => {
    await render();
    await selectProject();
    await click("Subscriptions");
    await click("Add schedule");
    await type("Schedule name", "Check");
    await type("Schedule prompt", "Check progress");
    await type("Interval in minutes", "1");
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(api.save).not.toHaveBeenCalled();
    await type("Interval in minutes", "10081");
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(api.save).not.toHaveBeenCalled();
  });

  it("navigates to members with live status without persisting membership itself", async () => {
    records = [
      project({
        members: [
          {
            sessionId: "coordinator",
            role: "coordinator",
            title: "Release coordinator",
          },
          { sessionId: "gone", role: "worker", title: "Deleted worker" },
        ],
      }),
    ];
    props.sessions = [
      {
        id: "coordinator",
        cwd: props.cwd,
        harness: "codex",
        model: "",
        runtimeMode: "supervised",
        title: "Release coordinator",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    props.busySessionIds = new Set(["coordinator"]);
    await render();
    await selectProject();
    expect(container.textContent).toContain("Working");
    expect(container.textContent).toContain("Unavailable");
    await click("Resume coordinator");
    expect(props.onStartSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-1" }),
      "coordinator",
      expect.stringContaining("Ship a reliable release"),
      "Release readiness",
    );
    const member = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((item) => item.textContent?.includes("Release coordinator"))!;
    await act(async () => member.click());
    expect(props.onOpenSession).toHaveBeenCalledWith("coordinator");
    expect(api.save).not.toHaveBeenCalled();
  });

  it("can restart a stale coordinator whose unsent draft no longer exists", async () => {
    records = [
      project({
        members: [
          {
            sessionId: "unsent-draft",
            role: "coordinator",
            title: "Old coordinator draft",
          },
        ],
      }),
    ];
    await render();
    await selectProject();
    expect(container.textContent).toContain("Unavailable");
    await click("Start coordinator");
    expect(props.onStartSession).toHaveBeenCalledWith(
      expect.objectContaining({ members: records[0].members }),
      "coordinator",
      expect.stringContaining("Ship a reliable release"),
      "Release readiness",
    );
    expect(api.save).not.toHaveBeenCalled();
  });

  it("unlinks a deleted worker with confirmation while preserving fresh coordinator membership", async () => {
    records = [
      project({
        members: [
          { sessionId: "gone", role: "worker", title: "Deleted worker" },
        ],
      }),
    ];
    await render();
    await selectProject();
    await click("Unlink Deleted worker");
    expect(api.save).not.toHaveBeenCalled();
    records[0] = {
      ...records[0],
      updatedAt: 2,
      members: [
        ...records[0].members,
        { sessionId: "fresh", role: "coordinator", title: "New coordinator" },
      ],
    };
    await click("Unlink worker");
    expect(records[0].members).toEqual([
      { sessionId: "fresh", role: "coordinator", title: "New coordinator" },
    ]);
    expect(props.onOpenSession).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it("starts reviewed coordinator and worker drafts and surfaces failures", async () => {
    await render();
    await selectProject();
    await click("Start coordinator");
    expect(props.onStartSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-1" }),
      "coordinator",
      expect.stringContaining("Ship a reliable release"),
      "Release readiness",
    );
    expect(api.save).not.toHaveBeenCalled();
    await click("Agents");
    await type("Task title", "Test release");
    await type("Task", "Run regression tests");
    vi.mocked(props.onStartSession).mockRejectedValueOnce(
      new Error("Provider unavailable"),
    );
    await click("Delegate task");
    expect(props.onStartSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "project-1" }),
      "worker",
      "Run regression tests",
      "Test release",
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Provider unavailable",
    );
    expect(
      document.querySelector<HTMLTextAreaElement>('[aria-label="Task"]')?.value,
    ).toBe("Run regression tests");
  });

  it("archives, restores and confirms deletion without deleting sessions or files", async () => {
    await render();
    await selectProject();
    await click("Archive");
    expect(records[0].archived).toBe(true);
    await click("Restore");
    expect(records[0].archived).toBe(false);
    await click("Delete");
    expect(api.remove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Existing chats and repository files are preserved",
    );
    await click("Confirm");
    expect(api.remove).toHaveBeenCalledExactlyOnceWith("project-1");
  });

  it("refreshes external membership updates and supports keyboard tabs", async () => {
    await render();
    await selectProject();
    records = [
      project({
        members: [
          { sessionId: "new-worker", title: "New worker", role: "worker" },
        ],
        updatedAt: 2,
      }),
    ];
    await act(async () => notify());
    expect(container.textContent).toContain("New worker");
    const overview = document.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    )!;
    await act(async () => {
      overview.focus();
      overview.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(document.activeElement?.textContent).toBe("Agents");
    expect(
      container
        .querySelector('[role="tabpanel"]')
        ?.getAttribute("aria-labelledby"),
    ).toBe("project-tab-Agents");
  });
});
