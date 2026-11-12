"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import type { ProjectView } from "@/studio/orchestrator";

import { filmShots } from "./film";

/* Notices: a short line at the bottom of the screen with at most one action —
   a take that finished or failed while you were elsewhere in the project, or
   the undo of something just removed. They go by themselves; the undo one
   stays as long as it is worth acting on. When the tab is in the background
   and the person allowed it, a finished take is also a system notification. */

export type Notice = { id: number; text: string; action?: { label: string; href?: string; run?: () => void }; ttlMs?: number; mark?: "done" | "ng" | "undo" };
type Ctx = { notify: (n: Omit<Notice, "id">) => void };

const NoticeContext = createContext<Ctx>({ notify: () => undefined });

export function useNotify() {
  return useContext(NoticeContext).notify;
}

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Notice[]>([]);
  const seq = useRef(0);
  const drop = useCallback((id: number) => setList((xs) => xs.filter((x) => x.id !== id)), []);
  const notify = useCallback((n: Omit<Notice, "id">) => {
    const id = ++seq.current;
    setList((xs) => [...xs.slice(-3), { ...n, id }]);
    window.setTimeout(() => drop(id), n.ttlMs ?? 10_000);
  }, [drop]);
  return (
    <NoticeContext.Provider value={{ notify }}>
      {children}
      <div className="nt-region" role="status" aria-live="polite">
        {list.map((n) => (
          <div key={n.id} className="nt" data-mark={n.mark}>
            <span className="nt-text">{n.text}</span>
            {n.action && (n.action.href
              ? <Link className="nt-action" href={n.action.href} onClick={() => drop(n.id)}>{n.action.label}</Link>
              : <button type="button" className="nt-action" onClick={() => { n.action!.run?.(); drop(n.id); }}>{n.action.label}</button>)}
            <button type="button" className="nt-close" aria-label="Dismiss" onClick={() => drop(n.id)}>×</button>
          </div>
        ))}
      </div>
    </NoticeContext.Provider>
  );
}

/** Watch the project's takes and say when one finishes or fails. */
export function useTakeNotices(view: ProjectView | null, base: string) {
  const notify = useNotify();
  const seen = useRef<Map<string, string> | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (!view) return;
    const shots = filmShots(view);
    const now = new Map<string, string>();
    for (const s of shots) for (const t of s.shot.takes) now.set(t.id, t.status);
    const before = seen.current;
    seen.current = now;
    if (!before) return; /* the first look only learns what is there */
    for (const s of shots) {
      for (const t of s.shot.takes) {
        const was = before.get(t.id);
        if (was !== "queued" && was !== "running") continue;
        if (t.status === "completed") {
          const text = `Take ${t.n} of ${s.slate} finished`;
          const canAsk = typeof Notification !== "undefined" && Notification.permission === "default" && !asked.current;
          notify({
            text, mark: "done", ttlMs: 15_000,
            action: canAsk
              ? { label: "Tell me in the background too", run: () => { asked.current = true; void Notification.requestPermission(); } }
              : { label: "Screen it", href: `${base}/screening?shot=${s.shot.id}&take=${t.id}` },
          });
          if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
            try { new Notification(`${view.project.name}: ${text}`, { body: s.shot.spec.intent, tag: t.id }); } catch { /* some browsers only notify from a service worker */ }
          }
        } else if (t.status === "failed" || t.status === "timeout") {
          notify({ text: `Take ${t.n} of ${s.slate} failed${t.error ? `: ${t.error.slice(0, 90)}` : ""}`, mark: "ng", ttlMs: 20_000, action: { label: "Open the shot", href: `${base}/board?shot=${s.shot.id}&tab=takes` } });
        }
      }
    }
  }, [view, base, notify]);
}
