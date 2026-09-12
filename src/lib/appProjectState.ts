import type { AgentProject } from "./agentProjects";
import { looksLikeProject, sameProjectPath } from "./recents";
import type { Session } from "./session";

/**
 * Stamp in-memory chats with the agent project they belong to after legacy
 * folders have been migrated. Persisted ownership is assigned natively;
 * this only covers the live workspace that has not been saved yet.
 */
export function restoreProjectOwnership(
  sessions: readonly Session[],
  projects: readonly AgentProject[],
): Session[] {
  return sessions.map((session) => {
    if (session.projectId) return session;
    const member = projects.find((project) =>
      project.members.some((entry) => entry.sessionId === session.id),
    );
    if (member) return { ...session, projectId: member.id };
    if (!looksLikeProject(session.cwd)) return session;
    const fallback =
      projects.find(
        (project) =>
          project.legacyDefault && sameProjectPath(project.cwd, session.cwd),
      ) ??
      projects.find((project) => sameProjectPath(project.cwd, session.cwd));
    return fallback ? { ...session, projectId: fallback.id } : session;
  });
}

export function resolveActiveAgentProject(
  projects: readonly AgentProject[],
  preferredId: string | undefined,
  cwd: string,
): AgentProject | undefined {
  const active = projects.filter((project) => !project.archived);
  if (preferredId) {
    const preferred = active.find((project) => project.id === preferredId);
    if (preferred) return preferred;
  }
  if (looksLikeProject(cwd)) {
    const forCwd = active.filter((project) =>
      sameProjectPath(project.cwd, cwd),
    );
    return (
      forCwd.find((project) => project.legacyDefault) ?? forCwd[0]
    );
  }
  return active[0];
}
