"use client";

import { useCallback, useEffect, useState } from "react";

import { CheckIcon } from "./icons";
import type { Asset, Element } from "@/studio/types";
import { MAX_DETAILS, REF_VIEWS, type FixedFeature, type RefView } from "@/studio/schemas";
import { detailTargets, sheetStage } from "@/studio/sheet";

import { del, get, patch, post } from "./api";
import { Button, ConfirmButton, Drawer, Empty, ErrorBanner, Field, Section, UploadButton, useAction, useBusyKeys } from "./common";
import { type T, plural, useT } from "./i18n";
import { useProjectContext } from "./shell";
import { useUndoable } from "./notices";
import { ImageButton, useImagingOn } from "./image-tools";
import { PicturePopup, Zoomable } from "./picture-zoom";
import { PictureCaption, pictureSize, pictureTitle, SelectBar, SelectMark, usePictureSelection } from "./pictures";

type ElementRow = Element & { refs: Asset[] };

const KINDS = ["character", "location", "prop"] as const;
const KIND_LABEL: Record<(typeof KINDS)[number], string> = { character: "Characters", location: "Locations", prop: "Props" };

/** A reference view's name: "three_quarter" → "three quarter", in the interface language. */
const viewName = (t: T, v: string) => t(v.replace("_", " "));

