"use client";

import { useCallback, useEffect, useState } from "react";

import { CheckIcon } from "./icons";
import type { Asset, Element } from "@/studio/types";

import { del, get, patch, post } from "./api";
import { Button, Drawer, Empty, ErrorBanner, Field, Section, UploadButton, useAction } from "./common";
import { useProjectContext } from "./shell";

type ElementRow = Element & { refs: Asset[] };

const KINDS = ["character", "location", "prop"] as const;
const KIND_LABEL: Record<(typeof KINDS)[number], string> = { character: "Characters", location: "Locations", prop: "Props" };

export function ElementsPage() {
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

  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Elements</h1>
          <p className="st-subtitle">Characters, locations and props. Each carries the reference images the compiler hands to H3; the first one is primary.</p>
        </div>
        <div className="st-actions">
          <Button kind="primary" onClick={() => setCreating(true)}>
            New element
          </Button>
        </div>
      </div>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {elements && elements.length === 0 && (
        <Empty title="No elements yet" hint="Create the people, places and things that appear in the script, then generate references for each.">
          <Button onClick={() => setCreating(true)}>Create the first one</Button>
        </Empty>
      )}

      {KINDS.map((kind) => {
        const list = (elements ?? []).filter((e) => e.kind === kind);
        if (list.length === 0) return null;
        return (
          <Section key={kind} title={KIND_LABEL[kind]} aside={<small>{list.length}</small>}>
            <div className="st-grid">
              {list.map((el) => (
                <button key={el.id} type="button" className="st-shot" aria-pressed={open === el.id} onClick={() => setOpen(el.id)}>
                  <div className="st-shot-media" style={{ aspectRatio: kind === "character" ? "3 / 4" : "16 / 9" }}>
                    {el.refs[0] ? <img src={el.refs[0].url} alt={el.name} /> : <div className="st-placeholder"><span className="st-placeholder-initial">{el.name.slice(0, 1).toUpperCase()}</span></div>}
                    <span className="st-shot-status">
                      <span className="st-chip">{el.refs.length} ref{el.refs.length === 1 ? "" : "s"}</span>
                    </span>
                  </div>
                  <div className="st-shot-body">
                    <div className="st-shot-intent">{el.name}</div>
                    <div className="st-shot-facts">{el.description || "No description yet"}</div>
                  </div>
                </button>
              ))}
            </div>
          </Section>
        );
      })}

      {library.length > 0 && (
        <Section title="Library" aside={<small>shared across projects</small>}>
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
                + {el.name} <span className="st-muted">{el.kind}</span>
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
  onClose,
  onSaved,
  onDeleted,
}: {
  projectId: string;
  element?: ElementRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted?: () => Promise<void>;
}) {
  const [kind, setKind] = useState<(typeof KINDS)[number]>(element?.kind ?? "character");
  const [name, setName] = useState(element?.name ?? "");
  const [description, setDescription] = useState(element?.description ?? "");
  const [selected, setSelected] = useState<string[]>(element?.refAssetIds ?? []);
  /* Every image in the project is a candidate: uploads and last frames of
     finished takes. Image generation is disabled for now (TODO). */
  const [images, setImages] = useState<Asset[]>([]);

  const loadImages = useCallback(async () => {
    const view = await get<{ assets: Asset[] }>(`/api/projects/${projectId}`);
    setImages(view.assets.filter((a) => a.kind === "image"));
  }, [projectId]);

  useEffect(() => {
    void loadImages();
  }, [loadImages]);

  const save = useAction(async () => {
    if (element) await patch(`/api/elements/${element.id}`, { kind, name, description });
    else await post(`/api/projects/${projectId}/elements`, { kind, name, description });
    await onSaved();
  });

  const saveRefs = useAction(async () => {
    if (!element) return;
    await post(`/api/elements/${element.id}/refs`, { assetIds: selected });
    await onSaved();
  });

  const remove = useAction(async () => {
    if (!element || !window.confirm(`Delete ${element.name}?`)) return;
    await del(`/api/elements/${element.id}`);
    await onDeleted?.();
  });

  const promote = useAction(async () => {
    if (!element) return;
    await post(`/api/elements/${element.id}/promote`);
  });

  const candidates = [...(element?.refs ?? []), ...images.filter((a) => !element?.refs.some((r) => r.id === a.id))];

  const uploaded = async ({ assetId }: { assetId: string }) => {
    if (!element) return;
    const next = [...selected, assetId];
    setSelected(next);
    await post(`/api/elements/${element.id}/refs`, { assetIds: next });
    await loadImages();
    await onSaved();
  };

  return (
    <Drawer title={element ? element.name : "New element"} onClose={onClose}>
      <div className="st-stack">
        <ErrorBanner error={save.error ?? saveRefs.error ?? remove.error ?? promote.error} onDismiss={() => { save.dismiss(); saveRefs.dismiss(); remove.dismiss(); promote.dismiss(); }} />
        <div className="st-fields">
          <Field label="Kind">
            <select className="st-select" value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name">
            <input className="st-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Mara" />
          </Field>
        </div>
        <Field label="Visual description" hint="Age, build, hair, wardrobe, materials, light. The image model and the compiler both read this.">
          <textarea className="st-textarea" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="st-row st-row--between">
          <div className="st-row">
            {element && (
              <Button kind="danger" size="sm" busy={remove.busy} onClick={() => void remove.fire()}>
                Delete
              </Button>
            )}
            {element && (
              <Button kind="quiet" size="sm" busy={promote.busy} onClick={() => void promote.fire()} title="Copy into the shared library">
                Promote to library
              </Button>
            )}
          </div>
          <Button kind="primary" busy={save.busy} disabled={!name.trim()} onClick={() => void save.fire()}>
            {element ? "Save" : "Create"}
          </Button>
        </div>

        {element && (
          <Section
            title="Reference images"
            aside={<UploadButton accept="image/jpeg,image/png,image/webp" projectId={projectId} onUploaded={uploaded} />}
          >
            {candidates.length === 0 ? (
              <Empty title="No references yet" hint="Upload an image of this element. Generated references are coming later; for now every project image can be picked. The first pick is the primary reference." />
            ) : (
              <>
                <div className="st-thumbs">
                  {candidates.map((a) => {
                    const idx = selected.indexOf(a.id);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className={`st-thumb${kind === "character" ? " st-thumb--tall" : ""}`}
                        aria-pressed={idx >= 0}
                        onClick={() => setSelected(idx >= 0 ? selected.filter((id) => id !== a.id) : [...selected, a.id])}
                      >
                        <img src={a.url} alt="" />
                        {idx >= 0 && (
                          <span className="st-thumb-check">
                            <CheckIcon size={11} />
                          </span>
                        )}
                        {idx === 0 && <span className="st-thumb-tag">PRIMARY</span>}
                      </button>
                    );
                  })}
                </div>
                <div className="st-row st-row--between" style={{ marginTop: 10 }}>
                  <span className="st-muted st-num">{selected.length} selected</span>
                  <Button kind="primary" size="sm" busy={saveRefs.busy} onClick={() => void saveRefs.fire()}>
                    Use selected
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
