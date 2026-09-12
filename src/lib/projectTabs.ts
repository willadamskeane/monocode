import { leafIds, type WorkspaceTab } from "./layout";
import { coordinatorMember, type AgentProject } from "./agentProjects";
import type { Session } from "./session";

export function tabHoldsSession(
  tab: WorkspaceTab,
  sessionId: string,
): boolean {
  return leafIds(tab.layout).includes(sessionId);
}

export function coordinatorTab(
  tabs: readonly WorkspaceTab[],
  project: AgentProject | undefined,
): WorkspaceTab | undefined {
  const coordinator = project ? coordinatorMember(project) : undefined;
  if (!coordinator) return undefined;
  return tabs.find((tab) => tabHoldsSession(tab, coordinator.sessionId));
}

/** Cursor: the Project tab stays first and is the way home. */
export function orderTabsWithCoordinatorFirst(
  tabs: readonly WorkspaceTab[],
  project: AgentProject | undefined,
): WorkspaceTab[] {
  const home = coordinatorTab(tabs, project);
  if (!home) return [...tabs];
  return [home, ...tabs.filter((tab) => tab.id !== home.id)];
}

export function sessionBelongsToProject(
  session: Pick<Session, "id" | "projectId">,
  project: AgentProject | undefined,
): boolean {
  if (!project) return false;
  if (session.projectId === project.id) return true;
  return project.members.some((member) => member.sessionId === session.id);
}

/** Never reuse the coordinator leaf for another chat, even while it is still a draft. */
export function isCoordinatorLeaf(
  paneId: string,
  project: AgentProject | undefined,
): boolean {
  const coordinator = project ? coordinatorMember(project) : undefined;
  return coordinator?.sessionId === paneId;
}
