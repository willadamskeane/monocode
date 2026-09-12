import { useEffect, useState } from "react";
import { MarkdownPreview } from "./AgentMarkdown";
import {
  loadAgentProjects,
  saveAgentProject,
  type AgentProjectDocument,
} from "../lib/agentProjects";
import type { ProjectDocumentSource } from "../lib/layout";

type Props = {
  source: ProjectDocumentSource;
};

export function ProjectDocumentSurface({ source }: Props) {
  const [document, setDocument] = useState<AgentProjectDocument | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadAgentProjects()
      .then((projects) => {
        if (cancelled) return;
        const project = projects.find((item) => item.id === source.projectId);
        const next = project?.documents.find(
          (item) => item.id === source.documentId,
        );
        setDocument(next ?? null);
        setText(next?.content ?? "");
        setError(next ? "" : "This document is no longer in the project.");
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [source.documentId, source.projectId]);

  const save = async () => {
    if (!document || saving) return;
    setSaving(true);
    setError("");
    try {
      const projects = await loadAgentProjects();
      const project = projects.find((item) => item.id === source.projectId);
      if (!project) throw new Error("This project no longer exists.");
      await saveAgentProject({
        ...project,
        documents: project.documents.map((item) =>
          item.id === document.id ? { ...item, content: text } : item,
        ),
      });
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background-base">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-content/10 px-3">
        <span className="min-w-0 flex-1 truncate text-sm text-content">
          {source.name}
        </span>
        <button
          type="button"
          disabled={!document || saving}
          onClick={() => void save()}
          className="rounded-md px-2 py-1 text-xs text-content/70 hover:bg-content/8 hover:text-content disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="px-3 py-2 text-xs text-content/60">
          {error}
        </p>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
        <textarea
          aria-label={source.name}
          disabled={!document}
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="h-full min-h-0 resize-none border-r border-content/10 bg-transparent p-4 font-mono text-[13px] leading-6 text-content outline-none"
        />
        <div className="min-h-0 overflow-auto p-4">
          <MarkdownPreview text={text} />
        </div>
      </div>
    </div>
  );
}
