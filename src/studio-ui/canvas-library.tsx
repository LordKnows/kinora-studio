"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { POSE_PICTURES, type PosePicture } from "@/studio/canvas-prompt";

import {
  COSTUME_SOURCES,
  POSE_ANGLES,
  POSE_SYSTEMS,
  REF_KIND_LABEL,
  REFERENCE_TERMS,
  referenceImage,
  referenceName,
  searchText,
  type PoseAngle,
  type RefCostume,
  type RefItem,
  type RefKind,
  type RefPortrait,
  type RefPose,
  MINE_LABEL,
} from "@/studio/references-model";

import { del, get, patch, post } from "./api";
import { Button, Empty, ErrorBanner, Modal, Skeleton } from "./common";
import { useT } from "./i18n";
import { CheckIcon, OpenOutIcon, PlusIcon, UploadIcon } from "./icons";
import { FaceBadge } from "./pictures";
import { uploadToMine } from "./upload";

/* The Canvas library: portraits, costumes and poses, filtered in the
   browser. Thumbnails load from the galleries themselves (no referrer is
   sent); nothing is copied unless a picture is used. */

type ListAnswer = { kind: RefKind; adult: boolean; items: RefItem[]; hidden: number };

const cache = new Map<string, Promise<ListAnswer>>();

export function useReferences(kind: RefKind, adultVersion: number): { data: ListAnswer | null; error: unknown } {
  const [state, setState] = useState<{ key: string; data: ListAnswer | null; error: unknown }>({ key: "", data: null, error: null });
  const key = `${kind}:${adultVersion}`;
  useEffect(() => {
    let live = true;
    if (!cache.has(key)) cache.set(key, get<ListAnswer>(`/api/references?kind=${kind}`));
    cache.get(key)!.then(
      (data) => live && setState({ key, data, error: null }),
      (error) => {
        cache.delete(key);
        if (live) setState({ key, data: null, error });
      },
    );
    return () => {
      live = false;
    };
  }, [key, kind]);
  return state.key === key ? { data: state.data, error: state.error } : { data: null, error: null };
}

/** Forget the loaded lists (after 我的 changed): the tabs load again when they show. */
export function invalidateReferences(): void {
  cache.clear();
}

/** Load a kind's list outside a component (random picks). */
export function loadReferences(kind: RefKind, adultVersion: number): Promise<ListAnswer> {
  const key = `${kind}:${adultVersion}`;
  if (!cache.has(key)) cache.set(key, get<ListAnswer>(`/api/references?kind=${kind}`));
  return cache.get(key)!;
}

export type UseOptions = { depth?: boolean; view?: string };

export type LibraryTab = RefKind | "mine";

type Props = {
  kind: LibraryTab;
  onKind: (k: LibraryTab) => void;
  adultVersion: number;
  adult: boolean;
  depth: boolean;
  onDepth: (d: boolean) => void;
  selected: Partial<Record<RefKind, string>>;
  onUse: (item: RefItem, opts: UseOptions) => void;
  onImport?: (item: RefItem, opts: UseOptions) => Promise<string>;
};

const PAGE = 60;

export function CanvasLibrary(props: Props) {
  const { kind, onKind } = props;
  const tr = useT();
  return (
    <div className="st-stack" style={{ gap: 14 }}>
      <div className="st-tabs" role="tablist" aria-label={tr("Reference library")}>
        {(["portrait", "costume", "pose"] as const).map((k) => (
          <button key={k} type="button" role="tab" className="st-tab" aria-selected={kind === k} onClick={() => onKind(k)}>
            {REF_KIND_LABEL[k].en} <span className="st-muted">{REF_KIND_LABEL[k].zh}</span>
          </button>
        ))}
        <button type="button" role="tab" className="st-tab" aria-selected={kind === "mine"} onClick={() => onKind("mine")}>
          Mine <span className="st-muted">{MINE_LABEL}</span>
        </button>
      </div>
      {kind === "portrait" && <PortraitBrowser {...props} />}
      {kind === "costume" && <CostumeBrowser {...props} />}
      {kind === "pose" && <PoseBrowser {...props} />}
      {kind === "mine" && <MineBrowser {...props} />}
    </div>
  );
}

/* ---------- shared pieces ---------- */

function Pills<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; label: string; count?: number }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="st-chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id || "all"} type="button" className="st-chip st-chip--btn" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
          {o.count !== undefined && <span className="st-num st-muted">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const tr = useT();
  return <input className="st-input st-input--sm st-ref-search" type="search" value={value} placeholder={placeholder} aria-label={tr("Search")} onChange={(e) => onChange(e.target.value)} />;
}

