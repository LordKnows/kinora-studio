"use client";

import { useEffect, useState } from "react";

import { preferredViews } from "@/studio/compiler";
import type { ShotView } from "@/studio/orchestrator";
import type { Asset } from "@/studio/types";

import { get, patch, post } from "./api";
import { Button, Empty, ErrorBanner, Field, Modal, Section, UploadButton, useAction } from "./common";
import { useT } from "./i18n";
import { hasQualityTiers, ImageButton, reviewChip, useImagingOn } from "./image-tools";
import { PicturePopup, Zoomable } from "./picture-zoom";
import { PictureCaption, pictureSize, pictureTitle } from "./pictures";
import { useProjectContext } from "./shell";

/*
 * The Frames tab of a shot, in two parts that do not mix:
 *
 *  1. What the shot has — by its mode. Text mode (the "No frame" choice) needs
 *     no picture: the model draws the shot from its description alone. Reference
 *     mode reads the element sheets (and an optional reference frame).
 *     Keyframe mode is either ONE hero frame (I2VA) or a FIRST and an END
 *     frame (FL2VA): only the slots of the chosen kind are shown. A slot shows
 *     its whole picture (click: full size), and choose / upload. Editing a
 *     region and deleting a picture live on the Pictures page.
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
  const tr = useT();
  const aspect = aspectCss(view?.project.look.aspectRatio);
  const [keyMode, setFrameMode] = useState<"hero" | "first_last">(shot.endAssetId || shot.spec.frames?.last ? "first_last" : "hero");
  const [lightbox, setLightbox] = useState<Asset | null>(null);
  const [plan, setPlan] = useState<PlanRow | null>(null);
  useEffect(() => {
    void get<{ shots: PlanRow[] }>(`/api/projects/${projectId}/frame-plan`).then((p) => setPlan(p.shots.find((r) => r.shotId === shot.id) ?? null)).catch(() => setPlan(null));
  }, [projectId, shot.id, shot.heroAssetId, shot.endAssetId, shot.spec.mode]);

  const setFrame = useAction(async (_c, slot: Slot, assetId: string | null) => {
    await post(`/api/shots/${shot.id}/${slot === "first" ? "hero-frame" : "end-frame"}`, { assetId });
    await reload();
  });
  const mode = shot.spec.mode;
  /* "No frame" is the shot's text mode: nothing starts the take, the model draws it from the shot's description */
  const frameMode: "none" | "hero" | "first_last" = mode === "text" ? "none" : keyMode;
  const setShotMode = useAction(async (_c, next: "text" | "keyframe") => {
    await patch(`/api/shots/${shot.id}`, { mode: next });
    await reload();
  });
  const chooseMode = async (m: "none" | "hero" | "first_last") => {
    if (m === "none") {
      if (mode === "text") return;
      if ((shot.heroAssetId || shot.endAssetId) && !window.confirm(tr("Draw this shot from its description alone? The frames stay on the shot and in Pictures, but the take does not use them."))) return;
      await setShotMode.fire("text");
      return;
    }
    if (m === "hero" && shot.endAssetId) {
      if (!window.confirm(tr("Use one hero frame only? The end frame is taken off this shot (the picture stays in Pictures)."))) return;
      await setFrame.fire("last", null);
    }
    setFrameMode(m);
    if (mode === "text") await setShotMode.fire("keyframe");
  };
  const chooser = (
    <div className="st-row" style={{ flexWrap: "wrap", gap: 12 }}>
      <div className="st-seg" role="group" aria-label={tr("Frames of this shot")}>
        <button type="button" aria-pressed={frameMode === "hero"} disabled={setShotMode.busy} onClick={() => void chooseMode("hero")}>
          {tr("Hero frame")}<small>{tr("one picture → the take starts from it")}</small>
        </button>
        <button type="button" aria-pressed={frameMode === "first_last"} disabled={setShotMode.busy} onClick={() => void chooseMode("first_last")}>
          {tr("First + end frame")}<small>{tr("the take goes from one to the other")}</small>
        </button>
        <button type="button" aria-pressed={frameMode === "none"} disabled={setShotMode.busy} onClick={() => void chooseMode("none")}>
          {tr("No frame")}<small>{tr("the model draws it from the shot's description")}</small>
        </button>
      </div>
    </div>
  );
  if (mode === "text") {
    return (
      <div className="st-stack">
        <ErrorBanner error={setShotMode.error ?? setFrame.error} projectId={projectId} onDismiss={() => { setShotMode.dismiss(); setFrame.dismiss(); }} />
        {chooser}
        <Empty title={tr("No frame")} hint={plan?.first === "anchor"
          ? tr("H3 draws this shot from its prompt alone. It is linked to its anchor shot, so the take still starts on the anchor take's last frame; change the link in the Edit tab to start free.")
          : tr("H3 draws this shot from its prompt alone: the description, the camera and the elements. To start from a picture, choose a hero frame or a first and an end frame above.")} />
      </div>
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
      <ErrorBanner error={setFrame.error ?? setShotMode.error} projectId={projectId} onDismiss={() => { setFrame.dismiss(); setShotMode.dismiss(); }} />

      {mode === "reference" && (
        <Section title={tr("Reference sheets")}>
          <SheetNeeds shot={shot} />
        </Section>
      )}

      {mode === "keyframe" && chooser}

      <Section title={tr(mode === "reference" ? "Reference frame" : frameMode === "hero" ? "Hero frame" : "First and end frame")}>
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
  const { projectId } = useProjectContext();
  const tr = useT();
  const asset = slot === "first" ? shot.hero : shot.end;
  const [picking, setPicking] = useState(false);
  const what = tr(label.toLowerCase().replace(" (optional)", ""));
  return (
    <div className="st-frame-slot">
      <div className="st-row st-row--between">
        <strong>{tr(label)}</strong>
        {asset && reviewChip(asset) && <span className="st-chip">{tr(reviewChip(asset)!)}</span>}
      </div>
      {asset ? (
        <Zoomable url={asset.url} title={pictureTitle(asset)} facts={pictureSize(asset)}>
          <button type="button" className="st-frame-view" style={frameBox(aspect)} onClick={() => onView(asset)} title={tr("Open full size")}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={(asset.meta.previewUrl as string | undefined) ?? asset.url} alt={pictureTitle(asset)} />
          </button>
        </Zoomable>
      ) : (
        <div className="st-frame-empty" style={frameBox(aspect)}>
          <span>
            {tr("No {what} yet", { what })}
            <br />
            <span className="st-muted">{tr("choose a picture, upload one, or generate it below")}</span>
          </span>
        </div>
      )}
      {asset ? <PictureCaption asset={asset} /> : <span className="st-muted">{tr(hint)}</span>}
      <div className="st-row" style={{ flexWrap: "wrap", gap: 6 }}>
        <Button size="sm" onClick={() => setPicking(true)}>{asset ? tr("Replace…") : tr("Choose…")}</Button>
        <UploadButton accept="image/jpeg,image/png,image/webp" projectId={projectId} label={tr("Upload")} title={tr("Upload from this device")} onUploaded={({ assetId }) => onSet(assetId)} />
      </div>
      {picking && <PicturePicker title={tr("Choose the {what}", { what })} current={asset?.id} onPick={(id) => { setPicking(false); void onSet(id); }} onClose={() => setPicking(false)} />}
    </div>
  );
}

/* ---------- generate a frame: which one, and how ---------- */

type How = "new" | "edit" | "crop";

function GenerateFrame({ shot, plan, targets }: { shot: ShotView; plan: PlanRow | null; targets: Array<{ slot: Slot; label: string }> }) {
  const { view } = useProjectContext();
  const tr = useT();
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
  if (other) suggested.push({ id: other.id, label: slot === "first" ? tr("this shot's end frame") : tr("this shot's first frame") });
  if (previous?.hero && previous.hero.id !== other?.id) suggested.push({ id: previous.hero.id, label: tr("the earlier shot's frame (same place and angle)") });
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
        <strong style={{ fontSize: 15 }}>{tr("Generate a frame")}</strong>
        <span className="st-muted">{tr("drawn with {who}", { who: imaging.drawnBy })}{imaging.on ? "" : ` — ${imaging.why}`}</span>
      </div>

      {targets.length > 1 && (
        <div className="st-seg" role="group" aria-label={tr("Which frame")}>
          {targets.map((t) => (
            <button key={t.slot} type="button" aria-pressed={slot === t.slot} onClick={() => setSlot(t.slot)}>{tr(t.label)}</button>
          ))}
        </div>
      )}
      {suggestion && METHOD_LABEL[suggestion] && <span className="st-muted">{tr("Suggested for this shot: {method}", { method: tr(METHOD_LABEL[suggestion]) })}{plan?.why ? ` — ${plan.why}` : ""}{tr(".")}</span>}

      <div className="st-stack st-stack--tight">
        <label className="st-choice" data-on={how === "new" ? "true" : undefined}>
          <input type="radio" name={`how-${shot.id}`} checked={how === "new"} onChange={() => setHow("new")} />
          <span>
            <strong>{tr("From scratch")}</strong>
            <small>{tr("A new picture from the shot's description, staging, composition and palette, with the element sheets and the style frame as references.")}</small>
          </span>
        </label>
        <label className="st-choice" data-on={how === "edit" ? "true" : undefined}>
          <input type="radio" name={`how-${shot.id}`} checked={how === "edit"} onChange={() => setHow("edit")} />
          <span>
            <strong>{tr("From a picture you choose")}</strong>
            <small>{tr("Starts from an existing picture and changes it into this frame — same people, place and light. Best for a second frame of the same set.")}</small>
          </span>
        </label>
        {canCrop && (
          <label className="st-choice" data-on={how === "crop" ? "true" : undefined}>
            <input type="radio" name={`how-${shot.id}`} checked={how === "crop"} onChange={() => setHow("crop")} />
            <span>
              <strong>{slot === "last" ? tr("Crop of the first frame") : tr("Crop of the end frame")}</strong>
              <small>{slot === "last" ? tr("A push-in: the end frame is a crop toward the subject, so the camera has to push.") : tr("A pull-out: the first frame is a crop of the wide end frame.")} {tr("No image quota.")}</small>
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
            <Button size="sm" kind={base && !suggested.some((s) => s.id === baseId) ? "primary" : "default"} onClick={() => setPicking(true)}>{tr("Any picture…")}</Button>
          </div>
          {base ? (
            <span className="st-row" style={{ gap: 8 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={(base.meta.previewUrl as string | undefined) ?? base.url} alt="" style={{ width: 72, height: 72, objectFit: "contain", background: "#000", borderRadius: 0 }} />
              <span>{tr("Starting from")} <strong>{pictureTitle(base)}</strong></span>
            </span>
          ) : (
            <span className="st-warn">{tr("Choose the picture to start from.")}</span>
          )}
          <Field label={tr("What changes (optional)")}>
            <textarea className="st-textarea" rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={tr("Left empty: it becomes this shot's frame as the shot describes it. Or say what differs, e.g. 'she now stands at the door, her hand on the handle'.")} />
          </Field>
        </div>
      )}

      <div className="st-row st-row--between" style={{ flexWrap: "wrap", gap: 10 }}>
        {how !== "crop" && hasQualityTiers(imaging) ? (
          <Field label={tr("Quality")}>
            <select className="st-select st-input--sm" value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)}>
              <option value="">{tr("project default")}</option>
              <option value="low">{tr("low (drafts)")}</option>
              <option value="medium">{tr("medium||quality")}</option>
              <option value="high">{tr("high||quality")}</option>
            </select>
          </Field>
        ) : <span />}
        {ready ? (
          <ImageButton size="md" kind="primary" paint={how !== "crop"} label={tr("Generate the {what}", { what: tr(target.label.toLowerCase()) })} body={body} />
        ) : (
          <Button kind="primary" disabled>{tr("Generate the {what}", { what: tr(target.label.toLowerCase()) })}</Button>
        )}
      </div>
      {picking && <PicturePicker title={tr("Start from which picture?")} current={baseId} onPick={(id) => { setBaseId(id); setPicking(false); }} onClose={() => setPicking(false)} />}
    </div>
  );
}

