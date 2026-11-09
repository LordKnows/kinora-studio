/* The Canvas reference library as the pages and the API see it: resolved
   items (every URL points at the gallery that publishes the picture), the
   labels, the 18+ rule and the terms of each source. No data here — the
   catalog itself is server-side (references.ts) — so the Canvas page can
   import this file. */

import type { PosePicture } from "./canvas-prompt";
import type { FaceVerdict } from "./face-verdict";

export type RefKind = "pose" | "costume" | "portrait";
export type PoseSystem = "standard" | "sensual" | "upper" | "couple" | "mine";
export type PoseAngle = "front" | "diag" | "side" | "high" | "low";
export type CostumeSource = "gia" | "gia-anime" | "charadb" | "shisei" | "mine";

/**
 * 我的: a picture the signed-in user uploaded into the library (user_references), seen in every project of theirs.
 * A portrait carries its face check (模拟 / 真实); a costume or a pose carries none. A pose says what its picture is.
 */
export type MineInfo = { tags: string[]; createdAt: number; picture?: PosePicture; faceCheck?: FaceVerdict; faceCheckError?: { why?: string } };

export type RefPose = {
  kind: "pose";
  id: string;
  system: PoseSystem;
  /** The pose (all angles share it): `${system}:${number}`. */
  group: string;
  number: string;
  category: string;
  name: string;
  angle: PoseAngle;
  nsfw: boolean;
  thumb: string;
  image: string;
  depthThumb: string;
  depthImage: string;
  mine?: MineInfo;
};

export type RefCostumeView = { id: string; label: string; thumb: string; image: string };

export type RefCostume = {
  kind: "costume";
  id: string;
  source: CostumeSource;
  /** 现实 (photo-real) or 二次元 (anime). */
  style: "real" | "anime";
  category: string;
  name: string;
  nameJa?: string;
  tags: string[];
  keywords: string;
  nsfw: boolean;
  thumb: string;
  /** The picture sent to the image model. */
  image: string;
  /** The largest file the source publishes (for "open original"). */
  original: string;
  views?: RefCostumeView[];
  mine?: MineInfo;
};

export type RefPortrait = {
  kind: "portrait";
  id: string;
  section: string;
  hairLength: string;
  hairstyle: string;
  title: string;
  width: number;
  height: number;
  featured: boolean;
  hot: boolean;
  nsfw: false;
  thumb: string;
  image: string;
  mine?: MineInfo;
};

export type RefItem = RefPose | RefCostume | RefPortrait;

export const POSE_SYSTEMS: Array<{ id: PoseSystem; zh: string; en: string; nsfw: boolean }> = [
  { id: "standard", zh: "全身单人・标准系", en: "Full body", nsfw: false },
  { id: "upper", zh: "上半身单人", en: "Upper body", nsfw: false },
  { id: "sensual", zh: "全身单人・性感系", en: "Full body · sensual", nsfw: true },
  { id: "couple", zh: "双人缠绵", en: "Couple", nsfw: true },
  { id: "mine", zh: "我的", en: "Mine", nsfw: false },
];

export const POSE_ANGLES: Array<{ id: PoseAngle; zh: string; en: string }> = [
  { id: "front", zh: "正面", en: "Front" },
  { id: "diag", zh: "斜侧", en: "Three-quarter" },
  { id: "side", zh: "侧面", en: "Side" },
  { id: "high", zh: "俯视", en: "From above" },
  { id: "low", zh: "仰视", en: "From below" },
];

export const angleZh = (a: PoseAngle) => POSE_ANGLES.find((x) => x.id === a)?.zh ?? a;

/** Costume categories that are 18+ whatever their source flags. */
export const NSFW_COSTUME_CATEGORIES = ["内衣・睡衣", "性感穿搭"];

export const COSTUME_SOURCES: Array<{ id: CostumeSource; label: string; site: string; terms: string }> = [
  { id: "gia", label: "ギア · 写实", site: "https://ai-costume-gallery.pages.dev/", terms: "Free to use as a reference, commercial work included. No bulk download, no redistribution of the pictures." },
  { id: "gia-anime", label: "ギア · 动漫", site: "https://ai-costume-anime-gallery.pages.dev/", terms: "Pictures load from ギア's site; follow its terms." },
  { id: "charadb", label: "たき AI · CharaDB", site: "https://github.com/taki-ttt/charadb/blob/main/LICENSE", terms: "Reference only: never on a real person's photo, never for a minor, no redistribution, the pictures themselves cannot be sold." },
  { id: "shisei", label: "Shisei · 中国历代", site: "https://github.com/wquguru/shisei", terms: "CC0 (wquguru). AI-generated references, not scholarly reconstructions." },
  { id: "mine", label: "我的", site: "", terms: "Your own pictures, uploaded to the library." },
];

/** The section, category or source a 我的 item is listed under. */
export const MINE_LABEL = "我的";

export const isMine = (item: RefItem | undefined): boolean => !!item?.mine;

export const REFERENCE_TERMS = {
  poses: "Poses and depth maps: ギア (@giaaibusi), ai-pose-gallery.pages.dev. Free to use one picture at a time as a generation reference, commercial work included; bulk download, redistribution and resale are not allowed.",
  portraits: "Portraits: ギア, ai-portrait-gallery.pages.dev, CC0. AI-generated fictional adults; never use one to impersonate a real person.",
  translation: "Chinese names and tags: anhao/ai-pose-gallery-zh.",
};

export const REF_KIND_LABEL: Record<RefKind, { en: string; zh: string }> = {
  portrait: { en: "Portraits", zh: "人像" },
  costume: { en: "Costumes", zh: "服装" },
  pose: { en: "Poses", zh: "姿势" },
};

export const referenceName = (item: RefItem): string => (item.kind === "portrait" ? item.title : item.name);

/** The text a search matches against. */
export function searchText(item: RefItem): string {
  switch (item.kind) {
    case "pose":
      return `${item.id} ${item.category} ${item.name} ${item.number} ${POSE_SYSTEMS.find((s) => s.id === item.system)?.zh ?? ""} ${angleZh(item.angle)} ${item.mine?.tags.join(" ") ?? ""}`.toLowerCase();
    case "costume":
      return `${item.id} ${item.category} ${item.name} ${item.nameJa ?? ""} ${item.tags.join(" ")} ${item.keywords}`.toLowerCase();
    case "portrait":
      return `${item.id} ${item.section} ${item.hairLength} ${item.hairstyle} ${item.title} ${item.mine?.tags.join(" ") ?? ""}`.toLowerCase();
  }
}

/** The picture of an item as it would be sent: a pose as line art or depth, a costume in its chosen view. */
export function referenceImage(item: RefItem, opts: { depth?: boolean; view?: string } = {}): { thumb: string; image: string } {
  if (item.kind === "pose") return opts.depth ? { thumb: item.depthThumb, image: item.depthImage } : { thumb: item.thumb, image: item.image };
  if (item.kind === "costume" && item.views?.length) {
    const v = item.views.find((x) => x.id === opts.view) ?? item.views.find((x) => x.id === "front") ?? item.views[0]!;
    return { thumb: v.thumb, image: v.image };
  }
  return { thumb: item.thumb, image: item.image };
}