function useSearch(items: RefItem[]) {
  return useMemo(() => new Map(items.map((x) => [x.id, searchText(x)])), [items]);
}

const matchesQuery = (text: string | undefined, q: string) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return !words.length || (!!text && words.every((w) => text.includes(w)));
};

function countBy<T>(items: T[], key: (x: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of items) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return m;
}

function Hidden({ hidden, adult }: { hidden: number; adult: boolean }) {
  const tr = useT();
  if (adult || !hidden) return null;
  return <span className="st-muted">{tr("{n} 18+ hidden", { n: hidden })}</span>;
}

function Thumb({ src, alt }: { src: string; alt: string }) {
  const tr = useT();
  const [broken, setBroken] = useState(false);
  if (broken || !src) return <span className="st-ref-missing">{tr("picture unavailable")}</span>;
  return <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

function Card({ item, thumb, caption, sub, selected, onOpen, onUse, useLabel, extra }: { item: RefItem; thumb: string; caption: string; sub?: string; selected: boolean; onOpen: () => void; onUse: () => void; useLabel: string; extra?: React.ReactNode }) {
  const tr = useT();
  return (
    <div className="st-ref" data-selected={selected ? "true" : undefined}>
      <button type="button" className="st-ref-img" onClick={onOpen} aria-label={tr("Preview {name}", { name: caption })}>
        <Thumb src={thumb} alt={caption} />
        {item.nsfw && <span className="st-ref-badge">18+</span>}
      </button>
      <button type="button" className="st-ref-add" onClick={onUse} title={selected ? tr("In the recipe") : tr(useLabel)} aria-label={selected ? tr("{name} is in the recipe", { name: caption }) : tr("{action}: {name}", { action: tr(useLabel), name: caption })} aria-pressed={selected}>
        {selected ? <CheckIcon size={12} /> : <PlusIcon size={12} />}
      </button>
      <div className="st-ref-cap">
        <span className="st-ref-name" title={caption}>{caption}</span>
        {sub && <span className="st-muted st-ref-sub">{sub}</span>}
        {item.kind === "portrait" && item.mine && <FaceBadge verdict={item.mine.faceCheck ?? null} error={item.mine.faceCheckError} />}
        {extra}
      </div>
    </div>
  );
}

function Grid({ children, total, shown, onMore }: { children: React.ReactNode; total: number; shown: number; onMore: () => void }) {
  const tr = useT();
  return (
    <>
      <div className="st-ref-grid">{children}</div>
      {shown < total && (
        <div className="st-row" style={{ justifyContent: "center", marginTop: 14 }}>
          <Button onClick={onMore}>{tr("Show more ({n} left)", { n: total - shown })}</Button>
        </div>
      )}
    </>
  );
}

function Loading({ error }: { error: unknown }) {
  if (error) return <ErrorBanner error={error} />;
  return (
    <div className="st-ref-grid">
      {Array.from({ length: 12 }, (_, i) => <Skeleton key={i} height={190} />)}
    </div>
  );
}

const USE_LABEL: Record<RefKind, string> = { portrait: "Use as portrait", costume: "Use as costume", pose: "Use as pose" };

const PICTURE_LABEL: Record<PosePicture, string> = { photo: "照片", mannequin: "白模", depth: "深度" };

/** A 我的 item's line under its name: what it is, and its tags. */
function mineSub(x: RefItem): string {
  const what = x.kind === "pose" && x.mine?.picture ? `${MINE_LABEL} · ${PICTURE_LABEL[x.mine.picture]}` : MINE_LABEL;
  return [what, ...(x.mine?.tags ?? [])].join(" · ");
}

/* ---------- portraits ---------- */

function PortraitBrowser({ adultVersion, adult, selected, onUse, onImport }: Props) {
  const tr = useT();
  const { data, error } = useReferences("portrait", adultVersion);
  const items = useMemo(() => (data?.items ?? []) as RefPortrait[], [data]);
  const text = useSearch(items);
  const [section, setSection] = useState("");
  const [hair, setHair] = useState("");
  const [style, setStyle] = useState("");
  const [hot, setHot] = useState(false);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => setShown(PAGE), [section, hair, style, hot, q]);
  const base = items.filter((x) => (!section || x.section === section) && (!hair || x.hairLength === hair));
  const styles = countBy(base, (x) => x.hairstyle);
  const list = base.filter((x) => (!style || x.hairstyle === style) && (!hot || x.hot) && matchesQuery(text.get(x.id), q));
  if (!data) return <Loading error={error} />;
  const sections = countBy(items, (x) => x.section);
  const hairs = countBy(items.filter((x) => !section || x.section === section), (x) => x.hairLength);
  return (
    <div className="st-stack" style={{ gap: 12 }}>
      <div className="st-ref-filters">
        <Pills label={tr("Section")} value={section} onChange={setSection} options={[{ id: "", label: tr("All"), count: items.length }, ...(sections.get(MINE_LABEL) ? [MINE_LABEL] : []).concat(["正脸参考", "造型氛围"]).map((s) => ({ id: s, label: s === "正脸参考" ? "正脸参考 · face" : s === MINE_LABEL ? `${MINE_LABEL} · mine` : "造型氛围 · styling", count: sections.get(s) ?? 0 }))]} />
        <Pills label={tr("Hair length")} value={hair} onChange={(v) => { setHair(v); setStyle(""); }} options={[{ id: "", label: tr("Any length") }, ...["短发", "中发", "中长发", "长发"].map((h) => ({ id: h, label: h, count: hairs.get(h) ?? 0 }))]} />
        <div className="st-row">
          <select className="st-select st-input--sm" style={{ width: "auto", maxWidth: 320 }} value={style} onChange={(e) => setStyle(e.target.value)} aria-label={tr("Hairstyle")}>
            <option value="">{tr("All hairstyles ({n})", { n: styles.size })}</option>
            {[...styles.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => <option key={s} value={s}>{s} ({n})</option>)}
          </select>
          <label className="st-toggle"><input type="checkbox" checked={hot} onChange={(e) => setHot(e.target.checked)} /> {tr("Top 10 🔥")}</label>
          <Search value={q} onChange={setQ} placeholder="Search 搜索 (短发, 波波头…)" />
          <span className="st-muted st-num">{list.length}</span>
        </div>
      </div>
      {list.length === 0 ? <Empty title={tr("No portrait matches")} hint={tr("Clear a filter or the search.")} /> : (
        <Grid total={list.length} shown={shown} onMore={() => setShown((n) => n + PAGE)}>
          {list.slice(0, shown).map((x, i) => (
            <Card key={x.id} item={x} thumb={x.thumb} caption={x.title} sub={x.mine ? mineSub(x) : `${x.section} · ${x.hairLength}`} selected={selected.portrait === x.id} onOpen={() => setOpen(i)} onUse={() => onUse(x, {})} useLabel={USE_LABEL.portrait} extra={x.hot ? <span className="st-ref-hot">{tr("Top 10")}</span> : undefined} />
          ))}
        </Grid>
      )}
      <p className="st-muted st-ref-terms">{tr(REFERENCE_TERMS.portraits)} {tr(REFERENCE_TERMS.translation)} <Hidden hidden={data.hidden} adult={adult} /></p>
      {open !== null && list[open] && <Lightbox list={list} index={open} onIndex={setOpen} onClose={() => setOpen(null)} selected={selected} onUse={onUse} onImport={onImport} depth={false} />}
    </div>
  );
}

