import { useEffect, useRef, useState } from "react";
import {
  claimDueAgentProjectSubscriptions,
  type AgentProject,
  type AgentProjectSubscription,
} from "../lib/agentProjects";

export function useAgentProjectSubscriptions(
  run: (
    project: AgentProject,
    subscription: AgentProjectSubscription,
  ) => Promise<void>,
) {
  const callback = useRef(run);
  callback.current = run;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let polling = false;
    const poll = async () => {
      if (disposed || polling) return;
      polling = true;
      try {
        // SQLite claims each occurrence once, even with several windows open.
        const due = await claimDueAgentProjectSubscriptions(Date.now());
        for (const { project, subscription } of due) {
          if (disposed) return;
          try {
            await callback.current(project, subscription);
          } catch (error) {
            if (!disposed) {
              setError(
                `${project.name} · ${subscription.name}: ${String(error)}`,
              );
            }
          }
        }
      } catch (error) {
        if (!disposed) setError(`Local subscriptions: ${String(error)}`);
      } finally {
        polling = false;
      }
    };
    // Wait until StrictMode's setup/cleanup replay has finished before claiming
    // an occurrence that only the surviving effect can dispatch.
    queueMicrotask(() => void poll());
    const timer = window.setInterval(() => void poll(), 30_000);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return { error, dismissError: () => setError(null) };
}
