import { leafIds, type WorkspaceTab } from "./layout";
import type { Session } from "./session";
import { pathKey } from "./paths";
import { workspaceTabProjectId } from "./workspaceTabGroups";

export type ProjectReturnMemory = ReadonlyMap<string, string>;

export function projectReturnKey(projectPath: string, projectId?: string): string {
  return projectId ? `project:${projectId}` : pathKey(projectPath);
}

type ProjectReturnContext = {
  memory: ProjectReturnMemory;
  tabs: WorkspaceTab[];
  sessions: Session[];
  activeTabId: string;
};

type PaneProject = Map<string, string>;

export type ProjectReturnDecision =
  | { action: "keep" }
  | { action: "activate"; tabId: string; paneId?: string }
  | { action: "reuse-blank"; sessionId: string }
  | { action: "create" };

export function isBlankSession(session: Session | undefined): boolean {
  if (!session || session.busy) return false;
  if (session.composerSeed) return false;
  return !session.blocks.some((block) => block.role === "user");
}

function paneProjects(
  tabs: readonly WorkspaceTab[],
  sessions: readonly Pick<Session, "id" | "cwd" | "projectId">[],
): PaneProject {
  const sessionById = new Map(
    sessions.map((session) => [session.id, session]),
  );
  const result = new Map<string, string>();

  for (const tab of tabs) {
    const tabProjectId = workspaceTabProjectId(tab, sessions);
    for (const paneId of leafIds(tab.layout)) {
      const session = sessionById.get(paneId);
      const projectId = session?.projectId ?? tabProjectId;
      if (projectId || (session?.cwd && session.cwd !== "~")) {
        result.set(paneId, projectReturnKey(session?.cwd ?? "~", projectId));
      }
    }

    for (const pane of tab.editorPanes) {
      const active = pane.files.find((file) => file.id === pane.activeFileId);
      if (tabProjectId || (active && active.cwd !== "~")) {
        result.set(pane.id, projectReturnKey(active?.cwd ?? "~", tabProjectId));
      }
    }

    for (const pane of tab.terminalPanes ?? []) {
      const active = pane.files.find((file) => file.id === pane.activeFileId);
      if (tabProjectId || (active && active.cwd !== "~")) {
        result.set(pane.id, projectReturnKey(active?.cwd ?? "~", tabProjectId));
      }
    }
  }

  return result;
}

function tabFocusedPaneById(tabs: readonly WorkspaceTab[]): Map<string, string> {
  return new Map(tabs.map((tab) => [tab.id, tab.focusedId]));
}

function paneBelongsToProject(
  paneId: string,
  target: string,
  paneById: PaneProject,
): boolean {
  const project = paneById.get(paneId);
  return !!project && project === target;
}

function paneForProjectInTab(
  tab: WorkspaceTab,
  target: string,
  paneById: PaneProject,
): string | undefined {
  for (const paneId of leafIds(tab.layout)) {
    if (paneById.get(paneId) === target) return paneId;
  }
  for (const pane of tab.editorPanes) {
    if (paneById.get(pane.id) === target) return pane.id;
  }
  for (const pane of tab.terminalPanes ?? []) {
    if (paneById.get(pane.id) === target) return pane.id;
  }
  return undefined;
}

function tabContainsPane(tab: WorkspaceTab, paneId: string): boolean {
  return (
    leafIds(tab.layout).includes(paneId) ||
    tab.editorPanes.some((pane) => pane.id === paneId) ||
    (tab.terminalPanes ?? []).some((pane) => pane.id === paneId)
  );
}

export function reconcileProjectReturn({
  memory,
  tabs,
  sessions,
  activeTabId,
}: Omit<ProjectReturnContext, "sessions"> & {
  sessions: readonly Pick<Session, "id" | "cwd" | "projectId">[];
}): ProjectReturnMemory {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const byPane = paneProjects(tabs, sessions);
  const byTab = tabFocusedPaneById(tabs);

  const next = new Map<string, string>();
  for (const [project, saved] of memory) {
    const asPane = byPane.get(saved);
    if (asPane === project) {
      next.set(project, saved);
      continue;
    }

    const focused = byTab.get(saved);
    if (!focused) continue;
    if (paneBelongsToProject(focused, project, byPane)) {
      next.set(project, focused);
    }
  }

  const activePaneId = activeTab?.focusedId;
  const activeProject = activePaneId ? byPane.get(activePaneId) : undefined;
  if (activeProject && activePaneId) next.set(activeProject, activePaneId);

  if (
    next.size === memory.size &&
    [...next].every(([project, id]) => memory.get(project) === id)
  )
    return memory;
  return next;
}

export function planProjectReturn({
  memory,
  tabs,
  sessions,
  activeTabId,
  projectPath,
  projectId,
}: ProjectReturnContext & { projectPath: string; projectId?: string }): ProjectReturnDecision {
  const target = projectReturnKey(projectPath, projectId);
  const byPane = paneProjects(tabs, sessions);
  const active = tabs.find((tab) => tab.id === activeTabId);

  if (active?.focusedId && paneBelongsToProject(active.focusedId, target, byPane)) {
    return { action: "keep" };
  }

  const remembered = memory.get(target);
  if (remembered) {
    const rememberedTab = tabs.find((tab) => tabContainsPane(tab, remembered));
    if (
      rememberedTab &&
      paneBelongsToProject(remembered, target, byPane)
    ) {
      return {
        action: "activate",
        tabId: rememberedTab.id,
        paneId: remembered,
      };
    }
  }

  for (const tab of tabs) {
    const paneId = paneForProjectInTab(tab, target, byPane);
    if (!paneId) continue;
    return { action: "activate", tabId: tab.id, paneId };
  }

  const current =
    active?.focusedId &&
    sessions.find((session) => session.id === active.focusedId);
  return current && !current.projectId && !active?.projectId && !projectId && isBlankSession(current)
    ? { action: "reuse-blank", sessionId: current.id }
    : { action: "create" };
}
