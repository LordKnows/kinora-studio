"use client";

import { useEffect, useState } from "react";

import { get } from "./api";
import { Empty, ErrorBanner, Skeleton } from "./common";
import { LorasPage } from "./loras-page";
import { ModelsGallery } from "./models-page";

/* Library: what every project draws from — the style presets of the
   director layer and the LoRA library. */

type StyleCard = { slug: string; en: string; cn: string; category: string; uses: string[]; line: string; line_cn: string };

export function LibraryPage() {
  const [tab, setTab] = useState<"styles" | "loras" | "models">("styles");
  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Library</h1>
          <p className="st-subtitle">Style presets the director compiles into a Look, the LoRAs a project can switch on, and the models the Studio runs with the settings they recommend. Shared across projects.</p>
        </div>
        <div className="st-tabs" role="tablist" style={{ width: 360, maxWidth: "100%" }}>
          {(["styles", "loras", "models"] as const).map((t) => (
            <button key={t} type="button" role="tab" className="st-tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === "styles" ? "Styles" : t === "loras" ? "LoRAs" : "Models"}
            </button>
          ))}
        </div>
      </div>
      {tab === "styles" ? <StyleGallery /> : tab === "loras" ? <LorasPage embedded /> : <ModelsGallery />}
    </div>
  );
}

export function StyleGallery({ selected, onPick }: { selected?: string; onPick?: (slug: string) => void }) {
  const [styles, setStyles] = useState<StyleCard[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string>("");
  useEffect(() => {
    get<{ styles: StyleCard[] }>("/api/styles").then((r) => setStyles(r.styles)).catch(setError);
  }, []);
  useEffect(() => {
    if (!open) return;
    setMarkdown("");
    get<{ markdown: string }>(`/api/styles/${open}`).then((r) => setMarkdown(r.markdown)).catch(() => setMarkdown("Could not load this style."));
  }, [open]);
  if (error) return <ErrorBanner error={error} onDismiss={() => setError(null)} />;
  if (!styles) return <div className="st-styles"><Skeleton height={150} /><Skeleton height={150} /><Skeleton height={150} /></div>;
  if (styles.length === 0) return <Empty title="No styles" hint="The director package ships 16 presets; the build generates them into the studio." />;
  const groups = new Map<string, StyleCard[]>();
  for (const s of styles) groups.set(s.category, [...(groups.get(s.category) ?? []), s]);
  return (
    <div className="st-stack" style={{ gap: 28 }}>
      {[...groups.entries()].map(([category, list]) => (
        <section key={category}>
          <div className="st-section-title" style={{ marginBottom: 12 }}>
            <span style={{ textTransform: "capitalize" }}>{category.replace(/[-_]/g, " ")}</span>
            <small>{list.length}</small>
          </div>
          <div className="st-styles">
            {list.map((s) => (
              <button key={s.slug} type="button" className="st-style" aria-pressed={selected === s.slug} onClick={() => (onPick ? onPick(s.slug) : setOpen(open === s.slug ? null : s.slug))}>
                <span className="st-style-swatch" />
                <span className="st-style-name">{s.en}</span>
                <span className="st-style-cn">{s.cn}</span>
                <span className="st-style-line">{s.line}</span>
                <span className="st-chips" style={{ marginTop: "auto" }}>
                  {s.uses.slice(0, 3).map((u) => <span key={u} className="st-chip st-chip--mono">{u}</span>)}
                </span>
              </button>
            ))}
          </div>
          {open && list.some((s) => s.slug === open) && (
            <div className="st-card" style={{ marginTop: 14 }}>
              <div className="st-row st-row--between" style={{ marginBottom: 10 }}>
                <span className="st-h2">{list.find((s) => s.slug === open)!.en} · STYLE.md</span>
                <button type="button" className="st-btn st-btn--quiet st-btn--sm" onClick={() => setOpen(null)}>Close</button>
              </div>
              <pre className="st-pre" style={{ maxHeight: 560 }}>{markdown || "Loading…"}</pre>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
