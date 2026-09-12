import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Archive,
  Bot,
  Check,
  Clock,
  File,
  LoaderCircle,
  Plus,
  Search,
  X,
} from "../chrome/icons";
import { Modal } from "../chrome/Modal";
import { OverlayNav } from "../chrome/TitleBar";
import { WindowControls } from "../chrome/WindowControls";
import { IS_MAC } from "../lib/platform";
import type { SessionSummary } from "../lib/sessionStore";
import {
  coordinatorPrompt,
  createAgentProject,
  deleteAgentProject,
  loadAgentProjects,
  saveAgentProject,
  subscribeAgentProjects,
  type AgentProject,
  type AgentProjectDocument,
  type AgentProjectSubscription,
} from "../lib/agentProjects";

type Props = {
  cwd: string;
  /** When set, the rail is the project switcher and this view is the detail. */
  activeProjectId?: string;
  variant?: "overlay" | "pane";
  besideRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
  sessions: readonly SessionSummary[];
  busySessionIds: ReadonlySet<string>;
  onOpenSession: (id: string) => void;
  onOpenDocument?: (document: AgentProjectDocument) => void;
  onStartSession: (
    project: AgentProject,
    role: "coordinator" | "worker",
    prompt: string,
    title: string,
  ) => Promise<void>;
};

const button =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-content/10 px-3 py-2 text-sm text-content/75 hover:bg-content/8 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:pointer-events-none";
const primary = `${button} bg-accent/15 text-accent border-accent/20 hover:bg-accent/25`;
const field =
  "w-full rounded-lg border border-content/15 bg-background-base px-3 py-2 text-sm text-content placeholder:text-content/35 focus:outline-none focus:ring-2 focus:ring-accent";
const panel = "rounded-xl border border-content/10 bg-content/[0.025] p-5";
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const editable = (project: AgentProject) =>
  JSON.stringify([
    project.name,
    project.goal,
    project.instructions,
    project.documents,
  ]);
const topDialog = () => {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  return dialogs[dialogs.length - 1];
};
type RecoverableDraft = {
  draft: AgentProject;
  baseline: AgentProject;
  task: string;
  taskTitle: string;
  schedule: AgentProjectSubscription | null;
  scheduleChanged: boolean;
};
// Keep unsaved work recoverable when app-level navigation unmounts this view.
const projectDrafts = new Map<string, RecoverableDraft>();
const draftKey = (project: Pick<AgentProject, "cwd" | "id">) =>
  `${project.cwd}\0${project.id}`;

function ProjectModal(props: ComponentProps<typeof Modal>) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = topDialog();
    dialogRef.current = dialog ?? null;
    dialog?.querySelector<HTMLElement>("input, textarea, button")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || dialog !== topDialog()) return;
      const items = [
        ...(dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ) ?? []),
      ];
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, []);
  return (
    <Modal
      {...props}
      onClose={() => {
        if (dialogRef.current === topDialog()) props.onClose();
      }}
    />
  );
}

function Label({ children, title }: { children: ReactNode; title: string }) {
  return (
    <label className="flex flex-col gap-2 text-xs font-medium text-content/65">
      {title}
      {children}
    </label>
  );
}

