"use client";

import { useCallback, useEffect, useState } from "react";

import { get, post } from "./api";
import { Button, ErrorBanner, useAction, whenT } from "./common";
import { useT } from "./i18n";

/* What was deleted and can still be put back: a project's shots, scenes,
   elements and pictures (the Director page), or whole projects (the Projects
   page). Each entry goes for good TRASH_DAYS after it was deleted. */

type Entry = { id: string; kind: string; label: string; createdAt: number; expiresAt: number; by?: string; projectId?: string | null };

export function RecentlyDeleted({ projectId, onRestored }: { projectId?: string; onRestored?: (entry: Entry) => Promise<void> | void }) {
  const t = useT();
  const [list, setList] = useState<Entry[] | null>(null);
  const [days, setDays] = useState(14);
  const load = useCallback(async () => {
    const r = projectId
      ? await get<{ trash: Entry[]; days: number }>(`/api/projects/${projectId}/trash`).then((x) => ({ list: x.trash, days: x.days }))
      : await get<{ projects: Entry[]; days: number }>("/api/trash/projects").then((x) => ({ list: x.projects, days: x.days }));
    setList(r.list);
    setDays(r.days);
  }, [projectId]);
  useEffect(() => {
    void load().catch(() => setList([]));
  }, [load]);
  const restore = useAction(async (_c, entry: Entry) => {
    await post(`/api/trash/${entry.id}/restore`);
    await load();
    await onRestored?.(entry);
  });
  if (!list || (list.length === 0 && !projectId)) return null;
  return (
    <section className="rd" aria-label={t("Recently deleted")}>
      <div className="cut-h-row">
        <h2 className="cut-h">{t("Recently deleted")}</h2>
        <span className="st-num">{t("kept {n} days", { n: days })}</span>
      </div>
      <ErrorBanner error={restore.error} onDismiss={restore.dismiss} />
      {list.length === 0 ? (
        <p className="st-muted rd-none">{t("Nothing deleted in the last {n} days.", { n: days })}</p>
      ) : (
        list.map((e) => (
          <div key={e.id} className="rd-row">
            <span className="rd-kind st-num">{t(`${e.kind}||deleted`)}</span>
            <span className="rd-label">{e.label}</span>
            <span className="st-num rd-when">{whenT(t, e.createdAt)}{e.by ? ` · ${e.by}` : ""}</span>
            <Button size="sm" busy={restore.busy} onClick={() => void restore.fire(e)}>{t("Put back")}</Button>
          </div>
        ))
      )}
    </section>
  );
}
