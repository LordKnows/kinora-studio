"use client";

import Link from "next/link";
import { useMemo } from "react";

import type { ProjectView } from "@/studio/orchestrator";

import { filmShots } from "./film";
import { plural, useLang, useT, type T } from "./i18n";
import type { LintReport, LintWarning } from "./needs";
import { lintLine } from "./zh/lint";

/* Every check in one list, at the foot of the Reel (#problems): the Board's
   lint, the treatment, the Look's constraints, the seams of the cut. Errors
   and warnings first, grouped when they say the same thing in several
   places; then the notes, by kind. It was the middle of the Director page. */
export function ProblemsList({ view, lint, base }: { view: ProjectView; lint: LintReport | null; base: string }) {
  const t = useT();
  const lang = useLang();
  const shots = useMemo(() => filmShots(view), [view]);
  /* a group of findings as the page shows it: in Chinese, what the code means,
     with the server's own message beneath */
  const say = (items: LintWarning[]) => {
    const line = lintLine(lang, items[0]!);
    const message = items.length > 1 ? sameMessage(items, t) : items[0]!.message;
    return line.detail ? { text: line.text, detail: message } : { text: message };
  };
  const slateOf = (w: LintWarning) => {
    const s = shots.find((x) => x.scene.slug === w.scene && x.shot.index + 1 === w.shot);
    return s ? { label: s.slate, href: `${base}/board?shot=${s.shot.id}` } : undefined;
  };
  const loud = (lint?.warnings ?? []).filter((w) => w.severity !== "info");
  const notes = (lint?.warnings ?? []).filter((w) => w.severity === "info");
  const loudGroups = groupBy(loud, (w) => `${w.severity}:${w.code}`);
  const noteGroups = groupBy(notes, (w) => w.code).sort((a, b) => b.items.length - a.items.length);

  return (
    <section className="dir-problems" id="problems" aria-label={t("Problems")}>
      <div className="cut-h-row">
        <h2 className="cut-h">{t("Problems")}</h2>
        <span className="st-num">{lint ? `${plural(t, lint.counts.error, "1 error", "{n} errors")} · ${plural(t, lint.counts.warn, "1 warning", "{n} warnings")} · ${t("{n} notes", { n: lint.counts.info })}` : t("checking…")}</span>
      </div>
      {lint && loud.length === 0 && <p className="st-muted dir-none">{t("No errors and no warnings.")}</p>}
      {loudGroups.map((g) => {
        const first = g.items[0]!;
        const said = say(g.items);
        const places = g.items.map(slateOf).filter((x): x is { label: string; href: string } => Boolean(x));
        const open = first.code.startsWith("seam.") ? { label: t("Open in Cut"), href: `${base}/cut#seams` } : first.code.startsWith("treatment") ? { label: t("Open Story"), href: `${base}/story` } : first.code.startsWith("look.") ? { label: t("Open the Look"), href: `${base}/design` } : places[0] ? { label: t("Open {s}", { s: places[0].label }), href: places[0].href } : undefined;
        return (
          <div key={g.key} className="dir-warn" data-severity={first.severity}>
            <i className="sc-bang">{first.severity === "error" ? "×" : "!"}</i>
            <div>
              <strong>{said.text}</strong>
              {said.detail && <span className="dir-detail">{said.detail}</span>}
              <span className="st-num">{first.code}{g.items.length > 1 ? ` × ${g.items.length}` : ""}{places.length ? ` · ${places.map((p) => p.label).join(", ")}` : first.scene ? ` · ${first.scene}` : t(" · film")}</span>
            </div>
            {open && <Link className="st-link" href={open.href}>{open.label}</Link>}
          </div>
        );
      })}
      {noteGroups.length > 0 && (
        <>
          <span className="sc-cap dir-notes-cap">{t("Notes · {n}, by kind", { n: notes.length })}</span>
          <div className="st-table-scroll">
            <table className="st-table dir-notes">
              <thead><tr><th>{t("Check||lint")}</th><th>n</th><th>{t("Where and what")}</th></tr></thead>
              <tbody>
                {noteGroups.map((g) => {
                  const places = g.items.map(slateOf).filter((x): x is { label: string; href: string } => Boolean(x));
                  const line = lintLine(lang, g.items[0]!);
                  return (
                    <tr key={g.key}>
                      <td className="st-num">{g.key}</td>
                      <td className="st-num">{g.items.length}</td>
                      <td>
                        {places.length > 0 && <span className="st-num dir-places">{places.map((p, i) => <span key={p.href}>{i > 0 ? ", " : ""}<Link href={p.href}>{p.label}</Link></span>)}. </span>}
                        {line.text}{line.detail && <span className="dir-detail">{line.detail}</span>}
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
  );
}

function groupBy<X>(items: X[], key: (x: X) => string): Array<{ key: string; items: X[] }> {
  const map = new Map<string, X[]>();
  for (const x of items) map.set(key(x), [...(map.get(key(x)) ?? []), x]);
  return [...map.entries()].map(([k, v]) => ({ key: k.includes(":") ? k.split(":").slice(1).join(":") : k, items: v }));
}

/* several warnings of one kind: their message when it is the same, else the first with a count */
function sameMessage(items: LintWarning[], t: T): string {
  const first = items[0]!.message;
  return items.every((w) => w.message === first) ? first : t("{first} (and {n} more like it)", { first, n: items.length - 1 });
}
