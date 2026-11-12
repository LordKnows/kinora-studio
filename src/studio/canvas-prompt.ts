import { angleZh, POSE_ANGLES, type RefCostume, type RefPortrait, type RefPose } from "./references-model";

/*
 * The Canvas prompt: portrait + costume + pose (+ extra pictures) → one
 * character picture, or two people (a face and an outfit each, or a project
 * character) in one two-person pose, told apart by where each stands. Pure, so the page previews exactly what the server
 * sends.
 *
 * Ported from anhao/ai-pose-gallery-zh (src/services/aiGenerator.ts,
 * buildRecipePrompt; MIT, Copyright (c) 2026 Anhao), where it was tuned on
 * multi-image edit models. What each line answers:
 *  - every picture is named by its position (图1, 图2 …) and given ONE job,
 *    or the model mixes them up;
 *  - the face and hair come from the portrait, and all bare skin is unified
 *    with the face (costume pictures show other skin tones);
 *  - each garment comes from the costume picture, the name only helps;
 *  - the pose picture is a grey mannequin: only its motion and camera angle
 *    are taken, never its look, or the joints and panel lines come through;
 *  - with no portrait, a faceless display figure, not an invented person.
 * Added here: the people are adults (CharaDB forbids minors; it holds for
 * every source), and an optional free-text note.
 *
 * Two languages (lang): the Chinese original, and an English template that
 * says the same thing clause for clause — for models that follow English
 * best (MiniMax-H3-Image expects an English description; models.ts
 * promptLang is each model's default, Canvas lets the user choose).
 */

/** prompt: the style line of the Chinese template; promptEn: the same line in the English one. */
export const CANVAS_STYLES: Array<{ id: string; label: string; zh: string; prompt: string; promptEn: string; photo?: boolean }> = [
  { id: "none", label: "Follow the references", zh: "无预设（跟随参考图）", prompt: "", promptEn: "" },
  { id: "realistic", label: "Photo portrait", zh: "写实人像写真", prompt: "写实商业摄影级质感，85mm 人像镜头，自然柔和光影，真实肌肤纹理与织物细节，8k 高清画质。", promptEn: "Photorealistic commercial photography, an 85mm portrait lens, soft natural light, real skin texture and fabric detail, 8K clarity.", photo: true },
  { id: "fashion", label: "Magazine editorial", zh: "日韩杂志画报", prompt: "日韩时尚穿搭杂志画报风格，干净极简摄影棚背景，高级色调，突出人物颜值与服装剪裁。", promptEn: "Japanese and Korean fashion-magazine editorial style, a clean minimal studio backdrop, refined colour grading, the person's looks and the cut of the clothes brought out.", photo: true },
  { id: "film", label: "Film photo", zh: "复古胶片写真", prompt: "35mm 富士胶片摄影质感，轻微胶片颗粒，柔和复古暖调，自然街拍光影与电影呼吸感。", promptEn: "A 35mm Fujifilm photograph, light film grain, soft vintage warm tones, natural street light and a cinematic, breathing feel.", photo: true },
  { id: "semi_real", label: "2.5D game art", zh: "2.5D 游戏原画立绘", prompt: "2.5D 半写实高精度游戏角色原画，唯美厚涂光影，精致五官与华丽布料金属质感。", promptEn: "High-detail 2.5D semi-realistic game character art, painterly lighting, fine facial features and rich fabric and metal textures." },
  { id: "anime", label: "Anime illustration", zh: "日系二次元插画", prompt: "日系精致二次元插画风格，细腻赛璐璐与厚涂光影过渡，动漫角色立绘质感，色彩通透干净。", promptEn: "Refined Japanese anime illustration, delicate cel shading blended with painterly light, the finish of an anime character illustration, clean translucent colours." },
  { id: "cel_anime", label: "Anime film", zh: "新海诚感动画电影", prompt: "动画电影级画面质感，清澈高饱和光影，细腻体积光与发丝高光，干净唯美的动漫色彩。", promptEn: "Animated feature-film quality, clear high-saturation light, fine volumetric light and hair highlights, clean and beautiful anime colours." },
  { id: "manga", label: "Black-and-white manga", zh: "日式黑白漫画网点", prompt: "日本黑白漫画原稿风格，利落精准的G笔线稿，细腻漫画网点纸阴影与层次对比。", promptEn: "A Japanese black-and-white manga page, crisp and precise G-pen line art, fine screentone shading with layered contrast." },
  { id: "render3d", label: "3D character render", zh: "3D 次世代角色渲染", prompt: "Unreal Engine 5 / Octane Render 次世代 3D 角色渲染，细腻次表面散射肌肤材质，电影级布光。", promptEn: "A next-generation 3D character render in the manner of Unreal Engine 5 / Octane Render, fine subsurface-scattering skin, cinematic lighting." },
  { id: "chibi_box", label: "Figure / toy", zh: "3D 潮玩手办质感", prompt: "高品质 PVC 涂装完成品手办质感，柔和摄影棚柔光箱布光，精致材质高光与微距景深。", promptEn: "A high-quality painted PVC figure, soft studio softbox lighting, fine material highlights and macro depth of field." },
  { id: "cyberpunk", label: "Cyberpunk neon", zh: "赛博朋克霓虹", prompt: "赛博朋克科幻视觉风格，雨夜霓虹冷暖双色轮廓光，未来感材质反光与电影级氛围。", promptEn: "A cyberpunk science-fiction look, a rainy night with neon rim light in warm and cold colours, reflections on futuristic materials, a cinematic mood." },
  { id: "concept_sheet", label: "Character sheet (white)", zh: "角色设定集立绘（纯白底）", prompt: "标准角色设定集全身立绘，纯白干净无杂物背景，均匀漫反射布光，清晰展示全身服装结构与配饰细节。", promptEn: "A standard character-sheet full-body illustration on a clean, pure white background with nothing else in it, even diffuse lighting, the structure of the whole outfit and its accessories shown clearly." },
];

