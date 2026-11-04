"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ProjectView } from "@/studio/orchestrator";

import { describe, get } from "./api";

/* The aggregate view, kept fresh: one fetch on mount, a refetch whenever the
   SSE snapshot changes, and a 5 s poll if EventSource cannot connect. */

export function useProject(projectId: string) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const next = await get<ProjectView>(`/api/projects/${projectId}`);
      if (!alive.current) return;
      setView(next);
      setError(null);
    } catch (caught) {
      if (alive.current) setError(describe(caught));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    alive.current = true;
    void reload();
    let poll: ReturnType<typeof setInterval> | null = null;
    let source: EventSource | null = null;
    const startPoll = () => {
      if (poll) return;
      poll = setInterval(() => void reload(), 5000);
    };
    if (typeof EventSource !== "undefined") {
      source = new EventSource(`/api/projects/${projectId}/events`);
      source.addEventListener("snapshot", () => void reload());
      source.onerror = () => {
        source?.close();
        source = null;
        startPoll();
      };
    } else {
      startPoll();
    }
    return () => {
      alive.current = false;
      source?.close();
      if (poll) clearInterval(poll);
    };
  }, [projectId, reload]);

  return { view, error, loading, reload };
}
