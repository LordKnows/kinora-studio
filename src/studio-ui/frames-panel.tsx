"use client";

import { useEffect, useState } from "react";

import { preferredViews } from "@/studio/compiler";
import type { ShotView } from "@/studio/orchestrator";
import type { Asset } from "@/studio/types";

import { get, post } from "./api";
import { Button, Empty, ErrorBanner, Field, Modal, Section, UploadButton, useAction } from "./common";
import { EditRegion, hasQualityTiers, ImageButton, reviewChip, useImagingOn } from "./image-tools";
import { PictureCaption, pictureTitle, SelectBar, SelectMark, useDeletePictures, usePictureSelection } from "./pictures";
import { useProjectContext } from "./shell";

/*
 * The Frames tab of a shot, in two parts that do not mix:
 *
 *  1. What the shot has — by its mode. Text mode needs no picture. Reference
 *     mode reads the element sheets (and an optional reference frame).
 *     Keyframe mode is either ONE hero frame (I2VA) or a FIRST and an END
 *     frame (FL2VA): only the slots of the chosen kind are shown. A slot shows
 *     its picture large (click: full size), and choose / upload / edit a
 *     region / take it off the shot / delete the picture.
 *  2. Generate a frame — a separate card: which frame, then how: from scratch
 *     (the shot's description, staging and the element sheets) or from a
 *     picture you choose (edited into this shot's frame); a crop when that is
 *     what the shot needs.
 */

type Slot = "first" | "last";
type PlanRow = { shotId: string; first: string | null; last: string | null; why: string; previousShotId?: string };

const METHOD_LABEL: Record<string, string> = {
  none: "nothing to draw (text mode)", sheets: "the element sheets", anchor: "the anchor take's last frame (nothing to draw)", edit_anchor: "edit the anchor take's last frame",
  new: "draw it from scratch", edit_from_last: "edit it from this shot's end frame", edit_from_previous: "edit the earlier shot's frame (same place and angle)", crop_from_first: "crop the first frame (push-in)", crop_from_last: "crop the end frame (pull-out)",
};

const aspectCss = (r?: string) => (r ?? "16:9").replace(":", " / ");
/** A frame box at the render's aspect, at most 420 px tall: vertical frames get narrower, never letterboxed. */
const frameBox = (aspect: string): React.CSSProperties => {
  const [w, h] = aspect.split("/").map((x) => Number(x.trim()));
  return { aspectRatio: aspect, maxWidth: w && h ? `${Math.round((420 * w) / h)}px` : undefined };
};