/* ---------- costumes ---------- */

function CostumeBrowser({ adultVersion, adult, selected, onUse, onImport }: Props) {
  const tr = useT();
  const { data, error } = useReferences("costume", adultVersion);
  const items = useMemo(() => (data?.items ?? []) as RefCostume[], [data]);
  const text = useSearch(items);
  const [style, setStyle] = useState<"" | "real" | "anime">("");
  const [source, setSource] = useState("");
  const [category, setCategory] = useState("");
  const [tag, setTag] = useState("");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => setShown(PAGE), [style, source, category, tag, q]);
  if (!data) return <Loading error={error} />;
  const byStyle = items.filter((x) => !style || x.style === style);
  const bySource = byStyle.filter((x) => !source || x.source === source);
  const categories = countBy(bySource, (x) => x.category);
  const byCategory = bySource.filter((x) => !category || x.category === category);
  const tags = countBy(byCategory.flatMap((x) => x.tags.filter((t) => t !== x.category).map((t) => ({ t }))), (x) => x.t);
  const list = byCategory.filter((x) => (!tag || x.tags.includes(tag)) && matchesQuery(text.get(x.id), q));
  const sources = COSTUME_SOURCES.filter((s) => !style || (s.id === "gia-anime" || s.id === "charadb" ? "anime" : "real") === style);
  const shownSources = source ? COSTUME_SOURCES.filter((s) => s.id === source) : sources;
  return (
    <div className="st-stack" style={{ gap: 12 }}>
      <div className="st-ref-filters">
        <div className="st-row">
          <Pills label={tr("Style")} value={style} onChange={(v) => { setStyle(v); setSource(""); setCategory(""); setTag(""); }} options={[{ id: "", label: "全部 · all", count: items.length }, { id: "real", label: "现实 · real", count: items.filter((x) => x.style === "real").length }, { id: "anime", label: "二次元 · anime", count: items.filter((x) => x.style === "anime").length }]} />
          <select className="st-select st-input--sm" style={{ width: "auto" }} value={source} onChange={(e) => { setSource(e.target.value); setCategory(""); setTag(""); }} aria-label={tr("Source")}>
            <option value="">{tr("All sources")}</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <Pills label={tr("Category")} value={category} onChange={(v) => { setCategory(v); setTag(""); }} options={[{ id: "", label: tr("All"), count: bySource.length }, ...[...categories.entries()].map(([c, n]) => ({ id: c, label: c, count: n }))]} />
        <div className="st-row">
          <select className="st-select st-input--sm" style={{ width: "auto", maxWidth: 260 }} value={tag} onChange={(e) => setTag(e.target.value)} aria-label={tr("Tag")}>
            <option value="">{tr("All tags")}</option>
            {[...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([t, n]) => <option key={t} value={t}>{t} ({n})</option>)}
          </select>
          <Search value={q} onChange={setQ} placeholder="Search 搜索 (水手服, denim, SPR-0001…)" />
          <span className="st-muted st-num">{list.length}</span>
        </div>
      </div>
      {list.length === 0 ? <Empty title={tr("No costume matches")} hint={tr("Clear a filter or the search.")} /> : (
        <Grid total={list.length} shown={shown} onMore={() => setShown((n) => n + PAGE)}>
          {list.slice(0, shown).map((x, i) => (
            <Card key={x.id} item={x} thumb={x.thumb} caption={x.name} sub={x.mine ? mineSub(x) : `${x.category} · ${COSTUME_SOURCES.find((s) => s.id === x.source)?.label ?? x.source}`} selected={selected.costume === x.id} onOpen={() => setOpen(i)} onUse={() => onUse(x, {})} useLabel={USE_LABEL.costume} />
          ))}
        </Grid>
      )}
      <div className="st-muted st-ref-terms">
        {shownSources.map((s) => <p key={s.id}><a className="st-link st-link--ext" href={s.site} target="_blank" rel="noopener noreferrer">{s.label}</a>: {tr(s.terms)}</p>)}
        <p>{tr(REFERENCE_TERMS.translation)} <Hidden hidden={data.hidden} adult={adult} /></p>
      </div>
      {open !== null && list[open] && <Lightbox list={list} index={open} onIndex={setOpen} onClose={() => setOpen(null)} selected={selected} onUse={onUse} onImport={onImport} depth={false} />}
    </div>
  );
}

