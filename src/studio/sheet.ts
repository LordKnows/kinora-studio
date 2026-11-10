import { placedFeature } from "./compiler";
import { MAX_DETAILS, type FixedFeature, type RefView } from "./schemas";
import type { Element } from "./types";

/* A character's sheet, in the order identity is built:
     1. face        the portrait: uploaded or drawn; everything else copies it
     2. expression  from the portrait alone — the test that the face holds when it moves
        detail      up to three close pictures of fixed features that are not on the face
     3. front       the whole figure, from the portrait and the details
     4. side, back  from the portrait, the front and the details
   Pure functions over an element, shared by the server (imaging.ts) and the
   Elements page, so both show the same next step. */

export const ON_HEAD = /\b(face|cheeks?|eyes?|eyelids?|brows?|eyebrows?|forehead|nose|mouth|lips?|chin|jaw|ears?|hair|head|temples?)\b|脸|面部|眼|眉|额|鼻|嘴|唇|下巴|耳|头|发/i;
export const ON_BACK = /\b(back|behind|nape|rear)\b|背|后/i;

/** The fixed features that get a close detail picture: the ones flagged for it, else the first that are not on the head (the portrait shows those). */
export function detailTargets(el: Element): FixedFeature[] {
  if (el.kind !== "character") return [];
  const feats = el.fixedFeatures ?? [];
  const flagged = feats.filter((f) => f.detail === true);
  return (flagged.length ? flagged : feats.filter((f) => f.detail !== false && !ON_HEAD.test(f.where))).slice(0, MAX_DETAILS);
}

/** The element's detail pictures with the feature each one shows. */
export function detailRefs(el: Element): Array<{ assetId: string; feature?: FixedFeature; label: string }> {
  return el.refAssetIds.filter((a) => el.refViews?.[a] === "detail").map((a) => {
    const text = el.refFeatures?.[a];
    const feature = text ? el.fixedFeatures?.find((f) => f.feature === text) : undefined;
    return { assetId: a, feature, label: feature ? placedFeature(feature) : text ?? "a detail" };
  });
}

/** Detail targets that have no picture yet. */
export function missingDetails(el: Element): FixedFeature[] {
  const drawn = new Set(detailRefs(el).map((d) => d.feature?.feature));
  return detailTargets(el).filter((f) => !drawn.has(f.feature));
}

export type SheetStage = "face" | "expression and details" | "front" | "other views" | "complete";
export type SheetStep = { view: RefView; feature?: string };

/** Where a character's sheet stands, and what is drawn next (see the order above). */
export function sheetStage(el: Element): { stage: SheetStage; now: SheetStep[]; later: SheetStep[] } {
  const have = new Set(Object.values(el.refViews ?? {}));
  const details: SheetStep[] = missingDetails(el).map((f) => ({ view: "detail", feature: f.feature }));
  const head: SheetStep[] = [...(have.has("expression") ? [] : [{ view: "expression" as RefView }]), ...details];
  const others: SheetStep[] = (["side", "back"] as RefView[]).filter((v) => !have.has(v)).map((v) => ({ view: v }));
  const front: SheetStep[] = have.has("front") ? [] : [{ view: "front" }];
  if (!have.has("face")) return { stage: "face", now: [{ view: "face" }], later: [...head, ...front, ...others] };
  if (head.length) return { stage: "expression and details", now: head, later: [...front, ...others] };
  if (front.length) return { stage: "front", now: front, later: others };
  if (others.length) return { stage: "other views", now: others, later: [] };
  return { stage: "complete", now: [], later: [] };
}

export const STAGE_NEXT: Record<SheetStage, string> = {
  face: "the portrait is the identity everything else copies: look at it and show it to the user before going on. Then call again for the expressions and the details",
  "expression and details": "check the four expressions are one person (same eyes, nose, mouth, hairline as the portrait) and each detail is the design you meant. Then call again for the front figure",
  front: "check the front figure against the portrait and the details. Then call again for the side and the back",
  "other views": "review each view; the sheet is then complete",
  complete: "the sheet is complete: name views to redraw one",
};

