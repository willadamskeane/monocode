import { describe, expect, it } from "vitest";
import {
  resolveActiveAgentProject,
  restoreProjectOwnership,
} from "./appProjectState";
import type { AgentProject } from "./agentProjects";
import type { Session } from "./session";

const project = (
  overrides: Partial<AgentProject> & Pick<AgentProject, "id" | "cwd">,
): AgentProject => ({
  name: overrides.id,
  goal: "",
  instructions: "",
  documents: [],
  members: [],
  subscriptions: [],
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const session = (
  overrides: Partial<Session> & Pick<Session, "id" | "cwd">,
): Session =>
  ({
    harness: "claude",
    model: "opus",
    modelSettings: {},
    runtimeMode: "supervised",
    title: overrides.id,
    blocks: [],
    ...overrides,
  }) as Session;

describe("restoreProjectOwnership", () => {
  it("keeps an explicit owner and stamps membership or the folder default", () => {
    const alpha = project({
      id: "alpha",
      cwd: "/repo",
      legacyDefault: true,
    });
    const beta = project({
      id: "beta",
      cwd: "/repo",
      members: [{ sessionId: "worker", role: "worker", title: "Task" }],
    });
    const next = restoreProjectOwnership(
      [
        session({ id: "owned", cwd: "/repo", projectId: "beta" }),
        session({ id: "worker", cwd: "/repo" }),
        session({ id: "chat", cwd: "/repo" }),
        session({ id: "home", cwd: "~" }),
      ],
      [alpha, beta],
    );
    expect(next.map((entry) => entry.projectId)).toEqual([
      "beta",
      "beta",
      "alpha",
      undefined,
    ]);
  });
});

describe("resolveActiveAgentProject", () => {
  it("prefers the requested project, then the folder default", () => {
    const alpha = project({ id: "alpha", cwd: "/repo", legacyDefault: true });
    const beta = project({ id: "beta", cwd: "/repo" });
    const other = project({ id: "other", cwd: "/other" });
    expect(resolveActiveAgentProject([alpha, beta, other], "beta", "/repo")?.id).toBe(
      "beta",
    );
    expect(resolveActiveAgentProject([alpha, beta, other], undefined, "/repo")?.id).toBe(
      "alpha",
    );
    expect(
      resolveActiveAgentProject(
        [{ ...alpha, archived: true }, beta],
        "alpha",
        "/repo",
      )?.id,
    ).toBe("beta");
  });
});