export function FramesPanel({ shot }: { shot: ShotView }) {
  const { projectId, view, reload } = useProjectContext();
  const aspect = aspectCss(view?.project.look.aspectRatio);
  const [frameMode, setFrameMode] = useState<"hero" | "first_last">(shot.endAssetId || shot.spec.frames?.last ? "first_last" : "hero");
  const [lightbox, setLightbox] = useState<Asset | null>(null);
  const [plan, setPlan] = useState<PlanRow | null>(null);
  useEffect(() => {
    void get<{ shots: PlanRow[] }>(`/api/projects/${projectId}/frame-plan`).then((p) => setPlan(p.shots.find((r) => r.shotId === shot.id) ?? null)).catch(() => setPlan(null));
  }, [projectId, shot.id, shot.heroAssetId, shot.endAssetId, shot.spec.mode]);

  const setFrame = useAction(async (_c, slot: Slot, assetId: string | null) => {
    await post(`/api/shots/${shot.id}/${slot === "first" ? "hero-frame" : "end-frame"}`, { assetId });
    await reload();
  });
  const chooseMode = async (m: "hero" | "first_last") => {
    if (m === "hero" && shot.endAssetId) {
      if (!window.confirm("Use one hero frame only? The end frame is taken off this shot (the picture stays in Pictures).")) return;
      await setFrame.fire("last", null);
    }
    setFrameMode(m);
  };

  const mode = shot.spec.mode;
  if (mode === "text") {
    return (
      <Empty title="Text mode: no frames" hint="H3 draws this shot from its prompt alone. To start from a picture, switch the shot to keyframe (one hero frame, or a first and an end frame) or reference (the element sheets) in the Edit tab." />
    );
  }

  const linkedToAnchor = plan?.first === "anchor";
  const slots: Array<{ slot: Slot; label: string; hint: string }> =
    mode === "reference"
      ? [{ slot: "first", label: "Reference frame (optional)", hint: "R2VA reads it as the first of its reference pictures: composition and light." }]
      : frameMode === "hero"
        ? [{ slot: "first", label: "Hero frame", hint: linkedToAnchor ? "Linked to its anchor: the take starts on the anchor take's last frame, so no hero frame is needed." : "The picture the take starts from (I2VA)." }]
        : [
            { slot: "first", label: "First frame", hint: linkedToAnchor ? "Linked: starts on the anchor take's last frame unless you set one." : "Where the shot starts (FL2VA)." },
            { slot: "last", label: "End frame", hint: "Where the shot must arrive (FL2VA): same camera, scale and background as the first." },
          ];

  return (
    <div className="st-stack">
      <ErrorBanner error={setFrame.error} projectId={projectId} onDismiss={setFrame.dismiss} />

      {mode === "reference" && (
        <Section title="Reference sheets">
          <SheetNeeds shot={shot} />
        </Section>
      )}

      {mode === "keyframe" && (
        <div className="st-row" style={{ flexWrap: "wrap", gap: 12 }}>
          <div className="st-seg" role="group" aria-label="Frames of this shot">
            <button type="button" aria-pressed={frameMode === "hero"} onClick={() => void chooseMode("hero")}>
              Hero frame<small>one picture → the take starts from it</small>
            </button>
            <button type="button" aria-pressed={frameMode === "first_last"} onClick={() => void chooseMode("first_last")}>
              First + end frame<small>the take goes from one to the other</small>
            </button>
          </div>
        </div>
      )}

      <Section title={mode === "reference" ? "Reference frame" : frameMode === "hero" ? "Hero frame" : "First and end frame"}>
        <div className="st-frame-slots">
          {slots.map((s) => (
            <FrameSlot key={s.slot} shot={shot} slot={s.slot} label={s.label} hint={s.hint} aspect={aspect} onView={setLightbox} onSet={(id) => setFrame.fire(s.slot, id)} />
          ))}
        </div>
      </Section>

      <GenerateFrame shot={shot} plan={plan} targets={slots.map((s) => ({ slot: s.slot, label: s.label.replace(" (optional)", "") }))} />

      {mode === "keyframe" && frameMode === "first_last" && shot.hero && shot.end && <FrameCheck first={shot.hero.url} last={shot.end.url} aspect={aspect} />}
      {shot.hero && <PhoneCheck url={shot.hero.url} aspect={aspect} />}

      {lightbox && <Lightbox asset={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

/* ---------- one frame of the shot ---------- */

function FrameSlot({ shot, slot, label, hint, aspect, onView, onSet }: { shot: ShotView; slot: Slot; label: string; hint: string; aspect: string; onView: (a: Asset) => void; onSet: (id: string | null) => Promise<void> }) {
  const { projectId, reload } = useProjectContext();
  const asset = slot === "first" ? shot.hero : shot.end;
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const del = useDeletePictures(reload);
  return (
    <div className="st-frame-slot">
      <div className="st-row st-row--between">
        <strong>{label}</strong>
        {asset && reviewChip(asset) && <span className="st-chip">{reviewChip(asset)}</span>}
      </div>
      {asset ? (
        <button type="button" className="st-frame-view" style={frameBox(aspect)} onClick={() => onView(asset)} title="Open full size">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={(asset.meta.previewUrl as string | undefined) ?? asset.url} alt={pictureTitle(asset)} />
        </button>
      ) : (
        <div className="st-frame-empty" style={frameBox(aspect)}>
          <span>
            No {label.toLowerCase().replace(" (optional)", "")} yet
            <br />
            <span className="st-muted">choose a picture, upload one, or generate it below</span>
          </span>
        </div>
      )}
      {asset ? <PictureCaption asset={asset} /> : <span className="st-muted">{hint}</span>}
      <ErrorBanner error={del.error} projectId={projectId} onDismiss={del.dismiss} />
      <div className="st-row" style={{ flexWrap: "wrap", gap: 6 }}>
        <Button size="sm" onClick={() => setPicking(true)}>{asset ? "Replace…" : "Choose…"}</Button>
        <UploadButton accept="image/jpeg,image/png,image/webp" projectId={projectId} label="Upload" onUploaded={({ assetId }) => onSet(assetId)} />
        {asset && <Button size="sm" kind="quiet" onClick={() => setEditing((e) => !e)}>Edit a region</Button>}
        {asset && <Button size="sm" kind="quiet" onClick={() => void onSet(null)} title="Take it off this shot; the picture stays in Pictures">Take off this shot</Button>}
        {asset && <Button size="sm" kind="danger" busy={del.busy} onClick={() => void del.fire([asset.id])} title="Delete the picture itself (from every place it is used)">Delete picture</Button>}
      </div>
      {editing && asset && <EditRegion asset={asset} attach={slot === "first" ? { heroOf: shot.id } : { endOf: shot.id }} onClose={() => setEditing(false)} />}
      {picking && <PicturePicker title={`Choose the ${label.toLowerCase().replace(" (optional)", "")}`} current={asset?.id} onPick={(id) => { setPicking(false); void onSet(id); }} onClose={() => setPicking(false)} />}
    </div>
  );
}

/* ---------- generate a frame: which one, and how ---------- */

type How = "new" | "edit" | "crop";

function GenerateFrame({ shot, plan, targets }: { shot: ShotView; plan: PlanRow | null; targets: Array<{ slot: Slot; label: string }> }) {
  const { view } = useProjectContext();
  const imaging = useImagingOn();
  const [slot, setSlot] = useState<Slot>(targets[0]?.slot ?? "first");
  const [how, setHow] = useState<How>("new");
  const [baseId, setBaseId] = useState<string>("");
  const [instruction, setInstruction] = useState("");
  const [quality, setQuality] = useState<"" | "low" | "medium" | "high">("");
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (!targets.some((t) => t.slot === slot)) setSlot(targets[0]?.slot ?? "first");
  }, [targets, slot]);

  const target = targets.find((t) => t.slot === slot) ?? targets[0]!;
  const flat = view?.scenes.flatMap((s) => s.shots) ?? [];
  const previous = plan?.previousShotId ? flat.find((x) => x.id === plan.previousShotId) : undefined;
  /* the pictures worth starting from, first: this shot's other frame, the earlier shot of the same set */
  const suggested: Array<{ id: string; label: string }> = [];
  const other = slot === "first" ? shot.end : shot.hero;
  if (other) suggested.push({ id: other.id, label: `this shot's ${slot === "first" ? "end" : "first"} frame` });
  if (previous?.hero && previous.hero.id !== other?.id) suggested.push({ id: previous.hero.id, label: "the earlier shot's frame (same place and angle)" });
  const base = view?.assets.find((a) => a.id === baseId);
  const cropFrom = slot === "last" ? shot.hero : shot.end;
  const canCrop = !!cropFrom && shot.spec.mode === "keyframe";
  const suggestion = plan ? (slot === "first" ? plan.first : plan.last) : null;

  const body: Record<string, unknown> =
    how === "new" ? { action: "shot_frame", shotId: shot.id, which: slot, method: "new", ...(quality ? { quality } : {}) }
      : how === "crop" ? { action: "shot_frame", shotId: shot.id, which: slot, method: slot === "last" ? "crop_from_first" : "crop_from_last" }
        : { action: "shot_frame", shotId: shot.id, which: slot, method: "edit_picture", baseAssetId: baseId, ...(instruction.trim() ? { instruction: instruction.trim() } : {}), ...(quality ? { quality } : {}) };
  const ready = how !== "edit" || !!baseId;

  return (
    <div className="st-gen">
      <div className="st-row st-row--between" style={{ flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15 }}>Generate a frame</strong>
        <span className="st-muted">drawn with {imaging.drawnBy}{imaging.on ? "" : ` — ${imaging.why}`}</span>
      </div>

      {targets.length > 1 && (
        <div className="st-seg" role="group" aria-label="Which frame">
          {targets.map((t) => (
            <button key={t.slot} type="button" aria-pressed={slot === t.slot} onClick={() => setSlot(t.slot)}>{t.label}</button>
          ))}
        </div>
      )}
      {suggestion && METHOD_LABEL[suggestion] && <span className="st-muted">Suggested for this shot: {METHOD_LABEL[suggestion]}{plan?.why ? ` — ${plan.why}` : ""}.</span>}

      <div className="st-stack st-stack--tight">
        <label className="st-choice" data-on={how === "new" ? "true" : undefined}>
          <input type="radio" name={`how-${shot.id}`} checked={how === "new"} onChange={() => setHow("new")} />
          <span>
            <strong>From scratch</strong>
            <small>A new picture from the shot's description, staging, composition and palette, with the element sheets and the style frame as references.</small>
          </span>
        </label>
        <label className="st-choice" data-on={how === "edit" ? "true" : undefined}>
          <input type="radio" name={`how-${shot.id}`} checked={how === "edit"} onChange={() => setHow("edit")} />
          <span>
            <strong>From a picture you choose</strong>
            <small>Starts from an existing picture and changes it into this frame — same people, place and light. Best for a second frame of the same set.</small>
          </span>
        </label>
        {canCrop && (
          <label className="st-choice" data-on={how === "crop" ? "true" : undefined}>
            <input type="radio" name={`how-${shot.id}`} checked={how === "crop"} onChange={() => setHow("crop")} />
            <span>
              <strong>Crop of the {slot === "last" ? "first" : "end"} frame</strong>
              <small>{slot === "last" ? "A push-in: the end frame is a crop toward the subject, so the camera has to push." : "A pull-out: the first frame is a crop of the wide end frame."} No image quota.</small>
            </span>
          </label>
        )}
      </div>

      {how === "edit" && (
        <div className="st-stack st-stack--tight">
          <div className="st-row" style={{ flexWrap: "wrap", gap: 6 }}>
            {suggested.map((s) => (
              <Button key={s.id} size="sm" kind={baseId === s.id ? "primary" : "default"} onClick={() => setBaseId(s.id)}>{s.label}</Button>
            ))}
            <Button size="sm" kind={base && !suggested.some((s) => s.id === baseId) ? "primary" : "default"} onClick={() => setPicking(true)}>Any picture…</Button>
          </div>
          {base ? (
            <span className="st-row" style={{ gap: 8 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={(base.meta.previewUrl as string | undefined) ?? base.url} alt="" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6 }} />
              <span>Starting from <strong>{pictureTitle(base)}</strong></span>
            </span>
          ) : (
            <span className="st-warn">Choose the picture to start from.</span>
          )}
          <Field label="What changes (optional)">
            <textarea className="st-textarea" rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Left empty: it becomes this shot's frame as the shot describes it. Or say what differs, e.g. 'she now stands at the door, her hand on the handle'." />
          </Field>
        </div>
      )}

      <div className="st-row st-row--between" style={{ flexWrap: "wrap", gap: 10 }}>
        {how !== "crop" && hasQualityTiers(imaging) ? (
          <Field label="Quality">
            <select className="st-select st-input--sm" value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)}>
              <option value="">project default</option>
              <option value="low">low (drafts)</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </Field>
        ) : <span />}
        {ready ? (
          <ImageButton size="md" kind="primary" paint={how !== "crop"} label={`Generate the ${target.label.toLowerCase()}`} body={body} />
        ) : (
          <Button kind="primary" disabled>{`Generate the ${target.label.toLowerCase()}`}</Button>
        )}
      </div>
      {picking && <PicturePicker title="Start from which picture?" current={baseId} onPick={(id) => { setBaseId(id); setPicking(false); }} onClose={() => setPicking(false)} />}
    </div>
  );
}