export function ElementsPage() {
  const t = useT();
  const { projectId, view, reload } = useProjectContext();
  const [elements, setElements] = useState<ElementRow[] | null>(null);
  const [library, setLibrary] = useState<ElementRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    const [{ elements }, lib] = await Promise.all([
      get<{ elements: ElementRow[] }>(`/api/projects/${projectId}/elements`),
      get<{ elements: ElementRow[] }>("/api/library/elements").catch(() => ({ elements: [] as ElementRow[] })),
    ]);
    setElements(elements);
    setLibrary(lib.elements);
  }, [projectId]);

  useEffect(() => {
    void load().catch(setError);
  }, [load, view?.elements.length]);

  const current = elements?.find((e) => e.id === open) ?? null;
  /* a card's own Delete: busy on that card only; what it removes can be put back (Recently deleted, or Undo) */
  const going = useBusyKeys();
  const undoable = useUndoable(async () => { await load(); await reload(); });
  const slates = (id: string) => (view?.scenes ?? []).flatMap((sc, si) => sc.shots.flatMap((sh, i) => {
    const s = sh.spec;
    return s.characters.includes(id) || s.props.includes(id) || s.location === id || s.dialogue.some((l) => l.speaker === id) ? [`${si + 1}·${i + 1}`] : [];
  }));
  const removeFromList = async (el: ElementRow) => {
    await going.run(el.id, async () => {
      try {
        const { trashId } = await del<{ trashId?: string }>(`/api/elements/${el.id}`);
        if (open === el.id) setOpen(null);
        await load();
        await reload();
        undoable(trashId, t("Deleted {name}", { name: el.name }));
      } catch (caught) {
        setError(caught);
      }
    });
  };

  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">{t("Elements")}</h1>
          <p className="st-subtitle">{t("Characters, locations and props. Each carries the reference images the compiler hands to H3; the first one is primary.")}</p>
        </div>
        <div className="st-actions">
          <Button kind="secondary" onClick={() => setCreating(true)}>
            {t("New element")}
          </Button>
        </div>
      </div>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {elements && elements.length === 0 && (
        <Empty title={t("No elements yet")} hint={t("Create the people, places and things that appear in the script, then generate references for each.")}>
          <Button onClick={() => setCreating(true)}>{t("Create the first one")}</Button>
        </Empty>
      )}

      {KINDS.map((kind) => {
        const list = (elements ?? []).filter((e) => e.kind === kind);
        if (list.length === 0) return null;
        return (
          <Section key={kind} title={t(KIND_LABEL[kind])} aside={<small>{list.length}</small>}>
            <div className="st-grid">
              {list.map((el) => (
                <div key={el.id} className="st-el">
                <button type="button" className="st-shot" aria-pressed={open === el.id} onClick={() => setOpen(el.id)}>
                  <div className="st-shot-media" style={{ aspectRatio: kind === "character" ? "3 / 4" : "16 / 9" }}>
                    {el.refs[0] ? <img src={el.refs[0].url} alt={el.name} /> : <div className="st-placeholder"><span className="st-placeholder-initial">{el.name.slice(0, 1).toUpperCase()}</span></div>}
                    <span className="st-shot-status">
                      <span className="st-chip">{plural(t, el.refs.length, "1 ref", "{n} refs")}</span>
                    </span>
                  </div>
                  <div className="st-shot-body">
                    <div className="st-shot-intent">{el.name}</div>
                    <div className="st-shot-facts">{el.description || t("No description yet")}</div>
                  </div>
                </button>
                <div className="st-row st-el-actions">
                  <Button size="sm" kind="quiet" onClick={() => setOpen(el.id)}>{el.kind === "character" ? t("Look at the sheet") : t("Open")}</Button>
                  <ConfirmButton size="sm" kind="quiet" busy={going.busy(el.id)} confirmLabel={t("Delete {name}", { name: el.name })} onConfirm={() => void removeFromList(el)} question={deleteQuestion(t, el, slates(el.id))}>
                    {t("Delete")}
                  </ConfirmButton>
                </div>
                </div>
              ))}
            </div>
          </Section>
        );
      })}

      {library.length > 0 && (
        <Section title={t("Library")} aside={<small>{t("shared across projects")}</small>}>
          <div className="st-chips">
            {library.map((el) => (
              <button
                key={el.id}
                type="button"
                className="st-chip st-chip--btn"
                onClick={() => {
                  void post(`/api/projects/${projectId}/elements/import`, { elementId: el.id }).then(load).then(reload).catch(setError);
                }}
              >
                + {el.name} <span className="st-muted">{t(el.kind)}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      {creating && (
        <ElementEditor
          projectId={projectId}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await load();
            await reload();
          }}
        />
      )}
      {current && (
        <ElementEditor
          projectId={projectId}
          element={current}
          slates={slates(current.id)}
          onClose={() => setOpen(null)}
          onSaved={async () => {
            await load();
            await reload();
          }}
          onDeleted={async () => {
            setOpen(null);
            await load();
            await reload();
          }}
        />
      )}
    </div>
  );
}

function ElementEditor({
  projectId,
  element,
  slates = [],
  onClose,
  onSaved,
  onDeleted,
}: {
  projectId: string;
  element?: ElementRow;
  /** the slates ("2·3") of the shots that use this element, for the delete question */
  slates?: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted?: () => Promise<void>;
}) {
  const t = useT();
  const [kind, setKind] = useState<(typeof KINDS)[number]>(element?.kind ?? "character");
  const [name, setName] = useState(element?.name ?? "");
  const [description, setDescription] = useState(element?.description ?? "");
  const [selected, setSelected] = useState<string[]>(element?.refAssetIds ?? []);
  const [features, setFeatures] = useState<FixedFeature[]>(element?.fixedFeatures ?? []);
  const [views, setViews] = useState<Record<string, RefView>>(element?.refViews ?? {});
  const [refFeatures, setRefFeatures] = useState<Record<string, string>>(element?.refFeatures ?? {});
  /* Every image in the project is a candidate: uploads and last frames of
     finished takes, imports and generated pictures. */
  const [images, setImages] = useState<Asset[]>([]);

  const loadImages = useCallback(async () => {
    const view = await get<{ assets: Asset[] }>(`/api/projects/${projectId}`);
    setImages(view.assets.filter((a) => a.kind === "image"));
  }, [projectId]);

  useEffect(() => {
    void loadImages();
  }, [loadImages]);

  const save = useAction(async () => {
    const fixedFeatures = features.filter((f) => f.feature.trim() && f.where.trim());
    if (element) await patch(`/api/elements/${element.id}`, { kind, name, description, fixedFeatures });
    else await post(`/api/projects/${projectId}/elements`, { kind, name, description, fixedFeatures });
    await onSaved();
  });

  const saveRefs = useAction(async () => {
    if (!element) return;
    await post(`/api/elements/${element.id}/refs`, { assetIds: selected, views: Object.fromEntries(Object.entries(views).filter(([a]) => selected.includes(a))), features: Object.fromEntries(Object.entries(refFeatures).filter(([a, f]) => selected.includes(a) && views[a] === "detail" && f)) });
    await onSaved();
  });

  const undoable = useUndoable(async () => { await onDeleted?.(); });
  const remove = useAction(async () => {
    if (!element) return;
    const { trashId } = await del<{ trashId?: string }>(`/api/elements/${element.id}`);
    await onDeleted?.();
    undoable(trashId, t("Deleted {name}", { name: element.name }));
  });

  const promote = useAction(async () => {
    if (!element) return;
    await post(`/api/elements/${element.id}/promote`);
  });

  const candidates = [...(element?.refs ?? []), ...images.filter((a) => !element?.refs.some((r) => r.id === a.id))].filter((a) => images.some((i) => i.id === a.id));
  const pickSel = usePictureSelection();
  const afterDelete = async () => {
    const left = (await get<{ assets: Asset[] }>(`/api/projects/${projectId}`)).assets.filter((a) => a.kind === "image");
    setImages(left);
    setSelected((cur) => cur.filter((id) => left.some((a) => a.id === id)));
    await onSaved();
  };

  const uploaded = async ({ assetId }: { assetId: string }) => {
    if (!element) return;
    const next = [...selected, assetId];
    setSelected(next);
    await post(`/api/elements/${element.id}/refs`, { assetIds: next });
    await loadImages();
    await onSaved();
  };

  return (
    <Drawer title={element ? element.name : t("New element")} onClose={onClose}>
      <div className="st-stack">
        <ErrorBanner error={save.error ?? saveRefs.error ?? remove.error ?? promote.error} onDismiss={() => { save.dismiss(); saveRefs.dismiss(); remove.dismiss(); promote.dismiss(); }} />
        {element && <SheetGallery element={element} />}
        <div className="st-fields">
          <Field label={t("Kind")}>
            <select className="st-select" value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(k)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("Name")}>
            <input className="st-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Mara")} />
          </Field>
        </div>
        <Field label={t("Visual description")} hint={t("Age, build, hair, wardrobe, materials, light. The image model and the compiler both read this.")}>
          <textarea className="st-textarea" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={t("Fixed features")} hint={t("Details that must never move or vanish, with the element's own left/right (a tattoo on the LEFT forearm, a red beret). Restated in every shot; one-sided ones are flagged as fragile. For a character, tick detail on up to three that are not on the face: the sheet draws each close, and the whole-figure views copy it.")} group>
          <div className="st-stack st-stack--tight">
            {features.map((f, i) => (
              <div key={i} className="st-line">
                <input className="st-input st-input--sm" placeholder={t("feature (dragon tattoo)")} value={f.feature} onChange={(e) => setFeatures(features.map((x, j) => (j === i ? { ...x, feature: e.target.value } : x)))} />
                <input className="st-input st-input--sm" placeholder={t("where (left forearm, inner side)")} value={f.where} onChange={(e) => setFeatures(features.map((x, j) => (j === i ? { ...x, where: e.target.value } : x)))} />
                {kind === "character" && (
                  <label className="st-row" style={{ gap: 4, whiteSpace: "nowrap" }} title={t("Draw a close detail picture of this feature for the sheet (at most 3 per character). Whole-figure views copy it.")}>
                    <input type="checkbox" checked={f.detail === true} disabled={f.detail !== true && features.filter((x) => x.detail === true).length >= MAX_DETAILS}
                      onChange={(e) => setFeatures(features.map((x, j) => (j === i ? { ...x, detail: e.target.checked ? true : undefined } : x)))} />
                    <span className="st-muted">{t("detail")}</span>
                  </label>
                )}
                <Button size="sm" kind="quiet" onClick={() => setFeatures(features.filter((_, j) => j !== i))}>{t("Remove")}</Button>
              </div>
            ))}
            <div>
              <Button size="sm" disabled={features.length >= 8} onClick={() => setFeatures([...features, { feature: "", where: "" }])}>{t("Add feature")}</Button>
            </div>
          </div>
        </Field>
        <div className="st-row st-row--between">
          <div className="st-row">
            {element && (
              <ConfirmButton kind="danger" size="sm" busy={remove.busy} confirmLabel={t("Delete {name}", { name: element.name })} onConfirm={() => void remove.fire()} question={deleteQuestion(t, element, slates)}>
                {t("Delete")}
              </ConfirmButton>
            )}
            {element && (
              <Button kind="quiet" size="sm" busy={promote.busy} onClick={() => void promote.fire()} title={t("Copy into the shared library")}>
                {t("Promote to library")}
              </Button>
            )}
          </div>
          <Button kind="primary" busy={save.busy} disabled={!name.trim()} onClick={() => void save.fire()}>
            {element ? t("Save") : t("Create")}
          </Button>
        </div>

        {element && <SheetTools element={element} />}
        {element && (
          <Section
            title={t("Reference images")}
            aside={
              <span className="st-row">
                <SelectBar sel={pickSel} all={candidates.map((a) => a.id)} onDeleted={afterDelete} />
                <UploadButton accept="image/jpeg,image/png,image/webp" projectId={projectId} onUploaded={uploaded} />
              </span>
            }
          >
            {candidates.length === 0 ? (
              <Empty title={t("No references yet")} hint={t("Upload an image, generate a sheet above, or pick any project image. The first pick is the primary reference.")} />
            ) : (
              <>
                <div className="st-thumbs st-thumbs--named">
                  {candidates.map((a) => {
                    const idx = selected.indexOf(a.id);
                    const ticked = pickSel.selected.includes(a.id);
                    return (
                      <div key={a.id} className="st-pic">
                        <Zoomable url={a.url} title={pictureTitle(a)} facts={pictureSize(a)}>
                        <button
                          type="button"
                          className={`st-thumb${kind === "character" ? " st-thumb--tall" : ""}`}
                          aria-pressed={pickSel.selecting ? ticked : idx >= 0}
                          title={pictureTitle(a)}
                          onClick={() => (pickSel.selecting ? pickSel.toggle(a.id) : setSelected(idx >= 0 ? selected.filter((id) => id !== a.id) : [...selected, a.id]))}
                        >
                          <img src={(a.meta.previewUrl as string | undefined) ?? a.url} alt={pictureTitle(a)} loading="lazy" />
                          {pickSel.selecting ? <SelectMark on={ticked} /> : idx >= 0 && (
                            <span className="st-thumb-check">
                              <CheckIcon size={11} />
                            </span>
                          )}
                          {idx === 0 && <span className="st-thumb-tag">{t("PRIMARY")}</span>}
                        </button>
                        </Zoomable>
                        <PictureCaption asset={a} />
                      </div>
                    );
                  })}
                </div>
                {selected.length > 0 && (
                  <div className="st-stack st-stack--tight" style={{ marginTop: 10 }}>
                    <span className="st-muted">{t("Which view does each reference show? Face is the character's portrait: an uploaded one tagged face is the identity the rest of the sheet is drawn from. A detail names the fixed feature it shows. Tagged views let a profile shot use the side view and a close-up the portrait.")}</span>
                    {selected.map((id, k) => {
                      const a = candidates.find((c) => c.id === id);
                      return (
                        <div key={id} className="st-row">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          {a && <img src={a.url} alt="" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 0 }} />}
                          <span className="st-muted st-num">#{k + 1}</span>
                          <select className="st-select st-input--sm" value={views[id] ?? ""} onChange={(e) => setViews({ ...views, [id]: e.target.value as RefView })}>
                            <option value="">{t("view —")}</option>
                            {REF_VIEWS.map((v) => <option key={v} value={v}>{viewName(t, v)}</option>)}
                          </select>
                          {views[id] === "detail" && (
                            <select className="st-select st-input--sm" value={refFeatures[id] ?? ""} aria-label={t("The fixed feature this detail shows")} onChange={(e) => setRefFeatures({ ...refFeatures, [id]: e.target.value })}>
                              <option value="">{t("which feature —")}</option>
                              {features.filter((f) => f.feature.trim()).map((f) => <option key={f.feature} value={f.feature}>{f.feature}</option>)}
                            </select>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="st-row st-row--between" style={{ marginTop: 10 }}>
                  <span className="st-muted st-num">{t("{n} selected", { n: selected.length })}</span>
                  <Button kind="primary" size="sm" busy={saveRefs.busy} onClick={() => void saveRefs.fire()}>
                    {t("Use selected")}
                  </Button>
                </div>
              </>
            )}
          </Section>
        )}
      </div>
    </Drawer>
  );
}

/* What a delete asks: which shots still use the element, and that it can be put back. */
function deleteQuestion(t: T, el: { kind: string; name: string }, slates: string[]) {
  return t("Delete {kind} {name}?{uses} It can be put back from Recently deleted for 14 days.", {
    kind: t(el.kind), name: el.name,
    uses: slates.length ? ` ${t("Shots {list} use it and will not find it once it is deleted.", { list: slates.join(", ") })}` : "",
  });
}

/* The element's pictures by view, at the top of its drawer: face, front, three quarter, side, back, full body,
   the expressions and the details, each named, a click shows it large. A view of the character's sheet that
   is not drawn yet is a dashed tile, so what is missing shows as well as what is there. */
const SHEET_CORE: RefView[] = ["face", "front", "side", "back", "expression"];

function SheetGallery({ element }: { element: ElementRow }) {
  const t = useT();
  const [shown, setShown] = useState<Asset | null>(null);
  const viewOf = (a: Asset): RefView | "" => element.refViews?.[a.id] ?? "";
  const order = (v: RefView | "") => (v === "" ? REF_VIEWS.length : REF_VIEWS.indexOf(v));
  const tiles = element.refs.map((a, i) => ({ a, v: viewOf(a), i })).sort((x, y) => order(x.v) - order(y.v) || x.i - y.i);
  const missing = element.kind === "character" ? SHEET_CORE.filter((v) => !tiles.some((x) => x.v === v)) : [];
  if (tiles.length === 0 && missing.length === 0) return null;
  const label = (x: { a: Asset; v: RefView | "" }) => {
    const feature = x.v === "detail" ? element.refFeatures?.[x.a.id] : undefined;
    return x.v === "" ? t("no view tagged") : feature ? t("detail: {feature}", { feature }) : viewName(t, x.v);
  };
  /* an expression comes four at a time: say which of them this is */
  const seen = new Map<string, number>();
  return (
    <Section title={t("Sheet")} aside={<small>{plural(t, element.refs.length, "1 picture", "{n} pictures")}</small>}>
      <div className="st-thumbs st-thumbs--named">
        {tiles.map((x) => {
          const n = (seen.get(x.v) ?? 0) + 1;
          seen.set(x.v, n);
          const same = tiles.filter((y) => y.v === x.v).length;
          const name = same > 1 ? `${label(x)} ${n}` : label(x);
          return (
            <div key={x.a.id} className="st-pic">
              <button type="button" className={`st-thumb${element.kind === "character" ? " st-thumb--tall" : ""}`} title={name} onClick={() => setShown(x.a)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={(x.a.meta.previewUrl as string | undefined) ?? x.a.url} alt={name} loading="lazy" />
                {x.i === 0 && <span className="st-thumb-tag">{t("PRIMARY")}</span>}
              </button>
              <span className="st-pic-caption st-num">{name}</span>
            </div>
          );
        })}
        {missing.map((v) => (
          <div key={v} className="st-pic st-pic--missing">
            <div className="st-thumb st-thumb--tall st-thumb--empty" aria-hidden="true" />
            <span className="st-pic-caption st-muted">{viewName(t, v)} · {t("not drawn yet")}</span>
          </div>
        ))}
      </div>
      {shown && <PicturePopup url={shown.url} title={`${element.name} · ${pictureTitle(shown)}`} facts={pictureSize(shown)} onClose={() => setShown(null)} />}
    </Section>
  );
}

/* The project's image model (the Director page): the element's reference sheet, one picture per view, tagged. */
function SheetTools({ element }: { element: ElementRow }) {
  const t = useT();
  const imaging = useImagingOn();
  const isChar = element.kind === "character";
  const [views, setViews] = useState<RefView[]>([]);
  const have = new Set(Object.values(element.refViews ?? {}));
  const { stage, now, later } = sheetStage(element);
  const targets = detailTargets(element);
  const name = (x: { view: RefView; feature?: string }) => (x.feature ? t("detail: {feature}", { feature: x.feature }) : viewName(t, x.view));
  const sep = t(", ||list");
  if (!isChar) {
    return (
      <Section title={t("Generate with {model}", { model: imaging.label })}>
        <div className="st-stack st-stack--tight">
          <span className="st-muted">{t("One reference picture in the project's look.")}</span>
          <ImageButton label={t("Generate reference")} body={{ action: "element_sheet", elementId: element.id, views: ["front"] }} kind="primary" />
        </div>
      </Section>
    );
  }
  return (
    <Section title={t("Generate with {model}", { model: imaging.label })}>
      <div className="st-stack st-stack--tight">
        <span className="st-muted">
          {t("The sheet is drawn in the order identity is built: the face portrait (drawn here, or your own picture tagged face above) → four expressions and up to three details, from the portrait → the front figure → side and back. Every picture copies the portrait itself. Look at each stage before the next is drawn from it.")}
        </span>
        {stage === "complete" ? (
          <span className="st-muted">{t("The sheet is complete. Pick views below to redraw one; the new picture takes the old one's place.")}</span>
        ) : (
          <>
            <span>
              <strong>{t("Next: {list}", { list: now.map(name).join(sep) })}</strong>
              {later.length > 0 && <span className="st-muted">{t(" · then {list}", { list: [...new Set(later.map((x) => viewName(t, x.view)))].join(sep) })}</span>}
            </span>
            <ImageButton label={t("Generate {list}", { list: now.map(name).join(sep) })} body={{ action: "element_sheet", elementId: element.id, views: [] }} kind="primary" />
          </>
        )}
        {targets.length === 0 && <span className="st-muted">{t("No detail pictures: this character has no fixed feature off the face. Add one above (a tattoo, an emblem, a prop in hand) and tick detail to get one.")}</span>}
        <span className="st-muted">{t("Redraw or add a view:")}</span>
        <div className="st-chips">
          {REF_VIEWS.map((v) => (
            <button key={v} type="button" className="st-chip st-chip--btn" aria-pressed={views.includes(v)} onClick={() => setViews(views.includes(v) ? views.filter((x) => x !== v) : [...views, v])}>
              {viewName(t, v)}{have.has(v) ? " ✓" : ""}
            </button>
          ))}
        </div>
        {views.length > 0 && <ImageButton label={t("Generate {list}", { list: views.map((v) => viewName(t, v)).join(sep) })} body={{ action: "element_sheet", elementId: element.id, views }} />}
      </div>
    </Section>
  );
}