export const CANVAS_STYLE_IDS = CANVAS_STYLES.map((s) => s.id) as [string, ...string[]];

/** What an uploaded pose picture is: a photo of a person, a mannequin (白模 / line art), a depth map. */
export const POSE_PICTURES = ["photo", "mannequin", "depth"] as const;
export type PosePicture = (typeof POSE_PICTURES)[number];

/** Which figure of a two-person pose is person A (the other one is B). */
export const PLACES = ["left", "right", "front", "back", "top", "bottom"] as const;
export type Place = (typeof PLACES)[number];
/** The language the composed prompt is written in. */
export const CANVAS_LANGS = ["zh", "en"] as const;
export type CanvasLang = (typeof CANVAS_LANGS)[number];
export const CANVAS_LANG_LABEL: Record<CanvasLang, string> = { zh: "中文", en: "English" };

/** The line that says everyone drawn is an adult, as each template ends. */
export const ADULTS_LINE: Record<CanvasLang, string> = { zh: "画面中的人物均为成年人。", en: "Everyone in the picture is an adult." };

export const PLACE_EN: Record<Place, string> = { left: "on the left", right: "on the right", front: "in front (nearer the camera)", back: "behind (farther from the camera)", top: "above", bottom: "below" };
export const PLACE_ZH: Record<Place, string> = { left: "左边", right: "右边", front: "前面（离镜头近）", back: "后面（离镜头远）", top: "上方", bottom: "下方" };

/** One person of the picture: a face (portrait) or a project character's reference, and an outfit. */
export type CanvasPerson = {
  portrait?: { item?: RefPortrait; upload?: { name: string } };
  costume?: { item?: RefCostume; upload?: { name: string } };
  /** A project character: its reference picture is the face, the hair and (without a costume) the outfit. */
  character?: { name: string };
  /** How the prompt calls the person (two people); else 人物A / 人物B, or the character's name. */
  name?: string;
};

