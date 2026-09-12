import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeProjectData } from "./projectData";
import { deleteAgentProjectsForCwd } from "./agentProjects";
import { deleteSession, listSessionsByProject } from "./sessionStore";

vi.mock("./agentProjects", () => ({ deleteAgentProjectsForCwd: vi.fn() }));
vi.mock("./sessionStore", () => ({
  deleteSession: vi.fn(),
  listSessionsByProject: vi.fn(),
}));
vi.mock("./projectLogos", () => ({
  clearProjectLogo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./chatBackground", () => ({
  clearProjectChatBackground: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./projectChatBackground", () => ({
  clearProjectChatBackgroundSetting: vi.fn(),
}));
vi.mock("./tabGroups", () => ({ clearTabGroupSettings: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(deleteAgentProjectsForCwd).mockResolvedValue(undefined);
  vi.mocked(listSessionsByProject).mockResolvedValue([]);
});

describe("project data removal", () => {
  it("removes agent context and subscriptions before deleting saved chats", async () => {
    await removeProjectData("/work/repo/");
    expect(deleteAgentProjectsForCwd).toHaveBeenCalledWith("/work/repo");
    expect(
      vi.mocked(deleteAgentProjectsForCwd).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(listSessionsByProject).mock.invocationCallOrder[0]!,
    );
  });

  it("reports cleanup failures instead of leaving subscriptions silently active", async () => {
    vi.mocked(deleteAgentProjectsForCwd).mockRejectedValue(
      new Error("Database locked"),
    );
    await expect(removeProjectData("/work/repo")).rejects.toThrow(
      "Database locked",
    );
    expect(deleteSession).not.toHaveBeenCalled();
  });
});
