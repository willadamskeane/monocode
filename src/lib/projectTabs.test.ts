import { describe, expect, it } from "vitest";
import { leaf, type WorkspaceTab } from "./layout";
import type { AgentProject } from "./agentProjects";
import {
  isCoordinatorLeaf,
  orderTabsWithCoordinatorFirst,
  sessionBelongsToProject,
} from "./projectTabs";

const tab = (id: string, sessionId: string): WorkspaceTab => ({
  kind: "session",
  id,
  layout: leaf(sessionId),
  focusedId: sessionId,
  editorPanes: [],
  terminalPanes: [],
});

const project = (overrides: Partial<AgentProject> = {}): AgentProject => ({
  id: "proj",
  cwd: "/repo",
  name: "Vault",
  goal: "Ship it",
  instructions: "",
  documents: [],
  members: [
    { sessionId: "coord", role: "coordinator", title: "Vault" },
    { sessionId: "worker", role: "worker", title: "Build" },
  ],
  subscriptions: [],
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe("orderTabsWithCoordinatorFirst", () => {
  it("pins the coordinator tab at the front", () => {
    const tabs = [tab("w", "worker"), tab("c", "coord"), tab("other", "chat")];
    expect(
      orderTabsWithCoordinatorFirst(tabs, project()).map((item) => item.id),
    ).toEqual(["c", "w", "other"]);
  });

  it("leaves workspace tabs alone when there is no coordinator", () => {
    const tabs = [tab("a", "a"), tab("b", "b")];
    expect(orderTabsWithCoordinatorFirst(tabs, undefined)).toEqual(tabs);
  });
});

describe("sessionBelongsToProject", () => {
  it("matches membership or stamped project id", () => {
    const vault = project();
    expect(sessionBelongsToProject({ id: "coord", projectId: "proj" }, vault)).toBe(
      true,
    );
    expect(sessionBelongsToProject({ id: "worker" }, vault)).toBe(true);
    expect(sessionBelongsToProject({ id: "stranger", projectId: "other" }, vault)).toBe(
      false,
    );
  });
});

describe("isCoordinatorLeaf", () => {
  it("protects the coordinator session id", () => {
    expect(isCoordinatorLeaf("coord", project())).toBe(true);
    expect(isCoordinatorLeaf("worker", project())).toBe(false);
  });
});