/** A slot holds a catalog item or an uploaded picture (named by the user). */
export type CanvasPromptRecipe = CanvasPerson & {
  /** picture: what an uploaded pose picture is — a photo of a person (default), a mannequin (白模 / line art) or a depth map */
  pose?: { item?: RefPose; upload?: { name: string }; depth?: boolean; mirror?: boolean; picture?: PosePicture };
  /** Two people: person B, and which figure of the pose is person A. */
  partner?: CanvasPerson;
  aIs?: Place;
  extras?: Array<{ name: string }>;
  /** Text to image: what to draw. Alone it is the whole picture; beside references, the scene they go into. */
  text?: string;
  style?: string;
  note?: string;
  /** How the model names the pictures: 图1, 图2 … (GPT Image; "Picture 1" in English), or <Picture 1>, <Picture 2> … (MiniMax-H3-Image). */
  refStyle?: "zh" | "h3";
  /** The language of the composed prompt: the Chinese original (default) or the English template. */
  lang?: CanvasLang;
};

const SKIN = (i: number) => `肤色必须与图${i}人物一致，所有裸露皮肤（包括服装镂空处露出的皮肤）必须与脸部肤色统一，统一后的肤色与质感按风格要求呈现。`;

export function buildCanvasPrompt(r: CanvasPromptRecipe): string {
  return r.lang === "en" ? buildEnglish(r) : buildChinese(r);
}

