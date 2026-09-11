// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { newAgentProjectSession } from "./agentProjectSession";
import type { AgentProject } from "./agentProjects";

vi.mock("./session", () => ({
  newDefaultSession: (cwd: string, runtimeMode: string) => ({
    id: "session",
    cwd,
    runtimeMode,
    blocks: [],
  }),
}));

const project = {
  id: "project",
  cwd: "/work/repo",
  name: "Migration",
  archived: false,
} as AgentProject;

describe("project session creation", () => {
  it("creates a supervised draft without running or changing a normal chat", () => {
    const session = newAgentProjectSession(
      project,
      "  Plan the migration  ",
      "Coordinator",
    );
    expect(session).toMatchObject({
      cwd: "/work/repo",
      runtimeMode: "supervised",
      title: "Coordinator",
      composerSeed: "Plan the migration",
      blocks: [],
    });
  });

  it("rejects archived projects and empty tasks", () => {
    expect(() =>
      newAgentProjectSession({ ...project, archived: true }, "Task", "Worker"),
    ).toThrow("Restore");
    expect(() => newAgentProjectSession(project, "  ", "Worker")).toThrow(
      "Describe",
    );
  });

  it("bounds generated titles even for multibyte project names", () => {
    const session = newAgentProjectSession(project, "Task", "界".repeat(100));
    expect(new TextEncoder().encode(session.title).length).toBeLessThanOrEqual(
      200,
    );
  });
});
