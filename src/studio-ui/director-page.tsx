"use client";

import Link from "next/link";
import { useMemo } from "react";

import { when } from "./api";
import { DirectorPanel } from "./director-panel";
import { filmShots } from "./film";
import { needsOf, type LintWarning } from "./needs";
import { NeedsYou } from "./score-page";
import { useProjectContext } from "./shell";
import { useT } from "./i18n";
import { useLint } from "./use-lint";

/* The director's desk: who decides what. On the left what waits for the
   person; in the middle every check in one list (the Board's lint, the
   treatment, the look's constraints, the seams of the cut); on the right
   what the director may do without asking, what was asked of it and what it
   decided. It used to be a card at the bottom of Project settings. */

export function DirectorPage() {
  const { projectId, view } = useProjectContext();
  const lint = useLint(projectId, view);
  const t = useT();
  const shots = useMemo(() => (view ? filmShots(view) : []), [view]);
  if (!view) return null;
  const base = `/p/${projectId}`;
  const needs = needsOf(view, lint, base, t);
  const rolling = shots.flatMap((s) => s.shot.takes).filter((t) => t.status === "queued" || t.status === "running");
  const slateOf = (w: LintWarning) => {
    const s = shots.find((x) => x.scene.slug === w.scene && x.shot.index + 1 === w.shot);
    return s ? { label: s.slate, href: `${base}/board?shot=${s.shot.id}` } : undefined;
  };
  const loud = (lint?.warnings ?? []).filter((w) => w.severity !== "info");
  const notes = (lint?.warnings ?? []).filter((w) => w.severity === "info");
  /* loud ones grouped when they say the same thing in several places */
  const loudGroups = groupBy(loud, (w) => `${w.severity}:${w.code}`);
  const noteGroups = groupBy(notes, (w) => w.code).sort((a, b) => b.items.length - a.items.length);

  return (
    <div className="st-page dir-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Who decides what</h1>
          <p className="st-subtitle">What waits for you, what the checks found, and what the director may do without asking.</p>
        </div>
        <div className="dir-status">
          {rolling.length > 0
            ? <span className="st-lamp" data-state="running">{rolling.length} {rolling.length === 1 ? "take is" : "takes are"} rolling</span>
            : <span className="st-lamp" data-state="draft">Nothing is rolling · last change {when(view.project.updatedAt)}</span>}
        </div>
      </div>

      <div className="dir-cols">
        <div className="dir-col">
          <NeedsYou needs={needs} base={base} full />
        </div>

        <section className="dir-col dir-col--wide" id="problems" aria-label="Problems">
          <div className="cut-h-row">
            <h2 className="cut-h">Problems</h2>
            <span className="st-num">{lint ? `${lint.counts.error} ${lint.counts.error === 1 ? "error" : "errors"} · ${lint.counts.warn} ${lint.counts.warn === 1 ? "warning" : "warnings"} · ${lint.counts.info} notes` : "checking…"}</span>
          </div>
          {lint && loud.length === 0 && <p className="st-muted dir-none">No errors and no warnings.</p>}
          {loudGroups.map((g) => {
            const first = g.items[0]!;
            const places = g.items.map(slateOf).filter((x): x is { label: string; href: string } => Boolean(x));
            const open = first.code.startsWith("seam.") ? { label: "Open in Cut", href: `${base}/timeline#seams` } : first.code.startsWith("treatment") ? { label: "Open Script", href: `${base}/script` } : first.code.startsWith("look.") ? { label: "Open Brief & style", href: `${base}/look` } : places[0] ? { label: `Open ${places[0].label}`, href: places[0].href } : undefined;
            return (
              <div key={g.key} className="dir-warn" data-severity={first.severity}>
                <i className="sc-bang">{first.severity === "error" ? "×" : "!"}</i>
                <div>
                  <strong>{g.items.length > 1 ? sameMessage(g.items) : first.message}</strong>
                  <span className="st-num">{first.code}{g.items.length > 1 ? ` × ${g.items.length}` : ""}{places.length ? ` · ${places.map((p) => p.label).join(", ")}` : first.scene ? ` · ${first.scene}` : " · film"}</span>
                </div>
                {open && <Link className="st-link" href={open.href}>{open.label}</Link>}
              </div>
            );
          })}
          {noteGroups.length > 0 && (
            <>
              <span className="sc-cap dir-notes-cap">Notes · {notes.length}, by kind</span>
              <div className="st-table-scroll">
                <table className="st-table dir-notes">
                  <thead><tr><th>Check</th><th>n</th><th>Where and what</th></tr></thead>
                  <tbody>
                    {noteGroups.map((g) => {
                      const places = g.items.map(slateOf).filter((x): x is { label: string; href: string } => Boolean(x));
                      return (
                        <tr key={g.key}>
                          <td className="st-num">{g.key}</td>
                          <td className="st-num">{g.items.length}</td>
                          <td>
                            {places.length > 0 && <span className="st-num dir-places">{places.map((p, i) => <span key={p.href}>{i > 0 ? ", " : ""}<Link href={p.href}>{p.label}</Link></span>)}. </span>}
                            {g.items[0]!.message}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <div className="dir-col">
          <DirectorPanel projectId={projectId} />
        </div>
      </div>
    </div>
  );
}

function groupBy<T>(items: T[], key: (x: T) => string): Array<{ key: string; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const x of items) map.set(key(x), [...(map.get(key(x)) ?? []), x]);
  return [...map.entries()].map(([k, v]) => ({ key: k.includes(":") ? k.split(":").slice(1).join(":") : k, items: v }));
}

/* several warnings of one kind: their message when it is the same, else the first with a count */
function sameMessage(items: LintWarning[]): string {
  const first = items[0]!.message;
  return items.every((w) => w.message === first) ? first : `${first} (and ${items.length - 1} more like it)`;
}