function buildChinese(r: CanvasPromptRecipe): string {
  const style = CANVAS_STYLES.find((s) => s.id === (r.style ?? "realistic")) ?? CANVAS_STYLES[1]!;
  const isPhoto = !!style.photo;
  const two = !!r.partner;
  const clauses: string[] = [];
  let idx = 1;

  /* ---- the people: each face, then each outfit ---- */
  const nameOf = (p: CanvasPerson, fallback: string) => p.name?.trim() || p.character?.name || fallback;
  const people = two ? [{ p: r as CanvasPerson, name: nameOf(r, "人物A") }, { p: r.partner!, name: nameOf(r.partner!, "人物B") }] : [{ p: r as CanvasPerson, name: "人物" }];
  const faceless = !two && !r.portrait && !r.character && !!r.costume && !!r.pose;
  const wearAt: number[] = [];
  for (const [n, { p, name }] of people.entries()) {
    const who = two ? name : "人物";
    const other = two ? people[1 - n]!.name : "";
    if (p.character) {
      const outfit = p.costume ? "" : "和服装配饰";
      clauses.push(`• ${who}：图${idx}是${p.character.name}的角色参考（同一个人），保持其脸型、五官、发型、发色、肤色${outfit}一致。`);
      idx++;
    } else if (p.portrait) {
      /* one of the user's own pictures (我的) is described as their own, not by library metadata */
      const it = p.portrait.item?.mine ? undefined : p.portrait.item;
      const hair = it ? (it.hairstyle && it.hairstyle !== "标准基础款" ? it.title : it.hairLength) : "";
      const outfit = p.costume ? "" : `保留图${idx}人物原有可见服装与配饰，不复制姿势参考图的服装或白模外观。`;
      clauses.push(`• ${who}：图${idx}中的人物，保持其脸型、五官、${hair ? `发型（${hair}）` : "发型"}和发色一致。${who === "人物" ? "人物的" : `${who}的`}${SKIN(idx)}${outfit}`);
      idx++;
    } else if (two) {
      clauses.push(`• ${who}：一位成年人，相貌自然，与${other}明显不同。`);
    }
    if (p.costume) {
      wearAt[n] = idx;
      const c = p.costume.item?.mine ? undefined : p.costume.item;
      const dress = two ? `让${who}穿上` : "让人物穿上";
      clauses.push(c
        ? `• ${two ? `${who}的服装` : "服装"}：${dress}图${idx}中展示的整套服装和配饰（参考名称：${c.name}），每件单品的颜色、款式、面料与配饰都以图${idx}为准，名称仅作辅助说明。`
        : `• ${two ? `${who}的服装` : "服装"}：${dress}图${idx}中展示的整套服装和配饰，每件单品的颜色、款式、面料与配饰都以图${idx}为准。`);
      idx++;
    }
  }

  /* ---- the pose ---- */
  if (r.pose) {
    const wear = two
      ? people.map(({ name }, n) => (wearAt[n] ? `${name}穿着图${wearAt[n]}的服装` : "")).filter(Boolean).join("，")
      : wearAt[0] ? `穿着图${wearAt[0]}的服装` : "";
    const real = two ? "最终画面中的两个人是真人，皮肤真实自然" : "最终画面中的人物是真人，皮肤真实自然";
    const body = (isPhoto ? real : two ? "两个人的肤色与质感按风格要求呈现" : "人物的肤色与质感按风格要求呈现") + (wear ? `，${wear}` : "");
    const p = r.pose.item?.mine ? undefined : r.pose.item;
    /* a flipped pose: its name's left and right are the other way round now */
    const flipped = r.pose.mirror ? "已左右镜像，以图中方向为准" : "";
    const figures = two ? "两个人体模型" : "人体模型";
    const people2 = two ? "两个人的" : "人物";
    /* two people: which figure is who, read on the picture as given (after the flip) */
    const cast = two ? `图${idx}中${PLACE_ZH[r.aIs ?? "left"]}的人是${people[0]!.name}，另一个人是${people[1]!.name}；` : "";
    const picture = r.pose.item?.mine?.picture ?? r.pose.picture ?? "photo";
    clauses.push(p
      ? `• 姿势：按照图${idx}中${figures}的动作和镜头角度摆姿势（${p.name}，${angleZh(p.angle)}${flipped ? `，${flipped}` : ""}）；${cast}图${idx}只是动作示意${r.pose.depth ? "（灰度深度图，只表示动作与远近）" : ""}，${body}。`
      : picture === "mannequin"
        ? `• 姿势：按照图${idx}中${figures}（白模）的动作和镜头角度摆姿势${flipped ? `（${flipped}）` : ""}；${cast}图${idx}只是动作示意，不照搬白模的灰白材质，${body}。`
        : picture === "depth"
          ? `• 姿势：按照图${idx}的${people2}动作和镜头角度摆姿势${flipped ? `（${flipped}）` : ""}；${cast}图${idx}是灰度深度图，只表示动作与远近，${body}。`
          : `• 姿势：按照图${idx}中的${people2}动作和镜头角度摆姿势${flipped ? `（${flipped}）` : ""}；${cast}仅参考姿势与构图，不复制图${idx}${two ? "中人物" : "人物"}的外观与服装，${body}。`);
    idx++;
  } else if (two) {
    clauses.push(`• 构图：${people[0]!.name}和${people[1]!.name}自然地同框互动。`);
  }
  if (two) {
    clauses.push(`• 两个人的脸、发型、肤色和服装各自以自己的参考图为准，不要互相混合，也不要画成同一个人；画面中恰好只有这两个人。`);
  }
  if (faceless) {
    clauses.push("• 无脸展示：生成一位穿着参考服装的成年展示人物，脸部保持无五官的自然肤色表面，不添加眼睛、鼻子、嘴巴或具体人物身份；全身裸露皮肤的颜色统一，不照搬服装图或姿势图的灰白人台材质。");
  }
  for (const extra of r.extras ?? []) {
    clauses.push(`• 附加参考：融合图${idx}（${extra.name || "补充元素"}）中的元素、配饰、背景或光影细节。`);
    idx++;
  }
  const text = r.text?.trim();
  /* text to image: no picture, the description is the picture */
  if (!clauses.length) {
    if (!text) return "";
    const plain = [text];
    if (r.note?.trim()) plain.push(`• 补充要求：${r.note.trim()}`);
    if (style.prompt) plain.push(`• 风格：${style.prompt} 比例协调，光影统一。`);
    plain.push("画面中如有人物，均为成年人。画面中没有任何文字、标志或水印。");
    return plain.join("\n");
  }
  if (text) clauses.push(`• 画面内容：${text}`);

  const what = faceless ? "人物穿搭展示图" : two ? (isPhoto ? `真实人物照片，画面中是${people[0]!.name}和${people[1]!.name}两个人` : `人物图像，画面中是${people[0]!.name}和${people[1]!.name}两个人`) : isPhoto ? "真实人物照片" : "人物图像";
  const lines = [`请根据提供的 ${idx - 1} 张参考图，生成一张完整的${what}：`, ...clauses];
  if (r.note?.trim()) lines.push(`• 补充要求：${r.note.trim()}`);
  if (style.prompt) lines.push(`• 风格：${style.prompt} ${faceless ? "人物比例协调，手部自然，脸部无五官，光影统一。" : "人物比例协调，手部与五官自然，光影统一。"}`);
  lines.push("画面中的人物均为成年人。画面中没有任何文字、标志或水印。");
  const out = lines.join("\n");
  /* MiniMax-H3-Image reads its reference pictures as <Picture 1> … <Picture 10> */
  return r.refStyle === "h3" ? out.replace(/图(\d+)/g, "<Picture $1>") : out;
}