/* ---------- popups ---------- */

/** The project's pictures to pick one from (editing and deleting them is on the Pictures page). */
function PicturePicker({ title, current, onPick, onClose }: { title: string; current?: string; onPick: (id: string) => void; onClose: () => void }) {
  const { view } = useProjectContext();
  const tr = useT();
  const images = (view?.assets ?? []).filter((a) => a.kind === "image" && a.projectId === view?.project.id).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
  return (
    <Modal title={title} size="lg" onClose={onClose}>
      {images.length === 0 ? (
        <Empty title={tr("No pictures yet")} hint={tr("Upload one, or generate it.")} />
      ) : (
        <div className="st-thumbs st-thumbs--named">
          {images.map((a) => (
            <div key={a.id} className="st-pic">
              <Zoomable url={a.url} title={pictureTitle(a)} facts={pictureSize(a)}>
                <button type="button" className="st-thumb" aria-pressed={current === a.id} onClick={() => onPick(a.id)} title={pictureTitle(a)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={(a.meta.previewUrl as string | undefined) ?? a.url} alt={pictureTitle(a)} loading="lazy" />
                  {a.source === "frame-extract" && <span className="st-thumb-tag">{tr("TAKE FRAME")}</span>}
                </button>
              </Zoomable>
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
  return <PicturePopup url={asset.url} title={pictureTitle(asset)} facts={pictureSize(asset)} onClose={onClose} />;
}

/* ---------- reference mode: the sheets this shot reads ---------- */

function SheetNeeds({ shot }: { shot: ShotView }) {
  const { view } = useProjectContext();
  const tr = useT();
  const viewName = (v: string) => tr(`${v}||reference view`);
  const scene = view?.scenes.find((s) => s.id === shot.sceneId);
  const ids = [...new Set([...shot.spec.characters, ...shot.spec.props, ...(shot.spec.location ? [shot.spec.location] : scene?.locationElementId ? [scene.locationElementId] : [])])];
  const wanted = preferredViews(shot.spec)[0]!;
  const rows = ids.map((id) => view?.elements.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => !!e);
  return (
    <div className="st-stack st-stack--tight">
      <span className="st-muted">{tr("Reference mode (R2VA) reads the element sheets, not a first frame. Each element below should have a sheet, and characters the view this shot's angle wants.")}</span>
      {rows.length === 0 && <span className="st-muted">{tr("No characters, props or location on this shot yet: add them in the Edit tab so R2VA has references to read.")}</span>}
      {rows.map((el) => {
        const views = Object.values(el.refViews ?? {});
        const isChar = el.kind === "character";
        const has = el.refAssetIds.length > 0;
        const needsView = isChar && has && !views.includes(wanted);
        return (
          <div key={el.id} className="st-row st-row--between" style={{ flexWrap: "wrap" }}>
            <span>
              <strong>{el.name}</strong> <span className="st-muted">({tr(el.kind)})</span> ·{" "}
              {!has ? tr("no sheet yet") : needsView ? tr("has {views}; this shot's angle wants the {view} view", { views: views.map(viewName).join(", ") || tr("an untagged picture"), view: viewName(wanted.replace("_", " ")) }) : `${tr("ready")}${views.length ? ` (${views.map(viewName).join(", ")})` : ""}`}
            </span>
            {!has && <ImageButton label={isChar ? tr("Generate sheet (face first)") : tr("Generate reference")} body={{ action: "element_sheet", elementId: el.id, views: isChar ? [] : ["front"] }} />}
            {needsView && <ImageButton label={tr("Add the {view} view", { view: viewName(wanted.replace("_", " ")) })} body={{ action: "element_view", elementId: el.id, view: wanted }} />}
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
  const tr = useT();
  const [mode, setMode] = useState<"difference" | "onion">("difference");
  const [mix, setMix] = useState(50);
  return (
    <Section
      title={tr("Frame check · first vs end")}
      aside={
        <span className="st-row">
          <Button size="sm" kind={mode === "difference" ? "default" : "quiet"} onClick={() => setMode("difference")}>{tr("Difference")}</Button>
          <Button size="sm" kind={mode === "onion" ? "default" : "quiet"} onClick={() => setMode("onion")}>{tr("Onion skin")}</Button>
        </span>
      }
    >
      <div style={{ position: "relative", width: "100%", maxHeight: 420, aspectRatio: aspect, background: "#000", borderRadius: 0, overflow: "hidden" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={first} alt={tr("first frame")} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={last} alt={tr("end frame")} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", mixBlendMode: mode === "difference" ? "difference" : "normal", opacity: mode === "onion" ? mix / 100 : 1 }} />
      </div>
      {mode === "onion" && <input type="range" min={0} max={100} value={mix} onChange={(e) => setMix(Number(e.target.value))} style={{ width: "100%" }} aria-label={tr("End frame opacity")} />}
      <p className="st-muted">{mode === "difference" ? tr("Black = identical. Anything bright outside the action will drift during the shot: walls, furniture, prop sizes, the horizon.") : tr("Slide between the frames: camera position, scale and background must stay put.")}</p>
    </Section>
  );
}

/* Phone-size preview: is every important person still readable? */
function PhoneCheck({ url, aspect }: { url: string; aspect: string }) {
  const tr = useT();
  return (
    <Section title={tr("Phone size")}>
      <div className="st-row" style={{ alignItems: "flex-end", gap: 12 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={tr("the frame at phone size")} style={{ width: aspect.startsWith("9") || aspect.startsWith("3 /") ? 110 : 180, aspectRatio: aspect, objectFit: "contain", background: "#000", borderRadius: 0 }} />
        <span className="st-muted">{tr("The first frame at the size it plays in a feed. Faces and props that matter should still read here.")}</span>
      </div>
    </Section>
  );
}
