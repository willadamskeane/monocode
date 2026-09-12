import { projectKey, projectName } from "./paths";
import {
  knownProjectPaths,
  loadArchivedProjects,
  loadPinnedProjects,
  loadProjectRailOrder,
  loadRecents,
  looksLikeProject,
  sameProjectPath,
} from "./recents";
import { loadTabGroupLabels, migrateProjectAppearanceKeys } from "./tabGroups";

const ORDER_KEY = "monocode.projectIds.order";
const PINNED_KEY = "monocode.projectIds.pinned";
const MIGRATED_KEY = "monocode.projectIds.appearanceMigrated";
export const PROJECT_IDENTITY_CHANGED = "monocode:project-identity-changed";

export function projectAppearanceKey(id: string): string {
  return `project:${id}`;
}

function readIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string =>
          typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id),
        ))]
      : [];
  } catch {
    return [];
  }
}

function saveIds(key: string, ids: readonly string[]): void {
  localStorage.setItem(key, JSON.stringify([...new Set(ids)]));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PROJECT_IDENTITY_CHANGED));
  }
}

export const loadProjectOrder = () => readIds(ORDER_KEY);
export const saveProjectOrder = (ids: readonly string[]) => saveIds(ORDER_KEY, ids);
export const loadPinnedProjectIds = () => readIds(PINNED_KEY);
export const savePinnedProjectIds = (ids: readonly string[]) => saveIds(PINNED_KEY, ids);

export function legacyProjectInputs(): Array<{
  cwd: string;
  name: string;
  archived: boolean;
}> {
  const labels = loadTabGroupLabels();
  const archived = loadArchivedProjects();
  return knownProjectPaths().filter(looksLikeProject).map((cwd) => ({
    cwd,
    name: labels[projectKey(cwd)] || projectName(cwd),
    archived: archived.some((entry) => sameProjectPath(entry.path, cwd)),
  }));
}

const APPEARANCE_STORES = [
  "monocode:tab-group:colors",
  "monocode:tab-group:custom-colors",
  "monocode:tab-group:labels",
  "monocode:tab-group:logos",
  "monocode:tab-group:mascots",
  "monocode:project-chat-backgrounds",
  "monocode.sessionFolders",
  "monocode.pinnedSessionsCollapsed",
  "monocode.reminderSessionsCollapsed",
];

type MigratableProject = { id: string; cwd: string; legacyDefault?: boolean };

/**
 * Copy legacy appearance only to a repository's default project. Keep source
 * values for recovery, and mark each project only after every write succeeds.
 */
export function migrateLegacyProjectAppearance(
  projects: readonly MigratableProject[],
): void {
  migrateProjectAppearanceKeys();
  const migrated = new Set(readIds(MIGRATED_KEY));
  const defaults = projects.filter((project) => project.legacyDefault);
  const orderPaths = [
    ...loadProjectRailOrder(),
    ...loadRecents().map((entry) => entry.path),
    ...knownProjectPaths(),
  ];
  const legacyOrder = orderPaths.flatMap((path) => {
    const project = defaults.find((item) => sameProjectPath(item.cwd, path));
    return project ? [project.id] : [];
  });
  for (const project of defaults) {
    if (migrated.has(project.id)) continue;
    const target = projectAppearanceKey(project.id);
    for (const store of APPEARANCE_STORES) {
      let value: unknown;
      try {
        value = JSON.parse(localStorage.getItem(store) ?? "{}");
      } catch {
        // A corrupt appearance preference must not hide migrated conversations.
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(record, target)) continue;
      const source = Object.keys(record).find((key) =>
        !key.startsWith("project:") && sameProjectPath(key, project.cwd),
      );
      if (source !== undefined) {
        localStorage.setItem(store, JSON.stringify({ ...record, [target]: record[source] }));
      }
    }
    const order = loadProjectOrder();
    const pendingOrder = legacyOrder.filter((id) => !migrated.has(id));
    saveProjectOrder([...order, ...pendingOrder, project.id]);
    const pinned = loadPinnedProjects().some((path) =>
      sameProjectPath(path, project.cwd),
    );
    if (pinned) savePinnedProjectIds([...loadPinnedProjectIds(), project.id]);
    migrated.add(project.id);
    saveIds(MIGRATED_KEY, [...migrated]);
  }
}