/* ---------- poses ---------- */

type PoseGroup = { key: string; first: RefPose; angles: Partial<Record<PoseAngle, RefPose>> };

function PoseBrowser({ adultVersion, adult, selected, onUse, onImport, depth, onDepth }: Props) {
  const tr = useT();
  const { data, error } = useReferences("pose", adultVersion);
  const items = useMemo(() => (data?.items ?? []) as RefPose[], [data]);
  const text = useSearch(items);
  const [system, setSystem] = useState("");
  const [category, setCategory] = useState("");
  const [angle, setAngle] = useState<"" | PoseAngle>("");
  const [mode, setMode] = useState<"group" | "single">("group");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<number | null>(null);
  const [cardAngle, setCardAngle] = useState<Record<string, PoseAngle>>({});
  useEffect(() => setShown(PAGE), [system, category, angle, mode, q]);
  const groups = useMemo(() => {
    const m = new Map<string, PoseGroup>();
    for (const p of items) {
      const g = m.get(p.group) ?? { key: p.group, first: p, angles: {} };
      g.angles[p.angle] = p;
      m.set(p.group, g);
    }
    return [...m.values()];
  }, [items]);
  if (!data) return <Loading error={error} />;
  const systems = POSE_SYSTEMS.filter((s) => adult || !s.nsfw);
  const bySystem = items.filter((x) => !system || x.system === system);
  const categories = countBy(bySystem, (x) => x.category);
  const keep = (x: RefPose) => (!system || x.system === system) && (!category || x.category === category) && matchesQuery(text.get(x.id), q);
  const singles = items.filter((x) => keep(x) && (!angle || x.angle === angle));
  const groupList = groups.filter((g) => keep(g.first) && (!angle || g.angles[angle]));
  const shownOf = (g: PoseGroup) => g.angles[cardAngle[g.key] ?? (angle || "front")] ?? g.angles.front ?? g.first;
  /* the lightbox walks the pictures in view: in group mode, the angle each card shows */
  const lightList = mode === "group" ? groupList.map(shownOf) : singles;
  const pic = (p: RefPose) => (depth ? p.depthThumb : p.thumb);
  return (
    <div className="st-stack" style={{ gap: 12 }}>
      <div className="st-ref-filters">
        <div className="st-row">
          <Pills label={tr("Pose system")} value={system} onChange={(v) => { setSystem(v); setCategory(""); }} options={[{ id: "", label: tr("All"), count: items.length }, ...systems.map((s) => ({ id: s.id, label: `${s.zh}${s.nsfw ? " · 18+" : ""}`, count: items.filter((x) => x.system === s.id).length }))]} />
        </div>
        <div className="st-row">
          <select className="st-select st-input--sm" style={{ width: "auto", maxWidth: 240 }} value={category} onChange={(e) => setCategory(e.target.value)} aria-label={tr("Category")}>
            <option value="">{tr("All categories ({n})", { n: categories.size })}</option>
            {[...categories.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN")).map(([c, n]) => <option key={c} value={c}>{c} ({n})</option>)}
          </select>
          <Pills label={tr("Angle")} value={angle} onChange={setAngle} options={[{ id: "", label: tr("Any angle") }, ...POSE_ANGLES.map((a) => ({ id: a.id, label: `${a.zh} ${a.en}` }))]} />
        </div>
        <div className="st-row">
          <div className="st-seg" role="group" aria-label={tr("Pose picture")}>
            <button type="button" aria-pressed={!depth} onClick={() => onDepth(false)}>Line art 白模</button>
            <button type="button" aria-pressed={depth} onClick={() => onDepth(true)}>Depth 深度图</button>
          </div>
          <div className="st-seg" role="group" aria-label={tr("View")}>
            <button type="button" aria-pressed={mode === "group"} onClick={() => setMode("group")}>{tr("By pose")}</button>
            <button type="button" aria-pressed={mode === "single"} onClick={() => setMode("single")}>{tr("Every picture")}</button>
          </div>
          <Search value={q} onChange={setQ} placeholder="Search 搜索 (坐姿, 回头, P012…)" />
          <span className="st-muted st-num">{mode === "group" ? tr("{n} poses", { n: groupList.length }) : singles.length}</span>
        </div>
      </div>
      {(mode === "group" ? groupList.length : singles.length) === 0 ? <Empty title={tr("No pose matches")} hint={tr("Clear a filter or the search.")} /> : mode === "group" ? (
        <Grid total={groupList.length} shown={shown} onMore={() => setShown((n) => n + PAGE)}>
          {groupList.slice(0, shown).map((g, i) => {
            const p = shownOf(g);
            return (
              <Card key={g.key} item={p} thumb={pic(p)} caption={p.name} sub={p.mine ? mineSub(p) : `${p.category} · ${POSE_ANGLES.find((a) => a.id === p.angle)?.zh}`} selected={selected.pose === p.id} onOpen={() => setOpen(i)} onUse={() => onUse(p, { depth })} useLabel={USE_LABEL.pose}
                extra={
                  <span className="st-ref-angles" role="group" aria-label={tr("Angle")}>
                    {POSE_ANGLES.filter((a) => g.angles[a.id]).map((a) => (
                      <button key={a.id} type="button" aria-pressed={p.angle === a.id} title={tr(`${a.en}||pose angle`)} onClick={() => setCardAngle((m) => ({ ...m, [g.key]: a.id }))}>{a.zh.slice(0, 1)}</button>
                    ))}
                  </span>
                } />
            );
          })}
        </Grid>
      ) : (
        <Grid total={singles.length} shown={shown} onMore={() => setShown((n) => n + PAGE)}>
          {singles.slice(0, shown).map((p, i) => (
            <Card key={p.id} item={p} thumb={pic(p)} caption={p.name} sub={`${p.category} · ${POSE_ANGLES.find((a) => a.id === p.angle)?.zh}`} selected={selected.pose === p.id} onOpen={() => setOpen(i)} onUse={() => onUse(p, { depth })} useLabel={USE_LABEL.pose} />
          ))}
        </Grid>
      )}
      <p className="st-muted st-ref-terms">{tr(REFERENCE_TERMS.poses)} {tr(REFERENCE_TERMS.translation)} <Hidden hidden={data.hidden} adult={adult} /></p>
      {open !== null && lightList[open] && <Lightbox list={lightList} index={open} onIndex={setOpen} onClose={() => setOpen(null)} selected={selected} onUse={onUse} onImport={onImport} depth={depth} onDepth={onDepth} siblings={groups} />}
    </div>
  );
}

/* ---------- the lightbox ---------- */

function Lightbox({ list, index, onIndex, onClose, selected, onUse, onImport, depth, onDepth, siblings }: { list: RefItem[]; index: number; onIndex: (i: number) => void; onClose: () => void; selected: Partial<Record<RefKind, string>>; onUse: Props["onUse"]; onImport?: Props["onImport"]; depth: boolean; onDepth?: (d: boolean) => void; siblings?: PoseGroup[] }) {
  const tr = useT();
  const base = list[index]!;
  const [angleOverride, setAngleOverride] = useState<PoseAngle | null>(null);
  const [view, setView] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string>("");
  const [importError, setImportError] = useState<unknown>(null);
  useEffect(() => {
    setAngleOverride(null);
    setView(undefined);
    setImported("");
    setImportError(null);
  }, [index]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select")) return;
      if (e.key === "ArrowRight") onIndex((index + 1) % list.length);
      if (e.key === "ArrowLeft") onIndex((index - 1 + list.length) % list.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, list.length, onIndex]);
  const group = base.kind === "pose" ? siblings?.find((g) => g.key === base.group) : undefined;
  const item: RefItem = base.kind === "pose" && angleOverride && group?.angles[angleOverride] ? group.angles[angleOverride]! : base;
  const opts: UseOptions = item.kind === "pose" ? { depth } : item.kind === "costume" && view ? { view } : {};
  const pic = referenceImage(item, opts);
  const name = referenceName(item);
  const inRecipe = selected[item.kind] === item.id;
  return (
    <Modal size="lg" onClose={onClose} title={<span>{name} <span className="st-muted st-num">{item.id}</span></span>}
      head={<span className="st-row" style={{ gap: 4 }}><Button size="sm" kind="quiet" onClick={() => onIndex((index - 1 + list.length) % list.length)}>{tr("← Prev")}</Button><span className="st-muted st-num">{index + 1}/{list.length}</span><Button size="sm" kind="quiet" onClick={() => onIndex((index + 1) % list.length)}>{tr("Next →")}</Button></span>}>
      <div className="st-ref-light">
        <div className="st-ref-light-pic">
          <img src={pic.image} alt={name} referrerPolicy="no-referrer" />
        </div>
        <div className="st-stack" style={{ gap: 12 }}>
          {item.nsfw && <span className="st-chip st-chip--warn" style={{ alignSelf: "flex-start" }}>18+</span>}
          <dl className="st-dl">
            {item.kind === "portrait" && (<><dt>{tr("Section")}</dt><dd>{item.section}</dd><dt>{tr("Hair")}</dt><dd>{item.hairLength} · {item.hairstyle}</dd><dt>{tr("Size")}</dt><dd className="st-num">{item.width}×{item.height}</dd></>)}
            {item.kind === "costume" && (<><dt>{tr("Category")}</dt><dd>{item.category}</dd><dt>{tr("Source")}</dt><dd>{COSTUME_SOURCES.find((s) => s.id === item.source)?.label}</dd>{item.nameJa && <><dt>日本語</dt><dd>{item.nameJa}</dd></>}<dt>{tr("Tags")}</dt><dd>{item.tags.join(" · ") || "—"}</dd><dt>{tr("Prompt words")}</dt><dd className="st-ref-kw">{item.keywords || "—"}</dd></>)}
            {item.kind === "pose" && (<><dt>{tr("System")}</dt><dd>{POSE_SYSTEMS.find((s) => s.id === item.system)?.zh}</dd><dt>{tr("Category")}</dt><dd>{item.category}</dd><dt>{tr("Pose")}</dt><dd>{item.number} · {item.name}</dd></>)}
          </dl>
          {item.kind === "pose" && group && (
            <div className="st-stack st-stack--tight">
              <span className="st-label">{tr("Angle")}</span>
              <div className="st-chips">{POSE_ANGLES.filter((a) => group.angles[a.id]).map((a) => <button key={a.id} type="button" className="st-chip st-chip--btn" aria-pressed={item.angle === a.id} onClick={() => setAngleOverride(a.id)}>{a.zh} · {a.en}</button>)}</div>
              {onDepth && (
                <div className="st-seg" role="group" aria-label={tr("Pose picture")} style={{ alignSelf: "flex-start" }}>
                  <button type="button" aria-pressed={!depth} onClick={() => onDepth(false)}>{tr("Line art")}</button>
                  <button type="button" aria-pressed={depth} onClick={() => onDepth(true)}>{tr("Depth")}</button>
                </div>
              )}
            </div>
          )}
          {item.kind === "costume" && item.views && (
            <div className="st-stack st-stack--tight">
              <span className="st-label">{tr("View")}</span>
              <div className="st-chips">{item.views.map((v) => <button key={v.id} type="button" className="st-chip st-chip--btn" aria-pressed={(view ?? "front") === v.id} onClick={() => setView(v.id)}>{v.label}</button>)}</div>
            </div>
          )}
          {item.kind === "costume" && item.source === "charadb" && <p className="st-muted">{tr("CharaDB: reference only — never on a real person's photo, never for a minor, no redistribution.")}</p>}
          {item.kind === "portrait" && <p className="st-muted">{tr("AI-generated, fictional adult. Never use it to pass as a real person.")}</p>}
          <div className="st-row">
            <Button kind="primary" onClick={() => onUse(item, opts)} disabled={inRecipe}>{inRecipe ? tr("In the recipe") : tr(USE_LABEL[item.kind])}</Button>
            {onImport && (
              <Button busy={importing} title={tr("Fetch this one picture into the project's Pictures")} onClick={async () => {
                setImporting(true);
                setImportError(null);
                try {
                  setImported(await onImport(item, opts));
                } catch (e) {
                  setImportError(e);
                } finally {
                  setImporting(false);
                }
              }}>{tr("Add to project pictures")}</Button>
            )}
            <a className="st-btn st-btn--quiet" href={item.kind === "costume" ? item.original : pic.image} target="_blank" rel="noopener noreferrer"><OpenOutIcon size={12} /> {tr("Original")}</a>
          </div>
          {imported && <span className="st-ok">{imported}</span>}
          <ErrorBanner error={importError} onDismiss={() => setImportError(null)} />
        </div>
      </div>
    </Modal>
  );
}

/* ---------- 我的: the user's own pictures ---------- */

const MINE_KIND_LABEL: Record<RefKind, string> = { portrait: "人像 · Portrait", costume: "服装 · Costume", pose: "姿势 · Pose" };

/** Upload into 我的: what the picture is, a name and tags. A portrait gets its face check (模拟 / 真实); a costume or a pose none. */
function MineUpload({ onAdded }: { onAdded: (item: RefItem) => Promise<void> }) {
  const tr = useT();
  const [kind, setKind] = useState<RefKind>("portrait");
  const [picture, setPicture] = useState<PosePicture>("mannequin");
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const send = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setError(new Error(tr("Pick an image file (PNG, JPEG or WebP)")));
    setBusy(true);
    setError(null);
    try {
      const item = await uploadToMine(file, {
        kind, name: name.trim() || file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 60), tags: tags.split(/[,，、\s]+/).filter(Boolean),
        ...(kind === "pose" ? { picture } : {}),
      });
      setName("");
      await onAdded(item);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="st-card st-stack st-mine-upload" data-drag={drag ? "true" : undefined}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); void send(e.dataTransfer.files?.[0]); }}>
      <div className="st-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <strong>{tr("Add to {mine}", { mine: MINE_LABEL })}</strong>
        <div className="st-seg st-seg--sm" role="group" aria-label={tr("What the picture is")}>
          {(["portrait", "costume", "pose"] as const).map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{MINE_KIND_LABEL[k]}</button>)}
        </div>
        {kind === "pose" && (
          <div className="st-seg st-seg--sm" role="group" aria-label={tr("What the pose picture is")}>
            {POSE_PICTURES.map((pp) => <button key={pp} type="button" aria-pressed={picture === pp} onClick={() => setPicture(pp)}>{PICTURE_LABEL[pp]}</button>)}
          </div>
        )}
      </div>
      <div className="st-row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input className="st-input st-input--sm" style={{ width: 180 }} maxLength={60} placeholder={tr("Name (the file name)")} value={name} onChange={(e) => setName(e.target.value)} aria-label={tr("Name")} />
        <input className="st-input st-input--sm" style={{ width: 220 }} placeholder={tr("Tags: 短发, 3D, 赛博…")} value={tags} onChange={(e) => setTags(e.target.value)} aria-label={tr("Tags")} />
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ""; }} />
        <Button size="sm" kind="primary" busy={busy} onClick={() => input.current?.click()}><UploadIcon size={12} /> {busy ? (kind === "portrait" ? tr("Uploading and checking…") : tr("Uploading…")) : tr("Upload a picture")}</Button>
      </div>
      <span className="st-muted">
        {tr(kind === "portrait" ? "A portrait gets its face check: 模拟 (3D, illustrated or AI) can go into any picture, R18 included; 真实 into everything but R18." : "A costume or a pose gets no face check.")}{tr(" Drop a picture here too. Your pictures show in every project, and in the Portraits, Costumes and Poses tabs under {mine}.", { mine: MINE_LABEL })}
      </span>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
    </div>
  );
}

