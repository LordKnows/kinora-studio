"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import type { ProjectView } from "@/studio/orchestrator";

import { describe, post } from "./api";
import { filmShots } from "./film";
import { useT } from "./i18n";

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
  const tr = useT();
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
            {/* a notice is worded where it is raised; a fixed English one ("Undo") is translated here */}
            <span className="nt-text">{tr(n.text)}</span>
            {n.action && (n.action.href
              ? <Link className="nt-action" href={n.action.href} onClick={() => drop(n.id)}>{tr(n.action.label)}</Link>
              : <button type="button" className="nt-action" onClick={() => { n.action!.run?.(); drop(n.id); }}>{tr(n.action.label)}</button>)}
            <button type="button" className="nt-close" aria-label={tr("Dismiss")} onClick={() => drop(n.id)}>×</button>
          </div>
        ))}
      </div>
    </NoticeContext.Provider>
  );
}

/** Watch the project's takes and say when one finishes or fails. */
export function useTakeNotices(view: ProjectView | null, base: string) {
  const tr = useT();
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
          const text = tr("Take {n} of {slate} finished", { n: t.n, slate: s.slate });
          const canAsk = typeof Notification !== "undefined" && Notification.permission === "default" && !asked.current;
          notify({
            text, mark: "done", ttlMs: 15_000,
            action: canAsk
              ? { label: tr("Tell me in the background too"), run: () => { asked.current = true; void Notification.requestPermission(); } }
              : { label: tr("Screen it"), href: `${base}/screening?shot=${s.shot.id}&take=${t.id}` },
          });
          if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
            try { new Notification(`${view.project.name}: ${text}`, { body: s.shot.spec.intent, tag: t.id }); } catch { /* some browsers only notify from a service worker */ }
          }
        } else if (t.status === "failed" || t.status === "timeout") {
          notify({ text: tr("Take {n} of {slate} failed{why}", { n: t.n, slate: s.slate, why: t.error ? `: ${t.error.slice(0, 90)}` : "" }), mark: "ng", ttlMs: 20_000, action: { label: tr("Open the shot"), href: `${base}/board?shot=${s.shot.id}&tab=takes` } });
        }
      }
    }
  }, [view, base, notify, tr]);
}

/** After a delete: a notice whose Undo puts the thing back from the trash. */
export function useUndoable(after: () => Promise<void> | void) {
  const tr = useT();
  const notify = useNotify();
  return useCallback((trashId: string | undefined, text: string) => {
    if (!trashId) return;
    notify({
      text, mark: "undo", ttlMs: 15_000,
      action: {
        label: tr("Undo"),
        run: () => {
          void post(`/api/trash/${trashId}/restore`).then(() => after(), (caught) => notify({ text: tr("Could not put it back: {why}", { why: describe(caught) }), mark: "ng" }));
        },
      },
    });
  }, [notify, after, tr]);
}