/* ---------- popups ---------- */

/** The project's pictures to pick one from (and to clear out drafts: Select → Delete). */
function PicturePicker({ title, current, onPick, onClose }: { title: string; current?: string; onPick: (id: string) => void; onClose: () => void }) {
  const { view, reload } = useProjectContext();
  const sel = usePictureSelection();
  const images = (view?.assets ?? []).filter((a) => a.kind === "image" && a.projectId === view?.project.id).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
  return (
    <Modal title={title} size="lg" onClose={onClose} head={<SelectBar sel={sel} all={images.map((a) => a.id)} onDeleted={reload} />}>
      {images.length === 0 ? (
        <Empty title="No pictures yet" hint="Upload one, or generate it." />
      ) : (
        <div className="st-thumbs st-thumbs--named">
          {images.map((a) => (
            <div key={a.id} className="st-pic">
              <button type="button" className="st-thumb" aria-pressed={sel.selecting ? sel.selected.includes(a.id) : current === a.id} onClick={() => (sel.selecting ? sel.toggle(a.id) : onPick(a.id))} title={pictureTitle(a)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={(a.meta.previewUrl as string | undefined) ?? a.url} alt={pictureTitle(a)} loading="lazy" />
                {sel.selecting && <SelectMark on={sel.selected.includes(a.id)} />}
                {a.source === "frame-extract" && <span className="st-thumb-tag">TAKE FRAME</span>}
              </button>
              <PictureCaption asset={a} />
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** A picture at full size. */
export function Lightbox({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  return (
    <Modal title={pictureTitle(asset)} size="full" onClose={onClose} head={<a className="st-btn st-btn--sm st-btn--quiet" href={asset.url} target="_blank" rel="noreferrer">Open original</a>}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="st-lightbox-img" src={asset.url} alt={pictureTitle(asset)} />
      <p className="st-muted st-num" style={{ marginTop: 8 }}>{asset.width ? `${asset.width}×${asset.height}` : ""}{asset.meta.purpose ? ` · ${String(asset.meta.purpose)}` : ""}</p>
    </Modal>
  );
}

/* ---------- reference mode: the sheets this shot reads ---------- */

function SheetNeeds({ shot }: { shot: ShotView }) {
  const { view } = useProjectContext();
  const scene = view?.scenes.find((s) => s.id === shot.sceneId);
  const ids = [...new Set([...shot.spec.characters, ...shot.spec.props, ...(shot.spec.location ? [shot.spec.location] : scene?.locationElementId ? [scene.locationElementId] : [])])];
  const wanted = preferredViews(shot.spec)[0]!;
  const rows = ids.map((id) => view?.elements.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => !!e);
  return (
    <div className="st-stack st-stack--tight">
      <span className="st-muted">Reference mode (R2VA) reads the element sheets, not a first frame. Each element below should have a sheet, and characters the view this shot's angle wants.</span>
      {rows.length === 0 && <span className="st-muted">No characters, props or location on this shot yet: add them in the Edit tab so R2VA has references to read.</span>}
      {rows.map((el) => {
        const views = Object.values(el.refViews ?? {});
        const isChar = el.kind === "character";
        const has = el.refAssetIds.length > 0;
        const needsView = isChar && has && !views.includes(wanted);
        return (
          <div key={el.id} className="st-row st-row--between" style={{ flexWrap: "wrap" }}>
            <span>
              <strong>{el.name}</strong> <span className="st-muted">({el.kind})</span> ·{" "}
              {!has ? "no sheet yet" : needsView ? `has ${views.join(", ") || "an untagged picture"}; this shot's angle wants the ${wanted.replace("_", " ")} view` : `ready${views.length ? ` (${views.join(", ")})` : ""}`}
            </span>
            {!has && <ImageButton label={isChar ? "Generate sheet (front first)" : "Generate reference"} body={{ action: "element_sheet", elementId: el.id, views: ["front"] }} />}
            {needsView && <ImageButton label={`Add the ${wanted.replace("_", " ")} view`} body={{ action: "element_view", elementId: el.id, view: wanted }} />}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- checks ---------- */

/* Overlay first and end frame: whatever should not change must cancel out
   to black in difference mode (a wall that changes colour fades in the
   video; a cup that grows, grows). */
function FrameCheck({ first, last, aspect }: { first: string; last: string; aspect: string }) {
  const [mode, setMode] = useState<"difference" | "onion">("difference");
  const [mix, setMix] = useState(50);
  return (
    <Section
      title="Frame check · first vs end"
      aside={
        <span className="st-row">
          <Button size="sm" kind={mode === "difference" ? "default" : "quiet"} onClick={() => setMode("difference")}>Difference</Button>
          <Button size="sm" kind={mode === "onion" ? "default" : "quiet"} onClick={() => setMode("onion")}>Onion skin</Button>
        </span>
      }
    >
      <div style={{ position: "relative", width: "100%", maxHeight: 420, aspectRatio: aspect, background: "#000", borderRadius: 6, overflow: "hidden" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={first} alt="first frame" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={last} alt="end frame" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", mixBlendMode: mode === "difference" ? "difference" : "normal", opacity: mode === "onion" ? mix / 100 : 1 }} />
      </div>
      {mode === "onion" && <input type="range" min={0} max={100} value={mix} onChange={(e) => setMix(Number(e.target.value))} style={{ width: "100%" }} aria-label="End frame opacity" />}
      <p className="st-muted">{mode === "difference" ? "Black = identical. Anything bright outside the action will drift during the shot: walls, furniture, prop sizes, the horizon." : "Slide between the frames: camera position, scale and background must stay put."}</p>
    </Section>
  );
}

/* Phone-size preview: is every important person still readable? */
function PhoneCheck({ url, aspect }: { url: string; aspect: string }) {
  return (
    <Section title="Phone size">
      <div className="st-row" style={{ alignItems: "flex-end", gap: 12 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="the frame at phone size" style={{ width: aspect.startsWith("9") || aspect.startsWith("3 /") ? 110 : 180, aspectRatio: aspect, objectFit: "cover", borderRadius: 4 }} />
        <span className="st-muted">The first frame at the size it plays in a feed. Faces and props that matter should still read here.</span>
      </div>
    </Section>
  );
}