function MineBrowser({ selected, onUse }: Props) {
  const tr = useT();
  const [items, setItems] = useState<RefItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [kind, setKind] = useState<"" | RefKind>("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try {
      setItems((await get<{ items: RefItem[] }>("/api/references/mine")).items);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const changed = async () => {
    invalidateReferences();
    await load();
  };
  const act = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await run();
      await changed();
    } catch (e) {
      setError(e);
    } finally {
      setBusy("");
    }
  };
  const all = items ?? [];
  const list = all.filter((x) => (!kind || x.kind === kind) && matchesQuery(searchText(x), q));
  const counts = countBy(all, (x) => x.kind);
  return (
    <div className="st-stack" style={{ gap: 12 }}>
      <MineUpload onAdded={async () => changed()} />
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <div className="st-ref-filters">
        <div className="st-row">
          <Pills label={tr("Kind")} value={kind} onChange={setKind} options={[{ id: "", label: tr("All"), count: all.length }, ...(["portrait", "costume", "pose"] as const).map((k) => ({ id: k, label: MINE_KIND_LABEL[k], count: counts.get(k) ?? 0 }))]} />
          <Search value={q} onChange={setQ} placeholder={tr("Search 搜索 (name, tags)")} />
          <span className="st-muted st-num">{list.length}</span>
        </div>
      </div>
      {!items ? <Loading error={error} /> : list.length === 0 ? <Empty title={all.length ? tr("No picture matches") : tr("Nothing of yours yet")} hint={all.length ? tr("Clear a filter or the search.") : tr("Upload a portrait, a costume or a pose above.")} /> : (
        <div className="st-ref-grid">
          {list.map((x) => (
            <Card key={x.id} item={x} thumb={x.thumb} caption={referenceName(x)} sub={`${MINE_KIND_LABEL[x.kind].split(" · ")[0]} · ${mineSub(x)}`} selected={selected[x.kind] === x.id}
              onOpen={() => window.open(x.image, "_blank", "noopener")} onUse={() => onUse(x, {})} useLabel={USE_LABEL[x.kind]}
              extra={
                <span className="st-row st-mine-actions" style={{ gap: 4, flexWrap: "wrap" }}>
                  <button type="button" className="st-btn st-btn--quiet st-btn--sm" disabled={!!busy} onClick={() => {
                    const name = window.prompt(tr("Name"), referenceName(x));
                    if (name !== null && name.trim()) void act(x.id, () => patch(`/api/references/mine/${encodeURIComponent(x.id)}`, { name }));
                  }}>{tr("Rename")}</button>
                  <button type="button" className="st-btn st-btn--quiet st-btn--sm" disabled={!!busy} onClick={() => {
                    const tags = window.prompt(tr("Tags, separated by commas"), (x.mine?.tags ?? []).join(", "));
                    if (tags !== null) void act(x.id, () => patch(`/api/references/mine/${encodeURIComponent(x.id)}`, { tags: tags.split(/[,，、\s]+/).filter(Boolean) }));
                  }}>{tr("Tags")}</button>
                  {x.kind === "pose" && (
                    <select className="st-select st-input--sm" style={{ width: "auto" }} value={x.mine?.picture ?? "photo"} disabled={!!busy} aria-label={tr("What the pose picture is")}
                      onChange={(e) => void act(x.id, () => patch(`/api/references/mine/${encodeURIComponent(x.id)}`, { picture: e.target.value }))}>
                      {POSE_PICTURES.map((pp) => <option key={pp} value={pp}>{PICTURE_LABEL[pp]}</option>)}
                    </select>
                  )}
                  {x.kind === "portrait" && <button type="button" className="st-btn st-btn--quiet st-btn--sm" disabled={!!busy} onClick={() => void act(x.id, () => post(`/api/references/mine/${encodeURIComponent(x.id)}/face-check`, {}))}>{busy === x.id ? tr("Checking…") : tr("Check again")}</button>}
                  <button type="button" className="st-btn st-btn--quiet st-btn--sm" disabled={!!busy} onClick={() => {
                    if (window.confirm(tr("Take {name} out of {mine}? Pictures already drawn from it stay.", { name: referenceName(x), mine: MINE_LABEL }))) void act(x.id, () => del(`/api/references/mine/${encodeURIComponent(x.id)}`));
                  }}>{tr("Delete")}</button>
                </span>
              } />
          ))}
        </div>
      )}
    </div>
  );
}
