import { leafIds, type WorkspaceTab } from "./layout";
import type { ProjectTerminalDock } from "./projectTerminal";
import type { Session } from "./session";
import { workspaceTabCwd, workspaceTabProjectId } from "./workspaceTabGroups";

export type WindowTransferPayload = {
  tabs: WorkspaceTab[];
  sessions: Session[];
  activeTabId: string;
  projectCwd: string;
  activeProjectId?: string;
  dirtyFileIds: string[];
  projectTerminals?: ProjectTerminalDock[];
};

export function collectWindowTransfer(
  tabs: WorkspaceTab[],
  sessions: Session[],
  tabIds: string[],
  activeTabId: string,
  dirtyFiles: Set<string>,
  fallbackCwd: string,
  projectTerminals: ProjectTerminalDock[] = [],
  activeProjectId?: string,
): WindowTransferPayload | null {
  const idSet = new Set(tabIds);
  const movingTabs = tabs.filter((tab) => idSet.has(tab.id));
  if (movingTabs.length === 0) return null;

  const sessionIds = new Set<string>();
  for (const tab of movingTabs) {
    for (const id of leafIds(tab.layout)) sessionIds.add(id);
  }

  const movingSessions = sessions.filter((session) => sessionIds.has(session.id));
  const dirtyInTabs = new Set<string>();
  for (const tab of movingTabs) {
    for (const pane of [...tab.editorPanes, ...(tab.terminalPanes ?? [])]) {
      for (const file of pane.files) {
        if (dirtyFiles.has(file.id)) dirtyInTabs.add(file.id);
      }
    }
  }

  const activeTabIdInGroup = idSet.has(activeTabId)
    ? activeTabId
    : movingTabs[0].id;
  const activeTab = movingTabs.find((tab) => tab.id === activeTabIdInGroup)!;
  const projectId = workspaceTabProjectId(activeTab, movingSessions) ??
    (activeTabIdInGroup === activeTabId ? activeProjectId : undefined);

  return {
    tabs: movingTabs,
    sessions: movingSessions,
    activeTabId: activeTabIdInGroup,
    projectCwd: workspaceTabCwd(activeTab, movingSessions) ?? fallbackCwd,
    ...(projectId ? { activeProjectId: projectId } : {}),
    dirtyFileIds: [...dirtyInTabs],
    ...(projectTerminals.length > 0 ? { projectTerminals } : {}),
  };
}
