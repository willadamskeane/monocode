import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FolderOpen,
  ImagePlus,
  Inbox,
  MoreHorizontal,
  Pin,
  PinOff,
  File,
  Plus,
  Search,
  Settings,
  Trash2,
} from "./icons";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useDragResize } from "../hooks/useDragResize";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useProjectDiffStats } from "../hooks/useProjectDiffStats";
import { useSortable } from "../hooks/useSortable";
import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import {
  loadProjectRailWidth,
  PROJECT_RAIL_WIDTH_DEFAULT,
  PROJECT_RAIL_WIDTH_MAX,
  PROJECT_RAIL_WIDTH_MIN,
  saveProjectRailWidth,
} from "../lib/appearance";
import { basename, revealPath, type GitDiffStats } from "../lib/fs";
import { IS_MAC, IS_WIN, MOD } from "../lib/platform";
import { projectKey, projectName } from "../lib/paths";
import {
  collectRailProjects,
  loadPinnedProjects,
  loadProjectRailOrder,
  projectRailSections,
  sameProjectPath,
  savePinnedProjects,
  saveProjectRailOrder,
  syncProjectRailOrder,
  type RecentProject,
} from "../lib/recents";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupColorIndex,
  resolveTabGroupCustomColor,
  resolveTabGroupLabel,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
  saveTabGroupColor,
  saveTabGroupCustomColor,
  saveTabGroupLabel,
  saveTabGroupMascot,
} from "../lib/tabGroups";
import { formatLiveElapsed, type LiveAgent } from "../lib/liveAgents";
import { HarnessIcon } from "./HarnessIcon";
import { ProjectLogoIcon } from "./ProjectLogoIcon";
import { ProjectBackgroundDialog } from "./ProjectBackgroundDialog";
import { ProjectMascot } from "./ProjectMascot";
import { RailAction, RailSearch } from "./RailAction";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { DevModeSlot, TabVisitNav } from "./TitleBar";
import { SidebarUpdateFooter } from "./SidebarUpdate";
import type { InstalledUpdate } from "../lib/updateNotice";
import { SettingsNav } from "./SettingsRail";
import { Shimmer } from "../surfaces/Shimmer";
import { TabGroupMenu, type TabGroupMenuExtraItem } from "./TabGroupMenu";
import { TerminalSpinner } from "./TerminalSpinner";
import type { SettingsSectionId } from "../lib/settings";
import { isWorkspaceProject, type AgentProject } from "../lib/agentProjects";
import {
  loadProjectOrder,
  saveProjectOrder,
  loadPinnedProjectIds,
  savePinnedProjectIds,
} from "../lib/projectIdentity";

export type AgentProjectNavigationProps = {
  agentProjects?: AgentProject[];
  activeProjectId?: string;
  onSelectAgentProject?: (id: string) => void;
  onCreateAgentProject?: () => void;
  onProjectOverview?: () => void;
  onArchiveAgentProject?: (id: string, archived: boolean) => void;
  onDeleteAgentProject?: (id: string) => void;
  onRenameAgentProject?: (id: string, name: string) => void;
  busyProjectIds?: ReadonlySet<string>;
  approvalProjectIds?: ReadonlySet<string>;
};

type ProjectItem = RecentProject & {
  id?: string;
  name?: string;
  goal?: string;
  workspace?: boolean;
};
const itemId = (item: ProjectItem) => item.id ?? item.path;

