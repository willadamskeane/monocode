// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentProjectSubscriptions } from "./useAgentProjectSubscriptions";
import {
  claimDueAgentProjectSubscriptions,
  type AgentProject,
  type AgentProjectSubscription,
} from "../lib/agentProjects";

vi.mock("../lib/agentProjects", () => ({
  claimDueAgentProjectSubscriptions: vi.fn(),
}));

const project = { id: "project", name: "Migration" } as AgentProject;
const subscription = {
  id: "schedule",
  name: "Review",
} as AgentProjectSubscription;
let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useAgentProjectSubscriptions>;

function Host({
  run,
}: {
  run: (
    project: AgentProject,
    subscription: AgentProjectSubscription,
  ) => Promise<void>;
}) {
  state = useAgentProjectSubscriptions(run);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(claimDueAgentProjectSubscriptions)
    .mockReset()
    .mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("local project subscriptions", () => {
  it("does not lose the first due occurrence during StrictMode replay", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    vi.mocked(claimDueAgentProjectSubscriptions).mockResolvedValueOnce([
      { project, subscription },
    ]);
    await act(async () =>
      root.render(
        createElement(StrictMode, null, createElement(Host, { run })),
      ),
    );
    expect(claimDueAgentProjectSubscriptions).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledExactlyOnceWith(project, subscription);
  });

  it("dispatches only claimed runs and polls while mounted", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    vi.mocked(claimDueAgentProjectSubscriptions).mockResolvedValueOnce([
      { project, subscription },
    ]);
    await act(async () => root.render(createElement(Host, { run })));
    expect(run).toHaveBeenCalledExactlyOnceWith(project, subscription);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(claimDueAgentProjectSubscriptions).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not overlap polls and uses the latest callback", async () => {
    let resolve!: (value: []) => void;
    vi.mocked(claimDueAgentProjectSubscriptions).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const initial = vi.fn();
    await act(async () => root.render(createElement(Host, { run: initial })));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(claimDueAgentProjectSubscriptions).toHaveBeenCalledTimes(1);
    await act(async () => resolve([]));
    const latest = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(createElement(Host, { run: latest })));
    vi.mocked(claimDueAgentProjectSubscriptions).mockResolvedValueOnce([
      { project, subscription },
    ]);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(initial).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledExactlyOnceWith(project, subscription);
  });

  it("surfaces failures without preventing other claimed runs", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("Provider unavailable"))
      .mockResolvedValue(undefined);
    vi.mocked(claimDueAgentProjectSubscriptions).mockResolvedValueOnce([
      { project, subscription },
      { project, subscription: { ...subscription, id: "other" } },
    ]);
    await act(async () => root.render(createElement(Host, { run })));
    expect(run).toHaveBeenCalledTimes(2);
    expect(state.error).toContain("Provider unavailable");
    act(() => state.dismissError());
    expect(state.error).toBeNull();
  });

  it("stops polling and does not launch pending claims after unmount", async () => {
    let resolve!: (
      value: Array<{
        project: AgentProject;
        subscription: AgentProjectSubscription;
      }>,
    ) => void;
    vi.mocked(claimDueAgentProjectSubscriptions).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const run = vi.fn();
    await act(async () => root.render(createElement(Host, { run })));
    act(() => root.unmount());
    await act(async () => {
      resolve([{ project, subscription }]);
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(run).not.toHaveBeenCalled();
    expect(claimDueAgentProjectSubscriptions).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });
});