export function AgentProjectsView({
  cwd,
  activeProjectId,
  variant = "overlay",
  besideRail = false,
  onClose,
  onToggleSidebar,
  sessions,
  busySessionIds,
  onOpenSession,
  onOpenDocument,
  onStartSession,
}: Props) {
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [pending, setPending] = useState(false);
  const [draftReset, setDraftReset] = useState(0);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    text: string;
    action: () => void;
  } | null>(null);
  const dirty = useRef(false);
  const busy = useRef(false);
  const creatingDirty = useRef(false);
  creatingDirty.current = creating && !!(name.trim() || goal.trim());
  const hasRepository =
    cwd.startsWith("/") ||
    cwd.startsWith("\\\\") ||
    /^[A-Za-z]:(?:[\\/]|$)/.test(cwd);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    if (!hasRepository) {
      setProjects([]);
      setLoading(false);
      return;
    }
    try {
      const records = await loadAgentProjects(cwd);
      if (id !== request.current) return;
      setProjects(records);
    } catch (err) {
      if (id === request.current) setError(message(err));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [cwd, hasRepository]);
  useEffect(() => {
    setLoading(true);
    setProjects([]);
    setSelectedId(null);
    setError("");
    void refresh();
    const unsubscribe = subscribeAgentProjects(() => {
      void refresh();
    });
    return () => {
      ++request.current;
      unsubscribe();
    };
  }, [refresh]);
  const guard = (action: () => void) => {
    if (pending || busy.current) return;
    if (dirty.current || (creating && (name.trim() || goal.trim()))) {
      setConfirmation({
        title: "Discard unsaved changes?",
        text: "Your saved project will not change. Unsaved edits will be discarded.",
        action: () => {
          dirty.current = false;
          const current = projects.find((item) => item.id === selectedId);
          if (current) projectDrafts.delete(draftKey(current));
          setDraftReset((value) => value + 1);
          action();
        },
      });
    } else action();
  };
  const closeRef = useRef(() => guard(onClose));
  closeRef.current = () => guard(onClose);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector('[role="dialog"]'))
        return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current || creatingDirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  useEffect(() => {
    if (!activeProjectId) return;
    setSelectedId(activeProjectId);
    setCreating(false);
  }, [activeProjectId]);
  const pane = variant === "pane";
  const railOwned = Boolean(activeProjectId) || pane;
  const selected = projects.find((project) => project.id === selectedId);
  const visible = projects.filter(
    (project) =>
      project.archived === archived &&
      `${project.name} ${project.goal}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
  );
  const update = async (
    id: string,
    change: (project: AgentProject) => AgentProject,
  ) => {
    setPending(true);
    setError("");
    try {
      const fresh = (await loadAgentProjects(cwd)).find(
        (project) => project.id === id,
      );
      if (!fresh)
        throw new Error(
          "This project no longer exists. Reload the project list.",
        );
      const saved = await saveAgentProject(change(fresh));
      setProjects((current) =>
        current.map((project) => (project.id === saved.id ? saved : project)),
      );
      await refresh();
    } catch (err) {
      setError(message(err));
      await refresh();
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      aria-label={pane ? "Project" : "Projects workspace"}
      className={`flex h-full min-h-0 min-w-0 flex-col bg-background-base text-content ${pane ? "border-l border-content/10" : "flex-1"}`}
    >
      <header
        data-tauri-drag-region={pane ? undefined : "deep"}
        className="flex h-10 shrink-0 items-center border-b border-content/10"
      >
        {IS_MAC && !besideRail && !pane ? <div className="w-[78px] shrink-0" /> : null}
        {!besideRail && !pane && (
          <OverlayNav
            onBack={() => guard(onClose)}
            onToggleSidebar={onToggleSidebar}
          />
        )}
        <span className="min-w-0 flex-1 truncate px-3 text-xs font-medium text-content/60">
          {selected?.name ?? "Projects"}
        </span>
        <button
          className={`${button} mr-2 border-0 p-1.5`}
          aria-label={pane ? "Close Project" : "Close Projects"}
          onClick={() => guard(onClose)}
        >
          <X className="size-4" />
        </button>
        {!IS_MAC && !pane && <WindowControls />}
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label="Project list"
          className={`${railOwned ? "hidden" : selected ? "hidden md:flex" : "flex"} max-h-full w-full shrink-0 flex-col border-content/10 md:w-64 md:border-r lg:w-72`}
        >
          <div className="space-y-4 p-5">
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
              <button
                className={`${button} p-1.5`}
                aria-label="New project"
                disabled={!hasRepository}
                title={
                  !hasRepository
                    ? "Choose a repository folder first"
                    : "New project"
                }
                onClick={() =>
                  guard(() => {
                    setName("");
                    setGoal("");
                    setCreating(true);
                  })
                }
              >
                <Plus className="size-4" />
              </button>
            </div>
            <p className="text-xs leading-relaxed text-content/50">
              A coordinator, workers, and shared context for one body of work.
            </p>
            <p
              className="truncate font-mono text-[10px] text-content/40"
              title={cwd}
            >
              {cwd}
            </p>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-content/40" />
              <input
                aria-label="Search projects"
                placeholder="Search projects…"
                className={`${field} pl-9`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <button
              className="text-xs text-content/50 hover:text-content focus-visible:ring-2 focus-visible:ring-accent"
              aria-pressed={archived}
              onClick={() =>
                guard(() => {
                  setArchived(!archived);
                  setSelectedId(null);
                })
              }
            >
              {archived ? "Show active projects" : "Show archived projects"}
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-4">
            {loading ? (
              <p
                role="status"
                className="flex items-center gap-2 p-3 text-sm text-content/50"
              >
                <LoaderCircle className="size-4 animate-spin" />
                Loading projects…
              </p>
            ) : visible.length === 0 ? (
              <p className="p-3 text-sm text-content/45">
                {query
                  ? "No matching projects."
                  : archived
                    ? "No archived projects."
                    : "No projects in this folder yet."}
              </p>
            ) : (
              visible.map((project) => (
                <button
                  key={project.id}
                  aria-current={project.id === selectedId ? "page" : undefined}
                  onClick={() => guard(() => setSelectedId(project.id))}
                  className={`w-full rounded-xl p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${project.id === selectedId ? "bg-accent/10 ring-1 ring-accent/20" : "hover:bg-content/5"}`}
                >
                  <div className="flex items-center gap-2">
                    <Bot className="size-4 shrink-0 text-content/50" />
                    <span className="truncate text-sm font-medium">
                      {project.name}
                    </span>
                    {project.archived && (
                      <Archive className="ml-auto size-3 text-content/40" />
                    )}
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-content/45">
                    {project.goal}
                  </p>
                  <p className="mt-3 text-[10px] text-content/40">
                    {project.members.length} agents · {project.documents.length}{" "}
                    documents
                  </p>
                </button>
              ))
            )}
          </div>
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {error && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 border-b border-content/10 bg-content/5 px-5 py-3 text-sm"
            >
              <span className="flex-1">{error}</span>
              <button
                className={button}
                onClick={() => {
                  setError("");
                  void refresh();
                }}
              >
                Retry loading
              </button>
            </div>
          )}
          {selected ? (
            <ProjectDetail
              key={`${cwd}:${selected.id}:${draftReset}`}
              project={selected}
              sessions={sessions}
              busySessionIds={busySessionIds}
              onDirty={(value) => {
                dirty.current = value;
              }}
              onBusy={(value) => {
                busy.current = value;
              }}
              onBack={
                railOwned ? undefined : () => guard(() => setSelectedId(null))
              }
              onOpenSession={(id) => guard(() => onOpenSession(id))}
              onStartSession={onStartSession}
              onOpenDocument={onOpenDocument}
              onSaved={(saved) => {
                setProjects((current) =>
                  current.map((item) => (item.id === saved.id ? saved : item)),
                );
              }}
              onRefresh={refresh}
              onArchive={() =>
                guard(() => {
                  void update(selected.id, (fresh) => ({
                    ...fresh,
                    archived: !fresh.archived,
                  }));
                })
              }
              onDelete={() =>
                guard(() =>
                  setConfirmation({
                    title: `Delete ${selected.name}?`,
                    text: "This removes the project's shared context and schedules. Existing chats and repository files are preserved.",
                    action: () => {
                      setPending(true);
                      void deleteAgentProject(selected.id)
                        .then(() => {
                          setSelectedId(null);
                          return refresh();
                        })
                        .catch((err) => setError(message(err)))
                        .finally(() => setPending(false));
                    },
                  }),
                )
              }
              pending={pending}
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-8">
              <div className="max-w-md text-center">
                <div className="mx-auto mb-6 grid size-16 place-items-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                  <Bot className="size-7" />
                </div>
                <h2 className="text-2xl font-semibold tracking-tight">
                  {hasRepository
                    ? "Give your work a home"
                    : "Choose a repository folder"}
                </h2>
                <p className="mt-3 text-sm leading-6 text-content/50">
                  {hasRepository
                    ? "Move an initiative forward across conversations. Keep the plan, delegate focused tasks, and share the context every agent needs."
                    : "Open a repository from the sidebar before creating a local project. Projects and their agents need a working folder."}
                </p>
                <button
                  className={`${primary} mt-6`}
                  disabled={!hasRepository}
                  onClick={() => {
                    setName("");
                    setGoal("");
                    setCreating(true);
                  }}
                >
                  <Plus className="size-4" />
                  Create project
                </button>
                <p className="mt-4 text-xs text-content/35">
                  Local to this folder · Your provider · Your permissions
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
      {creating && (
        <ProjectModal
          title="Create project"
          onClose={() => guard(() => setCreating(false))}
        >
          <form
            className="space-y-4 p-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (pending || !hasRepository || !name.trim() || !goal.trim())
                return;
              setPending(true);
              setError("");
              void Promise.resolve()
                .then(() =>
                  saveAgentProject(
                    createAgentProject(cwd, name.trim(), goal.trim()),
                  ),
                )
                .then((saved) => {
                  setProjects((current) => [
                    ...current.filter((item) => item.id !== saved.id),
                    saved,
                  ]);
                  setSelectedId(saved.id);
                  setArchived(false);
                  setQuery("");
                  setCreating(false);
                })
                .catch((err) => setError(message(err)))
                .finally(() => setPending(false));
            }}
          >
            <Label title="Project name">
              <input
                disabled={pending}
                required
                maxLength={160}
                aria-label="Project name"
                className={field}
                placeholder="Launch the next release"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Label>
            <Label title="Goal">
              <textarea
                disabled={pending}
                required
                aria-label="Goal"
                className={`${field} min-h-28`}
                placeholder="What outcome are you working toward?"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
              />
            </Label>
            {error && (
              <p role="alert" className="text-sm text-content">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={button}
                onClick={() => guard(() => setCreating(false))}
              >
                Cancel
              </button>
              <button
                className={primary}
                disabled={pending || !name.trim() || !goal.trim()}
              >
                {pending ? "Creating…" : "Create project"}
              </button>
            </div>
          </form>
        </ProjectModal>
      )}
      {confirmation && (
        <ProjectModal
          title={confirmation.title}
          onClose={() => setConfirmation(null)}
          size="sm"
        >
          <div className="space-y-5 p-5">
            <p className="text-sm leading-6 text-content/65">
              {confirmation.text}
            </p>
            <div className="flex justify-end gap-2">
              <button className={button} onClick={() => setConfirmation(null)}>
                Cancel
              </button>
              <button
                className={primary}
                onClick={() => {
                  const action = confirmation.action;
                  setConfirmation(null);
                  action();
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </ProjectModal>
      )}
    </section>
  );
}

type DetailProps = Pick<
  Props,
  | "sessions"
  | "busySessionIds"
  | "onOpenSession"
  | "onOpenDocument"
  | "onStartSession"
> & {
  project: AgentProject;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
  onSaved: (project: AgentProject) => void;
  onRefresh: () => Promise<void>;
  onBack?: () => void;
  onArchive: () => void;
  onDelete: () => void;
  pending: boolean;
};

function ProjectDetail({
  project,
  sessions,
  busySessionIds,
  onOpenSession,
  onOpenDocument,
  onStartSession,
  onDirty,
  onBusy,
  onSaved,
  onRefresh,
  onBack,
  onArchive,
  onDelete,
  pending,
}: DetailProps) {
  const [tab, setTab] = useState("Overview");
  const recovery = useRef(projectDrafts.get(draftKey(project))).current;
  const [draft, setDraft] = useState(recovery?.draft ?? project);
  const [baseline, setBaseline] = useState(recovery?.baseline ?? project);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [savedNotice, setSavedNotice] = useState(
    recovery
      ? "Recovered your unsaved draft from this app session. Review and save when ready."
      : "",
  );
  const [task, setTask] = useState(recovery?.task ?? "");
  const [taskTitle, setTaskTitle] = useState(recovery?.taskTitle ?? "");
  const [schedule, setSchedule] = useState<AgentProjectSubscription | null>(
    recovery?.schedule ?? null,
  );
  const [consent, setConsent] = useState(false);
  const [scheduleChanged, setScheduleChanged] = useState(
    recovery?.scheduleChanged ?? false,
  );
  const [discardSchedule, setDiscardSchedule] = useState(false);
  const [deleteSchedule, setDeleteSchedule] = useState<string | null>(null);
  const [discardContext, setDiscardContext] = useState(false);
  const [unlinkMember, setUnlinkMember] = useState<string | null>(null);
  const changed = editable(draft) !== editable(baseline);
  const dirty =
    changed || !!task.trim() || !!taskTitle.trim() || scheduleChanged;
  useEffect(() => {
    onDirty(dirty);
    if (dirty)
      projectDrafts.set(draftKey(project), {
        draft,
        baseline,
        task,
        taskTitle,
        schedule,
        scheduleChanged,
      });
    else projectDrafts.delete(draftKey(project));
  });
  useEffect(() => {
    onBusy(working);
  });
  useEffect(() => {
    if (!changed) {
      setDraft(project);
      setBaseline(project);
    } else if (editable(project) === editable(baseline)) {
      // Live membership and scheduler updates must not stale the context draft.
      setDraft((current) => ({
        ...project,
        name: current.name,
        goal: current.goal,
        instructions: current.instructions,
        documents: current.documents,
      }));
      setBaseline(project);
    }
  }, [project, changed]);
  const blocked = pending || working;
  const coordinator = project.members.find(
    (member) =>
      member.role === "coordinator" &&
      sessions.some((session) => session.id === member.sessionId),
  );
  const saveContext = async () => {
    if (blocked) return;
    setWorking(true);
    setError("");
    setSavedNotice("");
    try {
      const saved = await saveAgentProject({
        ...baseline,
        name: draft.name.trim(),
        goal: draft.goal.trim(),
        instructions: draft.instructions,
        documents: draft.documents,
      });
      setDraft(saved);
      setBaseline(saved);
      onSaved(saved);
      setSavedNotice(
        "Changes saved. Members receive this context on their next turn.",
      );
    } catch (err) {
      setError(
        `${message(err)} Your edits are still here. If the project changed elsewhere, reload the saved version before trying again.`,
      );
      await onRefresh();
    } finally {
      setWorking(false);
    }
  };
  const start = async (role: "coordinator" | "worker") => {
    if (blocked || changed) return;
    setWorking(true);
    setError("");
    try {
      if (role === "coordinator" && (task.trim() || taskTitle.trim())) {
        throw new Error(
          "Delegate or clear your worker draft before starting the coordinator.",
        );
      }
      const fresh = (await loadAgentProjects(project.cwd)).find(
        (item) => item.id === project.id,
      );
      if (!fresh || fresh.archived)
        throw new Error(
          "This project is unavailable or archived. Restore it before starting an agent.",
        );
      projectDrafts.delete(draftKey(project));
      await onStartSession(
        fresh,
        role,
        role === "coordinator" ? coordinatorPrompt(fresh) : task.trim(),
        role === "coordinator" ? fresh.name : taskTitle.trim(),
      );
      setTask("");
      setTaskTitle("");
      onDirty(false);
      await onRefresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setWorking(false);
    }
  };
  const saveSchedules = async (
    change: (
      subscriptions: AgentProjectSubscription[],
    ) => AgentProjectSubscription[],
  ) => {
    if (blocked) return;
    setWorking(true);
    setError("");
    try {
      const fresh = (await loadAgentProjects(project.cwd)).find(
        (item) => item.id === project.id,
      );
      if (!fresh) throw new Error("This project no longer exists.");
      const saved = await saveAgentProject({
        ...fresh,
        subscriptions: change(fresh.subscriptions),
      });
      onSaved(saved);
      setSchedule(null);
      setScheduleChanged(false);
      setSavedNotice("Schedule saved.");
    } catch (err) {
      setError(message(err));
      await onRefresh();
    } finally {
      setWorking(false);
    }
  };
  const openSchedule = (subscription?: AgentProjectSubscription) => {
    setConsent(false);
    setScheduleChanged(false);
    setError("");
    setSchedule(
      subscription
        ? { ...subscription }
        : {
            id: crypto.randomUUID(),
            name: "",
            prompt: "",
            intervalMinutes: 60,
            enabled: false,
            nextRunAt: Date.now() + 3_600_000,
          },
    );
  };
  const closeSchedule = () => {
    if (blocked) return;
    if (scheduleChanged) setDiscardSchedule(true);
    else setSchedule(null);
  };
  const unlinkWorker = async () => {
    if (blocked || !unlinkMember) return;
    setWorking(true);
    setError("");
    try {
      const fresh = (await loadAgentProjects(project.cwd)).find(
        (item) => item.id === project.id,
      );
      if (!fresh) throw new Error("This project no longer exists.");
      const saved = await saveAgentProject({
        ...fresh,
        members: fresh.members.filter(
          (member) =>
            member.role !== "worker" || member.sessionId !== unlinkMember,
        ),
      });
      onSaved(saved);
      setUnlinkMember(null);
      setSavedNotice(
        "Worker unlinked. Its chat and repository files are preserved.",
      );
    } catch (err) {
      setError(message(err));
      await onRefresh();
    } finally {
      setWorking(false);
    }
  };
  const memberList = project.members.length ? (
    <div className="divide-y divide-content/10">
      {project.members.map((member) => {
        const session = sessions.find((item) => item.id === member.sessionId);
        const busy = busySessionIds.has(member.sessionId);
        return (
          <div
            key={member.sessionId}
            className="flex min-w-0 items-center gap-2"
          >
            <button
              disabled={!session}
              onClick={() => onOpenSession(member.sessionId)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-4 text-left hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
            >
              <span
                className={`grid size-9 shrink-0 place-items-center rounded-xl ${member.role === "coordinator" ? "bg-accent/10 text-accent" : "bg-content/5 text-content/50"}`}
              >
                <Bot className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {member.title}
                </span>
                <span className="text-xs capitalize text-content/40">
                  {member.role}
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-xs text-content/50">
                {busy && <LoaderCircle className="size-3 animate-spin" />}
                {!session
                  ? "Unavailable"
                  : busy
                    ? "Working"
                    : session.archived
                      ? "Archived chat"
                      : "Ready"}
              </span>
            </button>
            {member.role === "worker" && (
              <button
                disabled={blocked}
                className={`${button} shrink-0 p-2`}
                aria-label={`Unlink ${member.title}`}
                title="Unlink worker (preserves chat)"
                onClick={() => {
                  setError("");
                  setUnlinkMember(member.sessionId);
                }}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  ) : (
    <p className="py-4 text-sm leading-6 text-content/45">
      No agents yet. Start a coordinator to plan the work, then delegate focused
      tasks to separate worker chats.
    </p>
  );
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-5 py-6 sm:px-8">
          {onBack ? (
          <button
            className="mb-5 text-xs text-content/50 hover:text-content md:hidden"
            onClick={onBack}
          >
            ← All projects
          </button>
          ) : null}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-content/10 px-2 py-1 text-[10px] font-medium uppercase tracking-widest text-content/45">
                  Local only
                </span>
                {project.archived && (
                  <span className="text-xs text-content/45">
                    Archived · schedules paused
                  </span>
                )}
              </div>
              <h2 className="break-words text-2xl font-semibold tracking-tight">
                {project.name}
              </h2>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-content/55">
                {project.goal}
              </p>
            </div>
            <div className="flex gap-2">
              <button disabled={blocked} className={button} onClick={onArchive}>
                {project.archived ? "Restore" : "Archive"}
              </button>
              <button disabled={blocked} className={button} onClick={onDelete}>
                Delete
              </button>
            </div>
          </div>
          <div
            role="tablist"
            aria-label="Project sections"
            className="mt-7 flex gap-5 overflow-x-auto border-b border-content/10"
          >
            {["Overview", "Agents", "Context", "Subscriptions"].map(
              (item, index, items) => (
                <button
                  role="tab"
                  id={`project-tab-${item}`}
                  aria-controls={`project-panel-${item}`}
                  aria-selected={tab === item}
                  tabIndex={tab === item ? 0 : -1}
                  key={item}
                  onClick={() => setTab(item)}
                  onKeyDown={(event) => {
                    const target =
                      event.key === "ArrowRight"
                        ? (index + 1) % items.length
                        : event.key === "ArrowLeft"
                          ? (index + items.length - 1) % items.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? items.length - 1
                              : -1;
                    if (target >= 0) {
                      event.preventDefault();
                      setTab(items[target]);
                      document
                        .getElementById(`project-tab-${items[target]}`)
                        ?.focus();
                    }
                  }}
                  className={`shrink-0 border-b-2 pb-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${tab === item ? "border-accent text-content" : "border-transparent text-content/45 hover:text-content/75"}`}
                >
                  {item}
                </button>
              ),
            )}
          </div>
          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-content/15 bg-content/5 p-3 text-sm"
            >
              {error}
            </p>
          )}
          {savedNotice && (
            <p
              role="status"
              className="mt-4 flex items-center gap-2 text-xs text-content/55"
            >
              <Check className="size-3" />
              {savedNotice}
            </p>
          )}
          <fieldset
            disabled={blocked}
            role="tabpanel"
            id={`project-panel-${tab}`}
            aria-labelledby={`project-tab-${tab}`}
            className="min-w-0 space-y-5 pt-6"
          >
            {tab === "Overview" && (
              <>
                <div
                  className={`${panel} flex flex-wrap items-start justify-between gap-5`}
                >
                  <div className="max-w-lg">
                    <h3 className="flex items-center gap-2 text-sm font-medium">
                      <Bot className="size-4 text-accent" />
                      Your persistent coordinator
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-content/50">
                      Keep the plan and decisions in a dedicated conversation.
                      Workers are separate chats you create for focused tasks.
                    </p>
                    <p className="mt-2 text-xs text-content/40">
                      Starting an agent opens a supervised draft. Review it and
                      click Send in the chat.
                    </p>
                  </div>
                  <button
                    disabled={blocked || project.archived || changed}
                    className={primary}
                    onClick={() => void start("coordinator")}
                  >
                    {coordinator
                      ? "Resume coordinator"
                      : working
                        ? "Starting…"
                        : "Start coordinator"}
                  </button>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  {[
                    {
                      icon: Bot,
                      label: "Agents",
                      value: project.members.length,
                    },
                    {
                      icon: File,
                      label: "Shared documents",
                      value: project.documents.length,
                    },
                    {
                      icon: Clock,
                      label: "Enabled schedules",
                      value: project.subscriptions.filter(
                        (item) => item.enabled,
                      ).length,
                    },
                  ].map(({ icon: Icon, label, value }) => (
                    <div key={label} className={panel}>
                      <Icon className="mb-4 size-4 text-content/40" />
                      <p className="text-2xl font-semibold">{value}</p>
                      <p className="mt-1 text-xs text-content/45">{label}</p>
                    </div>
                  ))}
                </div>
                <section className={panel}>
                  <h3 className="text-sm font-medium">Project team</h3>
                  {memberList}
                </section>
              </>
            )}
            {tab === "Agents" && (
              <>
                <section className={panel}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-sm font-medium">
                      Coordinator & workers
                    </h3>
                    <button
                      disabled={blocked || project.archived || changed}
                      className={button}
                      onClick={() => void start("coordinator")}
                    >
                      {coordinator ? "Resume coordinator" : "Start coordinator"}
                    </button>
                  </div>
                  {memberList}
                  <p className="mt-3 text-xs leading-5 text-content/45">
                    {project.members.length}/64 team members. Unlink finished
                    workers to make room for new tasks and scheduled runs.
                    Unlinking preserves their chats and repository files.
                  </p>
                </section>
                <form
                  className={`${panel} space-y-4`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (task.trim() && taskTitle.trim()) void start("worker");
                  }}
                >
                  <h3 className="text-sm font-medium">Delegate a task</h3>
                  <p className="text-xs leading-5 text-content/45">
                    Open a separate supervised worker draft with the project's
                    saved context. Review and send it yourself. Provider-native
                    subagents may work autonomously when supported.
                  </p>
                  <Label title="Task title">
                    <input
                      aria-label="Task title"
                      required
                      className={field}
                      value={taskTitle}
                      onChange={(event) => setTaskTitle(event.target.value)}
                      placeholder="Audit release readiness"
                    />
                  </Label>
                  <Label title="Task">
                    <textarea
                      aria-label="Task"
                      required
                      className={`${field} min-h-28`}
                      value={task}
                      onChange={(event) => setTask(event.target.value)}
                      placeholder="Describe a focused outcome and how to verify it…"
                    />
                  </Label>
                  <button
                    className={primary}
                    disabled={
                      blocked ||
                      changed ||
                      project.archived ||
                      !task.trim() ||
                      !taskTitle.trim()
                    }
                  >
                    Delegate task
                  </button>
                  {changed && (
                    <p className="text-xs text-content/50">
                      Save or discard context changes before starting an agent.
                    </p>
                  )}
                </form>
              </>
            )}
            {tab === "Context" && (
              <div className="space-y-5">
                <p className="text-sm leading-6 text-content/50">
                  Saved instructions and documents are automatically included on
                  each member's next turn. Documents live in this project; they
                  are not repository files.
                </p>
                <div className={`${panel} space-y-4`}>
                  <Label title="Project name">
                    <input
                      aria-label="Edit project name"
                      required
                      className={field}
                      value={draft.name}
                      onChange={(event) =>
                        setDraft({ ...draft, name: event.target.value })
                      }
                    />
                  </Label>
                  <Label title="Goal">
                    <textarea
                      aria-label="Edit goal"
                      className={field}
                      value={draft.goal}
                      onChange={(event) =>
                        setDraft({ ...draft, goal: event.target.value })
                      }
                    />
                  </Label>
                  <Label title="Shared instructions">
                    <textarea
                      aria-label="Shared instructions"
                      className={`${field} min-h-36 font-mono text-xs`}
                      placeholder="Conventions, constraints, and how to work together…"
                      value={draft.instructions}
                      onChange={(event) =>
                        setDraft({ ...draft, instructions: event.target.value })
                      }
                    />
                  </Label>
                </div>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Shared documents</h3>
                  <button
                    className={button}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        documents: [
                          ...draft.documents,
                          { id: crypto.randomUUID(), name: "", content: "" },
                        ],
                      })
                    }
                  >
                    <Plus className="size-3.5" />
                    Add document
                  </button>
                </div>
                {!draft.documents.length && (
                  <p className={`${panel} text-sm text-content/45`}>
                    Add a brief, decisions, or a checklist for every agent to
                    reference.
                  </p>
                )}
                {draft.documents.map((doc, index) => (
                  <div className={`${panel} space-y-4`} key={doc.id}>
                    <div className="flex items-center gap-3">
                      <input
                        aria-label={`Document ${index + 1} name`}
                        className={field}
                        placeholder="Document name"
                        value={doc.name}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            documents: draft.documents.map((item) =>
                              item.id === doc.id
                                ? { ...item, name: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                      {onOpenDocument ? (
                        <button
                          type="button"
                          className={button}
                          onClick={() => onOpenDocument(doc)}
                        >
                          Open
                        </button>
                      ) : null}
                      <button
                        className={button}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            documents: draft.documents.filter(
                              (item) => item.id !== doc.id,
                            ),
                          })
                        }
                        aria-label={`Remove document ${index + 1}`}
                      >
                        Remove
                      </button>
                    </div>
                    <textarea
                      aria-label={`Document ${index + 1} content`}
                      className={`${field} min-h-48 font-mono text-xs`}
                      placeholder="Shared context (plain text or Markdown)"
                      value={doc.content}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          documents: draft.documents.map((item) =>
                            item.id === doc.id
                              ? { ...item, content: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            )}
            {tab === "Subscriptions" && (
              <>
                <div className={panel}>
                  <h3 className="flex items-center gap-2 text-sm font-medium">
                    <Clock className="size-4 text-accent" />
                    Local scheduled check-ins
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-content/50">
                    Opt in to recurring prompts in fresh worker chats, without
                    switching your active conversation. Schedules run only while
                    MonoCode is open, use your provider account, and retain
                    supervised permissions. Archived repositories are skipped;
                    missed intervals are not replayed. Workers can run
                    concurrently in the same checkout; review parallel edits.
                  </p>
                  <p className="mt-3 text-xs text-content/40">
                    No cloud execution, Slack subscriptions, or GitHub event
                    subscriptions. Projects support up to 64 team members;
                    unlink finished workers in Agents to make room for scheduled
                    runs. Chats and repository files are preserved.
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Schedules</h3>
                  <button
                    className={button}
                    disabled={blocked || project.archived}
                    onClick={() => openSchedule()}
                  >
                    <Plus className="size-3.5" />
                    Add schedule
                  </button>
                </div>
                {!project.subscriptions.length && (
                  <p className={`${panel} text-sm text-content/45`}>
                    Nothing runs automatically. Add a schedule and explicitly
                    enable it when you're ready.
                  </p>
                )}
                {project.subscriptions.map((item) => (
                  <div className={`${panel} space-y-3`} key={item.id}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h4 className="text-sm font-medium">{item.name}</h4>
                      <label className="flex items-center gap-2 text-xs text-content/60">
                        <input
                          type="checkbox"
                          aria-label={`Enable ${item.name}`}
                          checked={item.enabled}
                          disabled={blocked || project.archived}
                          onChange={() =>
                            item.enabled
                              ? void saveSchedules((items) =>
                                  items.map((sub) =>
                                    sub.id === item.id
                                      ? { ...sub, enabled: false }
                                      : sub,
                                  ),
                                )
                              : openSchedule({ ...item, enabled: true })
                          }
                        />
                        Enabled
                      </label>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm text-content/50">
                      {item.prompt}
                    </p>
                    <p className="text-xs text-content/40">
                      Every {item.intervalMinutes} minutes ·{" "}
                      {project.archived
                        ? "Paused (archived project)"
                        : item.enabled
                          ? `Next due ${new Date(item.nextRunAt).toLocaleString()}`
                          : "Paused"}
                    </p>
                    <div className="flex gap-2">
                      <button
                        className={button}
                        disabled={blocked || project.archived}
                        onClick={() => openSchedule(item)}
                      >
                        Edit schedule
                      </button>
                      <button
                        className={button}
                        disabled={blocked}
                        onClick={() => setDeleteSchedule(item.id)}
                      >
                        Delete schedule
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </fieldset>
        </div>
      </div>
      {changed && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-content/10 bg-background-base px-5 py-3">
          <span className="text-xs text-content/55">
            Unsaved project context
          </span>
          <div className="flex gap-2">
            <button
              className={button}
              disabled={blocked}
              onClick={() => setDiscardContext(true)}
            >
              Discard changes
            </button>
            <button
              className={primary}
              disabled={
                blocked ||
                !draft.name.trim() ||
                !draft.goal.trim() ||
                draft.documents.some((doc) => !doc.name.trim())
              }
              onClick={() => void saveContext()}
            >
              {working ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      )}
      {schedule && (
        <ProjectModal
          title={
            project.subscriptions.some((item) => item.id === schedule.id)
              ? "Edit schedule"
              : "Add schedule"
          }
          onClose={closeSchedule}
        >
          <form
            className="space-y-4 p-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !schedule.name.trim() ||
                !schedule.prompt.trim() ||
                !Number.isInteger(schedule.intervalMinutes) ||
                schedule.intervalMinutes < 15 ||
                schedule.intervalMinutes > 10080 ||
                (schedule.enabled && !consent)
              )
                return;
              const next = {
                ...schedule,
                name: schedule.name.trim(),
                prompt: schedule.prompt.trim(),
                nextRunAt: Date.now() + schedule.intervalMinutes * 60_000,
              };
              void saveSchedules((items) => [
                ...items.filter((item) => item.id !== next.id),
                next,
              ]);
            }}
          >
            <Label title="Schedule name">
              <input
                aria-label="Schedule name"
                disabled={blocked}
                required
                className={field}
                value={schedule.name}
                onChange={(event) => {
                  setSchedule({ ...schedule, name: event.target.value });
                  setScheduleChanged(true);
                }}
              />
            </Label>
            <Label title="Prompt">
              <textarea
                aria-label="Schedule prompt"
                disabled={blocked}
                required
                className={`${field} min-h-24`}
                value={schedule.prompt}
                onChange={(event) => {
                  setSchedule({ ...schedule, prompt: event.target.value });
                  setScheduleChanged(true);
                }}
              />
            </Label>
            <Label title="Interval in minutes (15–10,080)">
              <input
                aria-label="Interval in minutes"
                disabled={blocked}
                type="number"
                min={15}
                max={10080}
                step={1}
                required
                className={field}
                value={schedule.intervalMinutes}
                onChange={(event) => {
                  setSchedule({
                    ...schedule,
                    intervalMinutes: Number(event.target.value),
                  });
                  setScheduleChanged(true);
                }}
              />
            </Label>
            <label className="flex items-center gap-2 text-sm">
              <input
                aria-label="Enable schedule"
                disabled={blocked}
                type="checkbox"
                checked={schedule.enabled}
                onChange={(event) => {
                  setSchedule({ ...schedule, enabled: event.target.checked });
                  setScheduleChanged(true);
                }}
              />
              Enable schedule
            </label>
            <label className="flex items-start gap-3 rounded-lg border border-accent/20 bg-accent/5 p-3 text-xs leading-5 text-content/65">
              <input
                aria-label="Consent to local scheduled runs"
                disabled={blocked}
                className="mt-1 shrink-0"
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>
                I allow automatic prompts while MonoCode is open, using my
                provider account (usage charges may apply) and supervised
                permissions. This is local only, not a cloud or external-event
                subscription.
              </span>
            </label>
            {error && (
              <p role="alert" className="text-sm">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={button} onClick={closeSchedule}>
                Cancel
              </button>
              <button
                className={primary}
                disabled={
                  blocked ||
                  !schedule.name.trim() ||
                  !schedule.prompt.trim() ||
                  (schedule.enabled && !consent)
                }
              >
                {working ? "Saving…" : "Save schedule"}
              </button>
            </div>
          </form>
        </ProjectModal>
      )}
      {unlinkMember && (
        <ProjectModal
          title="Unlink worker?"
          size="sm"
          onClose={() => {
            if (!blocked) setUnlinkMember(null);
          }}
        >
          <div className="space-y-4 p-5">
            <p className="text-sm leading-6 text-content/60">
              Remove this worker from the project team. Its chat and repository
              files are preserved; future turns will no longer receive this
              project's shared context.
            </p>
            {error && (
              <p role="alert" className="text-sm">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                disabled={blocked}
                className={button}
                onClick={() => setUnlinkMember(null)}
              >
                Cancel
              </button>
              <button
                disabled={blocked}
                className={primary}
                onClick={() => void unlinkWorker()}
              >
                {working ? "Unlinking…" : "Unlink worker"}
              </button>
            </div>
          </div>
        </ProjectModal>
      )}
      {discardSchedule && (
        <ProjectModal
          title="Discard schedule changes?"
          size="sm"
          onClose={() => setDiscardSchedule(false)}
        >
          <div className="space-y-4 p-5">
            <p className="text-sm text-content/60">
              The saved schedule will not change.
            </p>
            <div className="flex justify-end gap-2">
              <button
                className={button}
                onClick={() => setDiscardSchedule(false)}
              >
                Keep editing
              </button>
              <button
                className={primary}
                onClick={() => {
                  setSchedule(null);
                  setScheduleChanged(false);
                  setDiscardSchedule(false);
                }}
              >
                Discard
              </button>
            </div>
          </div>
        </ProjectModal>
      )}
      {discardContext && (
        <ProjectModal
          title="Discard context changes?"
          size="sm"
          onClose={() => setDiscardContext(false)}
        >
          <div className="space-y-4 p-5">
            <p className="text-sm text-content/60">
              Reload the saved project and discard your unsaved edits?
            </p>
            <div className="flex justify-end gap-2">
              <button
                className={button}
                onClick={() => setDiscardContext(false)}
              >
                Keep editing
              </button>
              <button
                className={primary}
                onClick={() => {
                  setDraft(project);
                  setBaseline(project);
                  setError("");
                  setSavedNotice("");
                  setDiscardContext(false);
                }}
              >
                Discard
              </button>
            </div>
          </div>
        </ProjectModal>
      )}
      {deleteSchedule && (
        <ProjectModal
          title="Delete schedule?"
          size="sm"
          onClose={() => {
            if (!blocked) setDeleteSchedule(null);
          }}
        >
          <div className="space-y-4 p-5">
            <p className="text-sm text-content/60">
              Future check-ins will stop. Existing chats are preserved.
            </p>
            <div className="flex justify-end gap-2">
              <button
                className={button}
                onClick={() => setDeleteSchedule(null)}
              >
                Cancel
              </button>
              <button
                className={primary}
                disabled={blocked}
                onClick={() => {
                  const id = deleteSchedule;
                  setDeleteSchedule(null);
                  void saveSchedules((items) =>
                    items.filter((item) => item.id !== id),
                  );
                }}
              >
                Delete schedule
              </button>
            </div>
          </div>
        </ProjectModal>
      )}
    </>
  );
}