function formatProjectAge(value: number, now: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const seconds = Math.max(0, Math.round((now - value) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(new Date(value));
  } catch {
    return "";
  }
}

const REVEAL_LABEL = IS_MAC
  ? "Reveal in Finder"
  : IS_WIN
    ? "Reveal in File Explorer"
    : "Open Containing Folder";

function projectMenuExtraItems(
  pinned: boolean,
  canRemove: boolean,
): TabGroupMenuExtraItem[] {
  const items: TabGroupMenuExtraItem[] = [
    {
      id: "background",
      label: "Background image",
      icon: ImagePlus,
    },
    pinned
      ? { id: "unpin", label: "Unpin project", icon: PinOff }
      : { id: "pin", label: "Pin project", icon: Pin },
    { id: "reveal", label: REVEAL_LABEL, icon: FolderOpen },
  ];
  if (canRemove) {
    items.push(
      { id: "archive", label: "Archive", icon: Archive, sepBefore: true },
      { id: "delete", label: "Delete", icon: Trash2, danger: true },
    );
  }
  return items;
}

type Props = AgentProjectNavigationProps & {
  cwd: string;
  recents: RecentProject[];
  inboxUnseen?: boolean;
  busyPaths?: Iterable<string>;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onSearch?: () => void;
  searchActive?: boolean;
  onOpenInbox?: () => void;
  inboxActive?: boolean;
  notesEnabled?: boolean;
  onOpenNotes?: () => void;
  notesActive?: boolean;
  onTogglePanel?: () => void;
  onSelectProject: (path: string) => void;
  onOpenProject: () => void;
  onRemoveProject?: (path: string, options: { purgeData: boolean }) => void;
  liveAgents?: LiveAgent[];
  activeSessionId?: string;
  onSelectAgent?: (sessionId: string) => void;
  settingsOpen?: boolean;
  settingsSection?: SettingsSectionId;
  onOpenSettings?: () => void;
  onSelectSettingsSection?: (section: SettingsSectionId) => void;
  onCloseSettings?: () => void;
  updateNotice?: InstalledUpdate | null;
  onOpenWhatsNew?: (version: string) => void;
  onDismissUpdate?: () => void;
};

export function ProjectRail({
  cwd,
  recents,
  inboxUnseen = false,
  busyPaths,
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  onSearch,
  searchActive = false,
  onOpenInbox,
  inboxActive = false,
  notesEnabled = true,
  onOpenNotes,
  agentProjects,
  activeProjectId,
  onSelectAgentProject,
  onCreateAgentProject,
  onProjectOverview,
  onArchiveAgentProject,
  onDeleteAgentProject,
  onRenameAgentProject,
  busyProjectIds,
  approvalProjectIds,
  notesActive = false,
  onTogglePanel,
  onSelectProject,
  onOpenProject,
  onRemoveProject,
  liveAgents = [],
  activeSessionId,
  onSelectAgent,
  settingsOpen = false,
  settingsSection = "general",
  onOpenSettings,
  onSelectSettingsSection,
  onCloseSettings,
  updateNotice = null,
  onOpenWhatsNew,
  onDismissUpdate,
}: Props) {
  const resize = useDragResize({
    min: PROJECT_RAIL_WIDTH_MIN,
    max: () =>
      Math.min(PROJECT_RAIL_WIDTH_MAX, Math.floor(window.innerWidth * 0.35)),
    defaultWidth: PROJECT_RAIL_WIDTH_DEFAULT,
    initial: loadProjectRailWidth(),
    onCommit: saveProjectRailWidth,
  });
  const [railOrder, setRailOrder] = useState(loadProjectRailOrder);
  const [pinnedPaths, setPinnedPaths] = useState(loadPinnedProjects);
  const [idOrder, setIdOrder] = useState(loadProjectOrder);
  const [pinnedProjectIds, setPinnedProjectIds] = useState(loadPinnedProjectIds);
  const [now, setNow] = useState(() => Date.now());
  const [groupLabels, setGroupLabels] = useState(loadTabGroupLabels);
  const [groupColors, setGroupColors] = useState(loadTabGroupColors);
  const [groupMascots, setGroupMascots] = useState(loadTabGroupMascots);
  const [groupCustomColors, setGroupCustomColors] = useState(
    loadTabGroupCustomColors,
  );
  const [projectMenu, setProjectMenu] = useState<{
    x: number;
    y: number;
    path: string;
    id?: string;
    name?: string;
    projectKey: string;
  } | null>(null);
  const [removing, setRemoving] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [backgroundProject, setBackgroundProject] = useState<{
    project: string;
    name: string;
  } | null>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const groupLogos = useTabGroupLogos();
  const allProjects = useMemo(
    () => collectRailProjects(recents, cwd),
    [cwd, recents],
  );
  const sections = useMemo(() => {
    if (!agentProjects) return projectRailSections(recents, cwd, railOrder, pinnedPaths);
    const records = agentProjects.filter((project) => !project.archived);
    const order = [...idOrder, ...records.map((project) => project.id).filter((id) => !idOrder.includes(id))];
    const items: ProjectItem[] = order.flatMap((id) => {
      const project = records.find((record) => record.id === id);
      return project
        ? [{
            id,
            name: project.name,
            path: project.cwd,
            openedAt: project.updatedAt,
            goal: project.goal,
            workspace: isWorkspaceProject(project),
          }]
        : [];
    });
    const pinned = new Set(pinnedProjectIds);
    return {
      pinned: items.filter((item) => pinned.has(item.id!)),
      projects: items.filter((item) => !pinned.has(item.id!)),
    };
  }, [agentProjects, idOrder, pinnedProjectIds, cwd, pinnedPaths, railOrder, recents]);
  const selectProject = (id: string) => agentProjects ? onSelectAgentProject?.(id) : onSelectProject(id);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (!agentProjects) return;
    setIdOrder((previous) => {
      const next = [...previous.filter((id) => agentProjects.some((project) => project.id === id)), ...agentProjects.map((project) => project.id).filter((id) => !previous.includes(id))];
      if (next.join("\0") === previous.join("\0")) return previous;
      saveProjectOrder(next);
      return next;
    });
  }, [agentProjects]);
  const busy = useMemo(() => {
    const set = new Set<string>();
    for (const path of busyPaths ?? []) set.add(path);
    return set;
  }, [busyPaths]);

  useEffect(() => {
    setRailOrder((prev) => {
      const synced = syncProjectRailOrder(prev, allProjects);
      if (synced.join("\0") === prev.join("\0")) return prev;
      saveProjectRailOrder(synced);
      return synced;
    });
  }, [allProjects]);

  useEffect(() => {
    setPinnedPaths((prev) => {
      const next = prev.filter((path) => allProjects.has(path));
      if (next.length === prev.length) return prev;
      savePinnedProjects(next);
      return next;
    });
  }, [allProjects]);

  useEffect(() => {
    if (!projectMenu) return;
    const onScroll = () => setProjectMenu(null);
    const scrollParent = scrollRef.current ?? window;
    scrollParent.addEventListener("scroll", onScroll, true);
    return () => scrollParent.removeEventListener("scroll", onScroll, true);
  }, [projectMenu]);

  const openProjectMenu = (id: string, x: number, y: number) => {
    const record = agentProjects?.find((project) => project.id === id);
    const path = record?.cwd ?? id;
    setProjectMenu({
      x,
      y,
      path,
      id: record?.id,
      name: record?.name,
      projectKey: record ? `project:${record.id}` : projectKey(path),
    });
  };

  const onProjectContextMenu = (
    path: string,
    event: MouseEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openProjectMenu(path, event.clientX, event.clientY);
  };

  const onProjectRename = (projectKey: string, label: string) => {
    if (projectMenu?.id) {
      if (label.trim()) onRenameAgentProject?.(projectMenu.id, label.trim());
      return;
    }
    saveTabGroupLabel(projectKey, label);
    setGroupLabels(loadTabGroupLabels());
  };

  const onProjectColorChange = (
    projectKey: string,
    colorIndex: number | null,
  ) => {
    saveTabGroupColor(projectKey, colorIndex);
    setGroupColors(loadTabGroupColors());
    setGroupCustomColors(loadTabGroupCustomColors());
  };

  const onProjectMascotChange = (projectKey: string, name: string | null) => {
    saveTabGroupMascot(projectKey, name);
    setGroupMascots(loadTabGroupMascots());
  };

  const onProjectCustomColorChange = (projectKey: string, color: string) => {
    saveTabGroupCustomColor(projectKey, color);
    setGroupColors(loadTabGroupColors());
    setGroupCustomColors(loadTabGroupCustomColors());
  };

  const reorderSubset = (
    fullOrder: string[],
    subsetOrder: string[],
    subsetPaths: Set<string>,
  ) => {
    const next: string[] = [];
    let subsetIndex = 0;
    for (const path of fullOrder) {
      if (!subsetPaths.has(path)) {
        next.push(path);
        continue;
      }
      if (subsetIndex < subsetOrder.length) {
        next.push(subsetOrder[subsetIndex++]);
      }
    }
    return next;
  };

  const onReorderPinned = (ids: string[]) => {
    const subset = new Set(sections.pinned.map(itemId));
    const next = reorderSubset(agentProjects ? idOrder : railOrder, ids, subset);
    if (agentProjects) {
      setIdOrder(next);
      saveProjectOrder(next);
      return;
    }
    setRailOrder(next);
    saveProjectRailOrder(next);
  };

  const onReorderProjects = (ids: string[]) => {
    const subset = new Set(sections.projects.map(itemId));
    const next = reorderSubset(agentProjects ? idOrder : railOrder, ids, subset);
    if (agentProjects) {
      setIdOrder(next);
      saveProjectOrder(next);
      return;
    }
    setRailOrder(next);
    saveProjectRailOrder(next);
  };

  const onTogglePin = (path: string) => {
    if (agentProjects) {
      const next = pinnedProjectIds.includes(path)
        ? pinnedProjectIds.filter((id) => id !== path)
        : [...pinnedProjectIds, path];
      setPinnedProjectIds(next);
      savePinnedProjectIds(next);
      return;
    }
    const isPinned = pinnedPaths.some((pinned) =>
      sameProjectPath(pinned, path),
    );
    const next = isPinned
      ? pinnedPaths.filter((pinned) => !sameProjectPath(pinned, path))
      : [...pinnedPaths, path];
    setPinnedPaths(next);
    savePinnedProjects(next);
  };

  const onProjectMenuPick = (action: string) => {
    if (!projectMenu) return;
    const { path, projectKey, id, name } = projectMenu;
    if (action === "pin" || action === "unpin") onTogglePin(id ?? path);
    else if (action === "overview") {
      if (id) onSelectAgentProject?.(id);
      onProjectOverview?.();
    }
    else if (action === "background") {
      setBackgroundProject({
        project: projectKey,
        name: name ?? resolveTabGroupLabel(projectKey, groupLabels, basename(path)),
      });
    } else if (action === "reveal") void revealPath(path);
    else if (action === "archive") {
      if (id) onArchiveAgentProject?.(id, true);
      else onRemoveProject?.(path, { purgeData: false });
    } else if (action === "delete") {
      if (id) {
        onDeleteAgentProject?.(id);
        return;
      }
      setRemoving({
        path,
        name: resolveTabGroupLabel(projectKey, groupLabels, basename(path)),
      });
    }
  };

  const onConfirmDelete = () => {
    if (!removing) return;
    onRemoveProject?.(removing.path, { purgeData: true });
    setRemoving(null);
  };

  const pinnedIds = sections.pinned.map(itemId);
  const projectIds = sections.projects.map(itemId);
  const pinnedSortable = useSortable(pinnedIds, onReorderPinned, {
    axis: "y",
    onActivate: selectProject,
  });
  const projectSortable = useSortable(projectIds, onReorderProjects, {
    axis: "y",
    onActivate: selectProject,
  });
  return (
    <nav
      ref={resize.setPaneRef}
      aria-label="Projects"
      className="sidebar-glass relative flex shrink-0 flex-col border-r border-content/10"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center pr-1.5"
        data-tauri-drag-region="deep"
      >
        {IS_MAC ? <div className="w-[78px] shrink-0" /> : null}
        <DevModeSlot />
        <TabVisitNav
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={onGoBack}
          onGoForward={onGoForward}
          onTogglePanel={settingsOpen ? undefined : onTogglePanel}
          panelActive
        />
      </div>

      {settingsOpen ? (
        <SettingsNav
          section={settingsSection}
          onSelect={(next) => onSelectSettingsSection?.(next)}
          onClose={() => onCloseSettings?.()}
        />
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-px px-2 pb-2 pt-0.5">
            <RailSearch
              label="Search"
              icon={Search}
              onClick={onSearch}
              active={searchActive}
              shortcut={`${MOD}K`}
              ariaLabel={`Search (${MOD}K)`}
            />
            <div className="mt-0.5" />
            <RailAction
              label="Inbox"
              icon={Inbox}
              onClick={onOpenInbox}
              active={inboxActive}
              dot={inboxUnseen}
              ariaLabel={inboxUnseen ? "Inbox, new items" : "Inbox"}
            />
            {notesEnabled ? (
              <RailAction
                label="Notes"
                icon={File}
                onClick={onOpenNotes}
                active={notesActive}
                ariaLabel="Notes"
              />
            ) : null}
          </div>

          <div
            ref={(el) => {
              lockOverscroll(el);
              scrollRef.current = el;
            }}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none pb-2"
          >
            {sections.pinned.length > 0 ? (
              <ProjectSection
                label="Pinned"
                items={sections.pinned}
                cwd={cwd}
                activeProjectId={activeProjectId}
                busyProjectIds={busyProjectIds}
                approvalProjectIds={approvalProjectIds}
                busy={busy}
                sortable={pinnedSortable}
                pinned
                searchActive={
                  searchActive ||
                  inboxActive ||
                  notesActive
                }
                onSelect={selectProject}
                onTogglePin={onTogglePin}
                onContextMenu={onProjectContextMenu}
                onOpenMenu={openProjectMenu}
                groupLabels={groupLabels}
                groupColors={groupColors}
                groupCustomColors={groupCustomColors}
                groupLogos={groupLogos}
                groupMascots={groupMascots}
                now={now}
              />
            ) : null}

            <ProjectSection
              label="Projects"
              items={sections.projects}
              emptyLabel="No projects yet"
              onAdd={onCreateAgentProject ?? onOpenProject}
              addLabel={agentProjects ? "New project" : "Open repository"}
              cwd={cwd}
              activeProjectId={activeProjectId}
              busyProjectIds={busyProjectIds}
              approvalProjectIds={approvalProjectIds}
              busy={busy}
              sortable={projectSortable}
              pinned={false}
              searchActive={
                searchActive ||
                inboxActive ||
                notesActive
              }
              onSelect={selectProject}
              onTogglePin={onTogglePin}
              onContextMenu={onProjectContextMenu}
              onOpenMenu={openProjectMenu}
              groupLabels={groupLabels}
              groupColors={groupColors}
              groupCustomColors={groupCustomColors}
              groupLogos={groupLogos}
              groupMascots={groupMascots}
              now={now}
            />
          </div>
          <LiveAgentsPreview
            agents={liveAgents}
            activeSessionId={activeSessionId}
            onSelect={onSelectAgent}
            groupLabels={groupLabels}
            groupColors={groupColors}
            groupCustomColors={groupCustomColors}
            groupMascots={groupMascots}
          />
          <SidebarUpdateFooter
            update={updateNotice}
            onOpenWhatsNew={onOpenWhatsNew}
            onDismissUpdate={onDismissUpdate}
          />
          <div className="flex shrink-0 flex-col gap-px p-2">
            <RailAction
              label="Settings"
              icon={Settings}
              onClick={onOpenSettings}
              shortcut={`${MOD},`}
              ariaLabel={`Settings (${MOD},)`}
            />
          </div>
        </>
      )}
      {projectMenu ? (
        <TabGroupMenu
          x={projectMenu.x}
          y={projectMenu.y}
          groupId={projectMenu.projectKey}
          label={projectMenu.name ?? resolveTabGroupLabel(
            projectMenu.projectKey,
            groupLabels,
            basename(projectMenu.path),
          )}
          colorIndex={resolveTabGroupColorIndex(
            projectMenu.projectKey,
            groupColors,
            groupCustomColors,
          )}
          customColor={resolveTabGroupCustomColor(
            projectMenu.projectKey,
            groupCustomColors,
          )}
          currentColor={resolveTabGroupColor(
            projectMenu.projectKey,
            groupColors,
            groupCustomColors,
            projectName(projectMenu.path),
          )}
          logoPath={resolveTabGroupLogo(projectMenu.projectKey, groupLogos)}
          logoProject={projectMenu.path}
          mascotName={resolveTabGroupMascot(
            projectMenu.projectKey,
            groupMascots,
          )}
          mascotProject={projectName(projectMenu.path)}
          onRename={onProjectRename}
          onColorChange={onProjectColorChange}
          onCustomColorChange={onProjectCustomColorChange}
          onMascotChange={onProjectMascotChange}
          onLogoChange={() => {}}
          onPick={() => {}}
          onClose={() => setProjectMenu(null)}
          showActions={false}
          extraItems={[
            ...(projectMenu.id && onProjectOverview ? [{ id: "overview", label: "Project overview", icon: FolderOpen }] : []),
            ...projectMenuExtraItems(
            projectMenu.id ? pinnedProjectIds.includes(projectMenu.id) : pinnedPaths.some((pinned) =>
              sameProjectPath(pinned, projectMenu.path),
            ),
            projectMenu.id ? Boolean(onArchiveAgentProject || onDeleteAgentProject) : Boolean(onRemoveProject),
          )]}
          onExtraPick={onProjectMenuPick}
        />
      ) : null}
      {removing ? (
        <RemoveProjectDialog
          name={removing.name}
          path={removing.path}
          onConfirm={onConfirmDelete}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
      {backgroundProject ? (
        <ProjectBackgroundDialog
          project={backgroundProject.project}
          name={backgroundProject.name}
          onClose={() => setBackgroundProject(null)}
        />
      ) : null}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize project sidebar"
        aria-valuenow={resize.width}
        aria-valuemin={PROJECT_RAIL_WIDTH_MIN}
        aria-valuemax={PROJECT_RAIL_WIDTH_MAX}
        className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none ${
          resize.dragging ? "bg-content/15" : "hover:bg-content/10"
        }`}
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
      />
    </nav>
  );
}

type SortableHandle = ReturnType<typeof useSortable>;

const LIVE_AGENT_MIN = 2;
const LIVE_AGENT_CAP = 4;

function LiveAgentsPreview({
  agents,
  activeSessionId,
  onSelect,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupMascots,
}: {
  agents: LiveAgent[];
  activeSessionId?: string;
  onSelect?: (sessionId: string) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupMascots: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lockList = useLockOverscroll<HTMLDivElement>();
  const ticking =
    agents.length >= LIVE_AGENT_MIN &&
    agents.some((agent) => !agent.done && agent.startedAt != null);

  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  if (agents.length < LIVE_AGENT_MIN) return null;

  const extra = agents.length - LIVE_AGENT_CAP;
  const visible =
    expanded || extra <= 0 ? agents : agents.slice(0, LIVE_AGENT_CAP);

  return (
    <div className="shrink-0 px-2">
      <div
        role="status"
        aria-label="Working agents"
        className="overflow-hidden rounded-lg bg-content/5"
      >
        <div className="flex items-center gap-2 px-3.5 py-1.5">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)] animate-pulse"
          />
          <span className="min-w-0 flex-1 truncate text-xs text-content/50">
            Working
          </span>
          <span className="text-[11px] tabular-nums text-content/40">
            {agents.length}
          </span>
        </div>
        <div
          ref={expanded ? lockList : undefined}
          className={`flex flex-col gap-px px-1 ${
            extra > 0 ? "" : "pb-1"
          } ${expanded ? "max-h-[45vh] overflow-y-auto overscroll-none" : ""}`}
        >
          {visible.map((agent) => (
            <LiveAgentCard
              key={agent.id}
              agent={agent}
              now={now}
              selected={agent.id === activeSessionId}
              onSelect={onSelect}
              groupLabels={groupLabels}
              groupColors={groupColors}
              groupCustomColors={groupCustomColors}
              groupMascots={groupMascots}
            />
          ))}
        </div>
        {extra > 0 ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="flex w-full items-center justify-center gap-1 px-2 py-1.5 text-[11px] text-content/50 hover:bg-content/8 hover:text-content"
          >
            {expanded ? (
              <ChevronUp className="size-3" strokeWidth={1.75} />
            ) : (
              <ChevronDown className="size-3" strokeWidth={1.75} />
            )}
            {expanded ? "Show less" : `${extra} more`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function LiveAgentCard({
  agent,
  now,
  selected,
  onSelect,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupMascots,
}: {
  agent: LiveAgent;
  now: number;
  selected: boolean;
  onSelect?: (sessionId: string) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupMascots: Record<string, string>;
}) {
  const seed = projectName(agent.cwd);
  const key = projectKey(agent.cwd);
  const project = resolveTabGroupLabel(key, groupLabels, seed);
  const color = resolveTabGroupColor(key, groupColors, groupCustomColors, seed);
  const elapsed = agent.done
    ? agent.durationMs != null
      ? formatLiveElapsed(0, agent.durationMs)
      : ""
    : agent.startedAt != null
      ? formatLiveElapsed(agent.startedAt, now)
      : "";
  const activity = agent.needsApproval
    ? "Need approval"
    : agent.done
      ? "Done"
      : agent.activity;
  const live = !agent.needsApproval && !agent.done;
  const title = [agent.title, project, activity, elapsed]
    .filter(Boolean)
    .join("\n");

  return (
    <button
      type="button"
      title={title}
      aria-label={[agent.title, project, activity, elapsed]
        .filter(Boolean)
        .join(", ")}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect?.(agent.id)}
      className={`relative flex w-full flex-col rounded-md px-2 py-1.5 text-left ${
        selected ? "bg-content/10" : "hover:bg-content/8"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ProjectMascot
          project={seed}
          color={color}
          name={resolveTabGroupMascot(key, groupMascots)}
          className="size-2 shrink-0"
          active={live}
        />
        {live ? (
          <p className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug">
            {agent.title}
          </p>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug">
            {agent.title}
          </span>
        )}
      </span>
      <span
        className={`mt-1 flex min-w-0 items-center gap-1.5 pl-4 text-[11px] leading-tight ${
          agent.needsApproval
            ? "text-amber-400"
            : agent.done
              ? "text-emerald-400"
              : "text-content/50"
        }`}
      >
        {agent.needsApproval ? (
          <CircleAlert className="size-3 shrink-0" strokeWidth={1.75} />
        ) : agent.done ? (
          <Check className="size-3 shrink-0" strokeWidth={2.25} />
        ) : (
          <TerminalSpinner className="inline-block w-3 select-none text-center text-[11px] leading-none" />
        )}
        <span className="min-w-0 truncate">{activity}</span>
      </span>
      <span className="mt-1 flex min-w-0 items-center gap-1.5 pl-4 text-[11px] leading-tight text-content/45">
        <HarnessIcon harness={agent.harness} className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{project}</span>
        {elapsed ? (
          <span className="shrink-0 tabular-nums">{elapsed}</span>
        ) : null}
      </span>
    </button>
  );
}

function ProjectSection({
  label,
  items,
  emptyLabel,
  onAdd,
  addLabel = "Open project",
  cwd,
  activeProjectId,
  busyProjectIds,
  approvalProjectIds,
  busy,
  sortable,
  pinned,
  searchActive,
  onSelect,
  onTogglePin,
  onContextMenu,
  onOpenMenu,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
  now,
}: {
  label: string;
  items: ProjectItem[];
  emptyLabel?: string;
  onAdd?: () => void;
  addLabel?: string;
  cwd: string;
  activeProjectId?: string;
  busyProjectIds?: ReadonlySet<string>;
  approvalProjectIds?: ReadonlySet<string>;
  busy: Set<string>;
  sortable: SortableHandle;
  pinned: boolean;
  searchActive: boolean;
  onSelect: (path: string) => void;
  onTogglePin: (path: string) => void;
  onContextMenu: (path: string, event: MouseEvent<HTMLElement>) => void;
  onOpenMenu: (path: string, x: number, y: number) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
  now: number;
}) {
  return (
    <div className="shrink-0 mb-2">
      <div className="flex items-center gap-1 px-3 pb-1.5 pt-1">
        <span className="min-w-0 flex-1 truncate px-1 text-xs text-content/50">
          {label}
        </span>
        {onAdd ? (
          <button
            type="button"
            title={addLabel}
            aria-label={addLabel}
            onClick={onAdd}
            className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      {items.length === 0 && emptyLabel ? (
        <p className="px-4 pb-1 text-[11px] leading-tight text-content/40">
          {emptyLabel}
        </p>
      ) : null}
      <div className="flex flex-col gap-px px-2">
        {items.map((item, index) => (
          <ProjectCard
            key={itemId(item)}
            item={item}
            selected={!searchActive && (item.id ? item.id === activeProjectId : sameProjectPath(item.path, cwd))}
            busy={item.id ? !!busyProjectIds?.has(item.id) : isBusyPath(item.path, busy)}
            needsApproval={!!item.id && !!approvalProjectIds?.has(item.id)}
            pinned={pinned}
            sortable={sortable}
            index={index}
            onSelect={onSelect}
            onTogglePin={onTogglePin}
            onContextMenu={onContextMenu}
            onOpenMenu={onOpenMenu}
            groupLabels={groupLabels}
            groupColors={groupColors}
            groupCustomColors={groupCustomColors}
            groupLogos={groupLogos}
            groupMascots={groupMascots}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}

const nameClassName =
  "min-w-0 flex-1 truncate text-sm font-medium leading-tight";

function ProjectCard({
  item,
  selected,
  busy,
  needsApproval,
  pinned,
  sortable,
  index,
  onSelect,
  onTogglePin,
  onContextMenu,
  onOpenMenu,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
  now,
}: {
  item: ProjectItem;
  selected: boolean;
  busy: boolean;
  needsApproval: boolean;
  pinned: boolean;
  sortable: SortableHandle;
  index: number;
  onSelect: (path: string) => void;
  onTogglePin: (path: string) => void;
  onContextMenu: (path: string, event: MouseEvent<HTMLElement>) => void;
  onOpenMenu: (path: string, x: number, y: number) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
  now: number;
}) {
  const fallbackName = basename(item.path);
  const id = itemId(item);
  const key = item.id ? `project:${item.id}` : projectKey(item.path);
  const seed = projectName(item.path);
  const name = item.name ?? resolveTabGroupLabel(key, groupLabels, fallbackName);
  const logoPath = resolveTabGroupLogo(key, groupLogos);
  const color = resolveTabGroupColor(key, groupColors, groupCustomColors, seed);
  const dragging = sortable.draggingId === id;
  const showStart =
    sortable.draggingId &&
    sortable.toIndex === index &&
    sortable.fromIndex !== null &&
    sortable.toIndex < sortable.fromIndex;
  const showEnd =
    sortable.draggingId &&
    sortable.toIndex === index &&
    sortable.fromIndex !== null &&
    sortable.toIndex > sortable.fromIndex;
  const diffEnabled = Boolean(item.path) && item.path !== "~";
  const stats = useProjectDiffStats(item.path, diffEnabled);
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  const hasChanges = files > 0 || additions > 0 || deletions > 0;
  const cardTitle = projectCardTitle(item.path, name, stats, busy);
  const cardAriaLabel = [projectCardAriaLabel(name, stats, busy), needsApproval ? "Needs approval" : ""].filter(Boolean).join(", ");

  return (
    <div
      ref={(el) => sortable.setItemRef(id, el)}
      data-project-id={item.id}
      className={`group relative flex touch-none items-stretch rounded-md px-2 ${item.goal?.trim() ? "h-12" : "h-8"} ${
        selected
          ? "bg-content/12 text-content"
          : "opacity-65 hover:bg-content/5 hover:text-content"
      } ${dragging ? "opacity-40" : ""} cursor-default`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
          return;
        }
        sortable.onItemPointerDown(id, event);
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
          return;
        }
        if (sortable.consumeClick()) return;
        onSelect(id);
      }}
      onContextMenu={(event) => onContextMenu(id, event)}
    >
      {showStart ? (
        <div className="pointer-events-none absolute inset-x-2 top-0 z-20 h-0.5 rounded-full bg-accent" />
      ) : null}
      {showEnd ? (
        <div className="pointer-events-none absolute inset-x-2 bottom-0 z-20 h-0.5 rounded-full bg-accent" />
      ) : null}
      <button
        type="button"
        title={cardTitle}
        aria-label={cardAriaLabel}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 cursor-default items-center gap-2 text-left group-hover:pr-6"
      >
        <div className="grid size-4 shrink-0 place-items-center transition-opacity group-hover:opacity-0">
          {logoPath && !busy ? (
            <ProjectLogoIcon
              path={logoPath}
              className="size-4 rounded-sm"
              imageClassName="size-4"
            />
          ) : (
            <ProjectMascot
              project={seed}
              color={color}
              name={resolveTabGroupMascot(key, groupMascots)}
              className="size-3"
              active={busy}
            />
          )}
        </div>
        <span className="min-w-0 flex-1">
        {busy ? (
          <Shimmer as="span" duration={1.4} className={nameClassName}>
            {name}
          </Shimmer>
        ) : (
          <span className={nameClassName}>{name}</span>
        )}
        {item.goal?.trim() ? (
          <span className="block truncate text-[10px] font-normal text-content/45">
            {item.goal.trim()}
          </span>
        ) : null}
        </span>
        {needsApproval ? <CircleAlert aria-label="Needs approval" className="size-3.5 shrink-0 text-amber-400" /> : null}
        {item.id ? (
          <span className="shrink-0 text-[11px] tabular-nums text-content/40 group-hover:hidden">
            {formatProjectAge(item.openedAt, now)}
          </span>
        ) : hasChanges ? (
          <span className="shrink-0 group-hover:hidden">
            <ProjectDiffStat additions={additions} deletions={deletions} />
          </span>
        ) : null}
      </button>
      <button
        type="button"
        data-no-drag
        title="Project options"
        aria-label="Project options"
        aria-haspopup="menu"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpenMenu(id, event.clientX, event.clientY);
        }}
        className="absolute right-1 top-1/2 hidden size-6 -translate-y-1/2 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:grid"
      >
        <MoreHorizontal className="size-4" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        data-no-drag
        title={pinned ? "Unpin project" : "Pin project"}
        aria-label={pinned ? "Unpin project" : "Pin project"}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(id);
        }}
        className="absolute left-2 top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-sm text-content/55 opacity-0 pointer-events-none transition-opacity hover:text-content group-hover:pointer-events-auto group-hover:opacity-100"
      >
        {pinned ? (
          <PinOff className="size-3.5" strokeWidth={1.75} />
        ) : (
          <Pin className="size-3.5" strokeWidth={1.75} />
        )}
      </button>
    </div>
  );
}

function isBusyPath(path: string, busy: Set<string>): boolean {
  for (const other of busy) {
    if (sameProjectPath(path, other)) return true;
  }
  return false;
}

function ProjectDiffStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions <= 0 && deletions <= 0) return null;

  const label = [
    additions > 0 ? `+${additions}` : "",
    deletions > 0 ? `-${deletions}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      title={`${label} uncommitted`}
      className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-semibold tabular-nums"
    >
      {additions > 0 ? (
        <span className="text-emerald-400">+{additions}</span>
      ) : null}
      {deletions > 0 ? (
        <span className="text-red-400">-{deletions}</span>
      ) : null}
    </span>
  );
}

function projectCardTitle(
  path: string,
  name: string,
  stats: GitDiffStats | null,
  busy: boolean,
): string {
  const parts = [name, path];
  if (busy) parts.push("Working");
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  if (files > 0 || additions > 0 || deletions > 0) {
    parts.push(
      [
        files > 0 ? `${files} ${files === 1 ? "file" : "files"} changed` : "",
        additions > 0 ? `+${additions}` : "",
        deletions > 0 ? `-${deletions}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  return parts.join("\n");
}

function projectCardAriaLabel(
  name: string,
  stats: GitDiffStats | null,
  busy: boolean,
): string {
  const parts = [name];
  if (busy) parts.push("working");
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  if (files > 0) {
    parts.push(`${files} ${files === 1 ? "file" : "files"} changed`);
  }
  if (additions > 0) parts.push(`+${additions}`);
  if (deletions > 0) parts.push(`-${deletions}`);
  return parts.join(", ");
}