/* ---------- the English template ---------- */

/** The library's names are Chinese (pose and costume names, hairstyles): an English prompt carries a name only when it is not. */
const latin = (text: string | undefined): string => (text && !/[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(text) ? text.trim() : "");
const angleEn = (a: RefPose["angle"]) => (POSE_ANGLES.find((x) => x.id === a)?.en ?? a).toLowerCase();

/** The Chinese template, clause for clause, in English; the pictures are named as the model reads them. */
function buildEnglish(r: CanvasPromptRecipe): string {
  const style = CANVAS_STYLES.find((s) => s.id === (r.style ?? "realistic")) ?? CANVAS_STYLES[1]!;
  const isPhoto = !!style.photo;
  const two = !!r.partner;
  const P = (i: number) => (r.refStyle === "h3" ? `<Picture ${i}>` : `Picture ${i}`);
  const clauses: string[] = [];
  let idx = 1;

  /* ---- the people: each face, then each outfit ---- */
  const nameOf = (p: CanvasPerson, fallback: string) => p.name?.trim() || p.character?.name || fallback;
  const people = two ? [{ p: r as CanvasPerson, name: nameOf(r, "Person A") }, { p: r.partner!, name: nameOf(r.partner!, "Person B") }] : [{ p: r as CanvasPerson, name: "the person" }];
  const faceless = !two && !r.portrait && !r.character && !!r.costume && !!r.pose;
  const wearAt: number[] = [];
  for (const [n, { p, name }] of people.entries()) {
    const head = two ? name : "Person";
    const whose = two ? `${name}'s` : "The person's";
    const other = two ? people[1 - n]!.name : "";
    if (p.character) {
      const kept = p.costume ? "hair colour and skin tone" : "hair colour, skin tone, clothing and accessories";
      clauses.push(`- ${head}: ${P(idx)} is the character reference for ${p.character.name} (the same person). Keep their face shape, facial features, hairstyle, ${kept} the same.`);
      idx++;
    } else if (p.portrait) {
      const it = p.portrait.item?.mine ? undefined : p.portrait.item;
      const hair = latin(it ? (it.hairstyle && it.hairstyle !== "标准基础款" ? it.title : it.hairLength) : "");
      const skin = `${whose} skin tone must match the person in ${P(idx)}: all bare skin (including skin showing through cut-outs in the clothing) is one tone with the face, rendered in the tone and texture the style asks for.`;
      const outfit = p.costume ? "" : ` Keep the clothing and accessories visible on the person in ${P(idx)}; do not copy the clothing or the mannequin look of the pose reference.`;
      clauses.push(`- ${head}: the person in ${P(idx)}. Keep their face shape, facial features, ${hair ? `hairstyle (${hair})` : "hairstyle"} and hair colour the same. ${skin}${outfit}`);
      idx++;
    } else if (two) {
      clauses.push(`- ${head}: an adult with a natural face, clearly different from ${other}.`);
    }
    if (p.costume) {
      wearAt[n] = idx;
      const cname = latin(p.costume.item?.mine ? undefined : p.costume.item?.name);
      clauses.push(`- ${two ? `${name}'s outfit` : "Outfit"}: dress ${two ? name : "the person"} in the complete outfit and accessories shown in ${P(idx)}${cname ? ` (reference name: ${cname})` : ""}. The colour, cut, fabric and accessories of every piece follow ${P(idx)}${cname ? "; the name is only a hint" : ""}.`);
      idx++;
    }
  }

  /* ---- the pose ---- */
  if (r.pose) {
    const wear = two
      ? people.map(({ name }, n) => (wearAt[n] ? `${name} wearing the outfit of ${P(wearAt[n]!)}` : "")).filter(Boolean).join(", ")
      : wearAt[0] ? `wearing the outfit of ${P(wearAt[0])}` : "";
    const real = two ? "the two people in the final picture are real people with real, natural skin" : "the person in the final picture is a real person with real, natural skin";
    const body = (isPhoto ? real : two ? "the two people's skin tone and texture follow the style" : "the person's skin tone and texture follow the style") + (wear ? `, ${wear}` : "");
    const p = r.pose.item?.mine ? undefined : r.pose.item;
    /* a flipped pose: its name's left and right are the other way round now */
    const flipped = r.pose.mirror ? "mirrored left to right: go by the directions as the picture shows them" : "";
    const figures = two ? "the two mannequins" : "the mannequin";
    const whose = two ? "the two people's" : "the person's";
    /* two people: which figure is who, read on the picture as given (after the flip) */
    const cast = two ? `in ${P(idx)} the one ${PLACE_EN[r.aIs ?? "left"]} is ${people[0]!.name} and the other is ${people[1]!.name}; ` : "";
    const picture = r.pose.item?.mine?.picture ?? r.pose.picture ?? "photo";
    const aside = (parts: string[]) => (parts.filter(Boolean).length ? ` (${parts.filter(Boolean).join(", ")})` : "");
    clauses.push(p
      ? `- Pose: take the action and the camera angle of ${figures} in ${P(idx)}${aside([latin(p.name), `${angleEn(p.angle)} view`, flipped])}; ${cast}${P(idx)} only shows the action${r.pose.depth ? " (a greyscale depth map: only the action and the distances)" : ""}; ${body}.`
      : picture === "mannequin"
        ? `- Pose: take the action and the camera angle of ${two ? "the two plain mannequins" : "the plain mannequin"} in ${P(idx)}${aside([flipped])}; ${cast}${P(idx)} only shows the action, do not copy the mannequin's grey-white material; ${body}.`
        : picture === "depth"
          ? `- Pose: take ${whose} action and the camera angle from ${P(idx)}${aside([flipped])}; ${cast}${P(idx)} is a greyscale depth map that only shows the action and the distances; ${body}.`
          : `- Pose: take ${whose} action and the camera angle from ${P(idx)}${aside([flipped])}; ${cast}use only the pose and the composition, do not copy the look or the clothing of the ${two ? "people" : "person"} in ${P(idx)}; ${body}.`);
    idx++;
  } else if (two) {
    clauses.push(`- Composition: ${people[0]!.name} and ${people[1]!.name} share the frame, interacting naturally.`);
  }
  if (two) {
    clauses.push("- Each person's face, hairstyle, skin tone and outfit follow their own reference pictures: do not mix them, and do not draw the same person twice. Exactly these two people are in the picture.");
  }
  if (faceless) {
    clauses.push("- Faceless display: an adult display figure wearing the reference outfit. The face stays a smooth surface of natural skin colour with no eyes, nose or mouth and no particular identity; all bare skin is one colour; do not copy the grey-white mannequin material of the outfit picture or the pose picture.");
  }
  for (const extra of r.extras ?? []) {
    clauses.push(`- Extra reference: work in the elements, accessories, background or lighting details of ${P(idx)} (${extra.name || "an extra element"}).`);
    idx++;
  }
  const text = r.text?.trim();
  const noText = "There is no text, logo or watermark anywhere in the picture.";
  /* text to image: no picture, the description is the picture */
  if (!clauses.length) {
    if (!text) return "";
    const plain = [text];
    if (r.note?.trim()) plain.push(`- Also: ${r.note.trim()}`);
    if (style.promptEn) plain.push(`- Style: ${style.promptEn} Balanced proportions, consistent lighting.`);
    plain.push(`Anyone in the picture is an adult. ${noText}`);
    return plain.join("\n");
  }
  if (text) clauses.push(`- Scene: ${text}`);

  const pair = two ? `${people[0]!.name} and ${people[1]!.name}` : "";
  const what = faceless ? "outfit display picture of one figure" : two ? (isPhoto ? `photograph of two real people, ${pair}` : `picture of two people, ${pair}`) : isPhoto ? "photograph of one real person" : "picture of one person";
  const n = idx - 1;
  const lines = [`From the ${n === 1 ? "reference picture" : `${n} reference pictures`} provided, create one complete ${what}:`, ...clauses];
  if (r.note?.trim()) lines.push(`- Also: ${r.note.trim()}`);
  if (style.promptEn) lines.push(`- Style: ${style.promptEn} ${faceless ? "Natural proportions and hands, a face without features, consistent lighting." : "Natural proportions, hands and facial features, consistent lighting."}`);
  lines.push(`${ADULTS_LINE.en} ${noText}`);
  return lines.join("\n");
}

export const CANVAS_SIZES = ["1024x1536", "1008x1344", "1024x1024", "1536x1024", "1344x768"] as const;
export const CANVAS_SIZE_LABEL: Record<(typeof CANVAS_SIZES)[number], string> = {
  "1024x1536": "2:3 portrait",
  "1008x1344": "3:4 portrait",
  "1024x1024": "1:1 square",
  "1536x1024": "3:2 landscape",
  "1344x768": "16:9 wide",
};
/* ---------- resolution: a picture delivered at the model's own working area ---------- */

/** The areas a model with a working range (MiniMax-H3-Image: about 4–20 MP) can deliver a picture at, instead of the Studio size. */
export const CANVAS_RESOLUTIONS = ["4mp", "9mp", "16mp"] as const;
export type CanvasResolution = (typeof CANVAS_RESOLUTIONS)[number];
/** The side of the square of each area: 2048² = 4 MP, 3072² = 9 MP, 4096² = 16 MP. */
export const CANVAS_RESOLUTION_SIDE: Record<CanvasResolution, number> = { "4mp": 2048, "9mp": 3072, "16mp": 4096 };
export const CANVAS_RESOLUTION_LABEL: Record<CanvasResolution, string> = { "4mp": "4 MP", "9mp": "9 MP", "16mp": "16 MP" };

/**
 * The size a picture of a Studio shape is delivered at for a resolution: the same shape scaled up to that
 * area, on the model's 32-pixel grid — 1344x768 at 16 MP is 5376x3072, 1024x1536 at 4 MP is 1664x2496.
 * The painter's working_canvas (paint.py) finds the same canvas for the same shape, so a picture asked
 * for at this size is drawn at it, pixel for pixel, and never resized.
 */
export function canvasOutputSize(size: string, resolution: CanvasResolution | undefined, multiple = 32): string {
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m || !resolution) return size;
  const [w, h] = [Number(m[1]), Number(m[2])];
  const area = CANVAS_RESOLUTION_SIDE[resolution] ** 2;
  const scale = Math.sqrt(area / (w * h));
  const first = Math.max(1, Math.floor((h * scale) / multiple));
  let best: { off: number; px: number; w: number; h: number } | undefined;
  for (let rows = first; rows < first + 8; rows++) {
    const ch = rows * multiple;
    const cw = Math.max(multiple, Math.round((ch * w) / h / multiple) * multiple);
    if (cw * ch < 0.97 * area) continue;
    const off = Math.round((Math.abs(cw / ch - w / h) / (w / h)) * 1e4) / 1e4;
    if (!best || off < best.off || (off === best.off && cw * ch < best.px)) best = { off, px: cw * ch, w: cw, h: ch };
  }
  return best ? `${best.w}x${best.h}` : size;
}

/** Codex's image tool takes at most five pictures per call (paint.py MAX_CODEX_PICTURES); each model says its own (models.ts maxRefs). */
export const CANVAS_MAX_REFS = 5;
/** The most any model takes (MiniMax-H3-Image: ten). */
export const CANVAS_MAX_REFS_ANY = 10;
