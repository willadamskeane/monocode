import type { AgentProject } from "./agentProjects";
import { newDefaultSession, type Session } from "./session";

export function newAgentProjectSession(
  project: AgentProject,
  prompt: string,
  title: string,
): Session {
  if (project.archived)
    throw new Error("Restore this project before starting an agent.");
  if (!prompt.trim())
    throw new Error("Describe the task before starting an agent.");
  return {
    ...newDefaultSession(project.cwd, "supervised"),
    title: Array.from(title.trim() || project.name)
      .slice(0, 50)
      .join(""),
    composerSeed: prompt.trim(),
  };
}
