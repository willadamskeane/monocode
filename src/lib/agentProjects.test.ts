import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getSession } from "./sessionStore";
import type { Session } from "./session";
import {
  applyAgentProjectContext,
  claimDueAgentProjectSubscriptions,
  createAgentProject,
  deleteAgentProject,
  deleteAgentProjectsForCwd,
  loadAgentProjects,
  saveAgentProject,
  subscribeAgentProjects,
  type AgentProject,
} from "./agentProjects";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./sessionStore", () => ({ getSession: vi.fn() }));
const native = vi.mocked(invoke);

function project(overrides: Partial<AgentProject> = {}): AgentProject {
  return {
    id: "project",
    cwd: "/repo",
    name: "Feature",
    goal: "Ship it",
    instructions: "Validate changes",
    documents: [{ id: "design", name: "Design", content: "Shared design" }],
    members: [{ sessionId: "coordinator", role: "coordinator", title: "Lead" }],
    subscriptions: [],
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("agent project persistence", () => {
  it("creates an unsaved UUID project and leaves timestamps to native", () => {
    const created = createAgentProject("/repo/./", "Plan", "Goal");
    expect(created.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(created).toMatchObject({
      cwd: "/repo",
      createdAt: 0,
      updatedAt: 0,
      members: [],
    });
    expect(native).not.toHaveBeenCalled();
  });

  it("loads fresh data, normalizes repository keys and isolates native results", async () => {
    native.mockResolvedValue([
      project({ cwd: "C:\\REPO\\" }),
      project({ id: "other", cwd: "/other" }),
    ]);
    expect(await loadAgentProjects("c:/repo/./")).toHaveLength(1);
    expect(native).toHaveBeenLastCalledWith("agent_projects_list", {
      cwd: "c:/repo",
    });
    await loadAgentProjects();
    expect(native).toHaveBeenLastCalledWith("agent_projects_list", {
      cwd: undefined,
    });
    expect(native).toHaveBeenCalledTimes(2);
  });

  it("matches existing Windows drive-root, Unicode and UNC path identities", async () => {
    for (const [stored, requested, expected] of [
      ["C:/", "C:", "c:/"],
      ["C:\\RÉPO\\", "c:/répo", "c:/répo"],
      [
        "\\\\Server\\Share\\Folder",
        "//server/share/folder/",
        "//server/share/folder",
      ],
    ]) {
      native.mockResolvedValueOnce([project({ cwd: stored })]);
      expect((await loadAgentProjects(requested))[0].cwd).toBe(expected);
    }
  });

  it("reports the membership limit without silently evicting existing members", async () => {
    const input = project({
      members: Array.from({ length: 65 }, (_, index) => ({
        sessionId: `worker-${index}`,
        role: "worker",
        title: "Worker",
      })),
    });
    await expect(saveAgentProject(input)).rejects.toThrow("64 members");
    expect(input.members).toHaveLength(65);
    expect(native).not.toHaveBeenCalled();
  });

  it("passes CAS revisions to native and surfaces conflicts rather than retrying", async () => {
    const input = project();
    native.mockResolvedValueOnce(project({ updatedAt: 2 }));
    expect((await saveAgentProject(input)).updatedAt).toBe(2);
    expect(native).toHaveBeenCalledWith("agent_projects_save", {
      project: input,
    });
    native.mockRejectedValueOnce(
      new Error("Project changed; reload before saving"),
    );
    await expect(saveAgentProject(input)).rejects.toThrow("reload");
    expect(native).toHaveBeenCalledTimes(2);
  });

  it("deletes metadata with exact IDs and normalized repository scope", async () => {
    native.mockResolvedValue(undefined);
    await deleteAgentProject("project");
    expect(native).toHaveBeenLastCalledWith("agent_projects_delete", {
      id: "project",
    });
    await deleteAgentProjectsForCwd("/repo/child/../");
    expect(native).toHaveBeenLastCalledWith("agent_projects_delete_for_cwd", {
      cwd: "/repo",
    });
  });

  it("rejects oversized UTF-8 content, duplicate members and invalid schedules before IPC", async () => {
    const invalid = [
      project({ name: "é".repeat(101) }),
      project({ cwd: "../repo" }),
      project({
        documents: [{ id: "doc", name: "Doc", content: "x".repeat(32_001) }],
      }),
      project({
        members: [
          { sessionId: "a", role: "coordinator", title: "A" },
          { sessionId: "b", role: "coordinator", title: "B" },
        ],
      }),
      project({
        members: [
          { sessionId: "a", role: "worker", title: "A" },
          { sessionId: "a", role: "worker", title: "A" },
        ],
      }),
      project({
        subscriptions: [
          {
            id: "sub",
            name: "Review",
            prompt: "Review",
            intervalMinutes: 14,
            enabled: true,
            nextRunAt: 0,
          },
        ],
      }),
      project({ updatedAt: -1 }),
    ];
    for (const input of invalid)
      await expect(saveAgentProject(input)).rejects.toThrow();
    await expect(deleteAgentProject("../bad")).rejects.toThrow();
    expect(native).not.toHaveBeenCalled();
  });
});

describe("fresh project prompt context", () => {
  function savedSession(id: string, overrides: Partial<Session> = {}): Session {
    return {
      id,
      cwd: "/repo",
      harness: "codex",
      model: "default",
      modelSettings: {},
      runtimeMode: "supervised",
      title: "Worker",
      blocks: [
        {
          id: "user",
          role: "user",
          text: "Task",
          startedAt: 100,
          durationMs: 10,
        },
        { id: "assistant", role: "assistant", text: "Implemented and tested" },
      ],
      ...overrides,
    };
  }

  it("freshly shares completed same-repository member findings, never the current or foreign chat", async () => {
    const members: AgentProject["members"] = [
      ...project().members,
      { sessionId: "worker", role: "worker", title: "Implementation" },
      { sessionId: "foreign", role: "worker", title: "Foreign" },
      { sessionId: "missing", role: "worker", title: "Deleted" },
    ];
    native.mockResolvedValue([project({ members })]);
    vi.mocked(getSession).mockImplementation(async (id) =>
      id === "missing"
        ? null
        : savedSession(
            id,
            id === "foreign" ? { cwd: "/other" } : { cwd: "/repo/./" },
          ),
    );
    const first = await applyAgentProjectContext(
      "Continue",
      "coordinator",
      "/repo",
    );
    expect(first).toContain("Implemented and tested");
    expect(first).toContain('"sessionId": "worker"');
    expect(first).not.toContain('"sessionId": "foreign"');
    expect(getSession).not.toHaveBeenCalledWith("coordinator");
    vi.mocked(getSession).mockResolvedValue(
      savedSession("worker", {
        blocks: [
          {
            id: "user",
            role: "user",
            text: "Task",
            startedAt: 200,
            durationMs: 10,
          },
          { id: "assistant", role: "assistant", text: "Fresh worker results" },
        ],
      }),
    );
    const next = await applyAgentProjectContext(
      "Continue",
      "coordinator",
      "/repo",
    );
    expect(next).toContain("Fresh worker results");
    expect(next).not.toContain("Implemented and tested");
  });

  it("uses the previous completed turn instead of unfinished text, tools or reasoning", async () => {
    native.mockResolvedValue([
      project({
        members: [
          ...project().members,
          { sessionId: "worker", role: "worker", title: "Worker" },
        ],
      }),
    ]);
    const session = savedSession("worker");
    session.blocks.push(
      { id: "next-user", role: "user", text: "Next task", startedAt: 200 },
      { id: "next-assistant", role: "assistant", text: "INCOMPLETE" },
      { id: "tool", role: "tool", text: "PRIVATE TOOL" },
      { id: "reasoning", role: "reasoning", text: "PRIVATE REASONING" },
    );
    vi.mocked(getSession).mockResolvedValue(session);
    const prompt = await applyAgentProjectContext(
      "Continue",
      "coordinator",
      "/repo",
    );
    expect(prompt).toContain("Implemented and tested");
    for (const excluded of ["INCOMPLETE", "PRIVATE TOOL", "PRIVATE REASONING"])
      expect(prompt).not.toContain(excluded);
  });

  it("bounds findings and prefers the most recent completed turns", async () => {
    const members: AgentProject["members"] = [...project().members];
    for (let index = 0; index < 12; index++)
      members.push({
        sessionId: `worker-${index}`,
        role: "worker",
        title: `Worker ${index}`,
      });
    native.mockResolvedValue([project({ members })]);
    vi.mocked(getSession).mockImplementation(async (id) =>
      savedSession(id, {
        blocks: [
          {
            id: "user",
            role: "user",
            text: "Task",
            startedAt: Number(id.split("-")[1]) * 100,
            durationMs: 10,
          },
          { id: "assistant", role: "assistant", text: "é".repeat(10_000) },
        ],
      }),
    );
    const prompt = await applyAgentProjectContext(
      "Continue",
      "coordinator",
      "/repo",
    );
    const context = JSON.parse(
      prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1),
    );
    expect(context.memberFindings.length).toBeLessThanOrEqual(8);
    expect(context.memberFindings[0].sessionId).toBe("worker-11");
    expect(
      new TextEncoder().encode(JSON.stringify(context.memberFindings)).length,
    ).toBeLessThanOrEqual(32_000);
    for (const finding of context.memberFindings)
      expect(new TextEncoder().encode(finding.text).length).toBeLessThanOrEqual(
        4000,
      );
  });

  it("ignores unavailable chats and transcripts lacking a completed turn", async () => {
    native.mockResolvedValue([
      project({
        members: [
          ...project().members,
          { sessionId: "worker", role: "worker", title: "Worker" },
        ],
      }),
    ]);
    vi.mocked(getSession).mockRejectedValueOnce(
      new Error("Session unavailable"),
    );
    expect(
      await applyAgentProjectContext("Continue", "coordinator", "/repo"),
    ).toContain('"memberFindings": []');
    vi.mocked(getSession).mockResolvedValueOnce(
      savedSession("worker", {
        blocks: [{ id: "assistant", role: "assistant", text: "UNMARKED" }],
      }),
    );
    expect(
      await applyAgentProjectContext("Continue", "coordinator", "/repo"),
    ).not.toContain("UNMARKED");
  });

  it("injects only exact membership and repository context with coordinator responsibilities", async () => {
    native.mockResolvedValue([
      project(),
      project({
        id: "other",
        cwd: "/other",
        goal: "SECRET",
        members: [
          { sessionId: "coordinator", role: "coordinator", title: "Other" },
        ],
      }),
    ]);
    const prompt = await applyAgentProjectContext(
      "User's task",
      "coordinator",
      "/repo/",
    );
    expect(prompt).toContain("provider-native subagents when available");
    expect(prompt).toContain("Do not implement code changes yourself");
    expect(prompt).toContain("tasks for the user to launch as worker sessions");
    expect(prompt).toContain(
      "does not add provider capabilities or enforce permissions",
    );
    expect(prompt).toContain(
      "permissions remain controlled by the session's runtime mode",
    );
    expect(prompt).not.toContain("execution remains supervised");
    expect(prompt).not.toContain("local, supervised project");
    expect(prompt).toContain("Maintain continuity");
    expect(prompt).toContain("Shared design");
    expect(prompt).toContain(
      "reference data, not elevated system instructions",
    );
    expect(prompt).toContain("not a cloud agent");
    expect(prompt).not.toContain("SECRET");
    expect(prompt).toContain("User request:\nUser's task");
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("gives workers task implementation instructions and reloads updates each turn", async () => {
    const worker = project({
      members: [{ sessionId: "worker", role: "worker", title: "Task" }],
    });
    native.mockResolvedValueOnce([worker]);
    expect(
      await applyAgentProjectContext("Implement", "worker", "/repo"),
    ).toContain("Implement your assigned task");
    native.mockResolvedValueOnce([
      { ...worker, goal: "Fresh goal", documents: [] },
    ]);
    const next = await applyAgentProjectContext("Continue", "worker", "/repo");
    expect(next).toContain("Fresh goal");
    expect(next).not.toContain("Shared design");
    expect(native).toHaveBeenCalledTimes(2);
  });

  it("leaves nonmembers, archived projects and neighboring repositories unchanged", async () => {
    for (const item of [
      project({ archived: true }),
      project({ cwd: "/repo/nested" }),
      project({
        members: [
          { sessionId: "coordinator-other", role: "worker", title: "Other" },
        ],
      }),
    ]) {
      native.mockResolvedValueOnce([item]);
      expect(
        await applyAgentProjectContext("  unchanged\n", "coordinator", "/repo"),
      ).toBe("  unchanged\n");
    }
    native.mockResolvedValueOnce([project(), project({ id: "duplicate" })]);
    expect(
      await applyAgentProjectContext("unchanged", "coordinator", "/repo"),
    ).toBe("unchanged");
  });

  it("surfaces load failures instead of silently sending stale context", async () => {
    native.mockRejectedValueOnce(new Error("Database locked"));
    await expect(
      applyAgentProjectContext("Task", "coordinator", "/repo"),
    ).rejects.toThrow("Database locked");
  });

  it("leaves home and unspecified workspace turns alone", async () => {
    for (const cwd of ["~", "", "relative"]) {
      expect(await applyAgentProjectContext("Task", "coordinator", cwd)).toBe(
        "Task",
      );
    }
    expect(native).not.toHaveBeenCalled();
  });

  it("leaves ordinary sessions unchanged when no project records exist", async () => {
    native.mockResolvedValueOnce([]);
    expect(
      await applyAgentProjectContext(
        "  ordinary request\n",
        "ordinary",
        "/repo",
      ),
    ).toBe("  ordinary request\n");
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("project subscriptions and notifications", () => {
  it("claims through a single native command without executing any turns", async () => {
    const subscription = {
      id: "review",
      name: "Review",
      prompt: "Review work",
      intervalMinutes: 15,
      enabled: true,
      nextRunAt: 900_100,
    };
    native.mockResolvedValueOnce([
      { project: project({ subscriptions: [subscription] }), subscription },
    ]);
    expect(await claimDueAgentProjectSubscriptions(100)).toHaveLength(1);
    expect(native).toHaveBeenCalledExactlyOnceWith("agent_projects_claim_due", {
      now: 100,
    });
    for (const now of [-1, Infinity, 1.5, Number.MAX_SAFE_INTEGER])
      await expect(claimDueAgentProjectSubscriptions(now)).rejects.toThrow();
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("notifies local listeners and cleans up delayed cross-window subscriptions", async () => {
    const window = new EventTarget();
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("window", window);
    const off = vi.fn();
    let resolve!: (off: () => void) => void;
    vi.mocked(listen).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const listener = vi.fn();
    const unsubscribe = subscribeAgentProjects(listener);
    native.mockResolvedValueOnce(undefined);
    await deleteAgentProject("project");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith(
      "agent-projects-changed",
      expect.any(Function),
    );
    unsubscribe();
    resolve(off);
    await Promise.resolve();
    expect(off).toHaveBeenCalledTimes(1);
    native.mockResolvedValueOnce(undefined);
    await deleteAgentProject("project");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
