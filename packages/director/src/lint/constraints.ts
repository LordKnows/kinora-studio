import type { Warning } from "../types.js";

/*
 * The Look's constraints (stored as `look.negative`) and H3.
 *
 * H3 has no negative prompt: its guider runs at cfg 1 with no negative
 * branch, so every word of the Look reaches the model as a description.
 * MiniMax's writing guides carry no ban list at all, and ComfyUI's H3 prompt
 * guide says "Ban lists add unwanted concepts. State what should appear".
 * A constraint is therefore a statement of what the picture shows.
 *
 * Three kinds of entry do not fit that:
 *  - bare:     a negative-prompt word with nothing around it ("blurry",
 *              "lowres", "cartoon"). In the prompt it asks for the thing.
 *              Left out of the prompt.
 *  - text_ban: "no on-screen text", "no logos", "no subtitles"… H3 draws
 *              only the text a prompt quotes, so the ban adds nothing but
 *              the word. Left out of the prompt.
 *  - ban:      any other "no X". It is the user's own sentence and stays in
 *              the prompt; lint asks for the positive form.
 */

export type ConstraintKind = "ok" | "bare" | "text_ban" | "ban";

export interface ConstraintVerdict {
  text: string;
  kind: ConstraintKind;
  /** Whether the compiler writes this entry into the prompt. */
  inPrompt: boolean;
  /** What to write instead (absent for `ok`). */
  suggest?: string;
}

const NEGATION = /^(no|not|never|without|avoid|don't|do not)[\s-]+|^(不要|没有|禁止|不能有|不出现|不得|避免|无(?=画面|文字|字幕|水印|标志|商标|台标|logo))/i;

const TEXT_THING = /^(any\s+)?(on-?screen\s+|burned-?in\s+|visible\s+)?(text|texts|words|letters|lettering|writing|typography|logos?|brand(s|ing)?|subtitles?|captions?|watermarks?|signatures?|titles?|credits)(\s+(overlays?|on screen|in frame))?$|^(画面)?(内)?(文字|字幕|水印|标志|商标|台标|logo)$/i;

/* The vocabulary of image-model negative prompts: words that only ever
   meant "not this". An entry made of nothing else is a bare negative. */
const BARE_TERM = /^(low[\s-]?res(olution)?|lowres|low[\s-]quality|worst[\s-]quality|bad[\s-]quality|normal[\s-]quality|blur|blurry|blurred|out of focus|jpeg artifacts?|compression artifacts?|artifacts?|noise|noisy|grainy|pixelated|deformed|distorted|disfigured|malformed|mutated|mutation|bad anatomy|bad hands|bad proportions|extra (limbs?|fingers?|arms?|legs?|hands?)|missing (limbs?|fingers?|arms?|legs?)|fused fingers|ugly|plastic skin|waxy skin|doll skin|over-?smoothed|airbrushed|over-?saturated|over-?exposed|under-?exposed|washed out|flicker(ing)?|jitter(y)?|shaky|shaking|stutter(ing)?|morphing|warping|duplicate|cropped|cut off|cartoon|cartoonish|anime|manga|illustration|illustrated|drawing|sketch|painting|3d|3d render|render|cgi|cg|photoreal(ism|istic)?|realistic|模糊|低分辨率|低清|低质量|低画质|变形|畸形|扭曲|噪点|卡通|动漫|动画|插画|手绘|三维|渲染|塑料皮肤|磨皮|过曝|闪烁|抖动)$/i;

/** What to write instead, by what the entry is about. First match wins. */
const REWRITES: Array<{ re: RegExp; suggest: string }> = [
  { re: /text|word|letter|writing|typograph|logo|brand|subtitle|caption|watermark|signature|title|credit|文字|字幕|水印|标志|商标|logo/i, suggest: "leave it out: H3 draws only the text a prompt quotes, and titles are added in the edit" },
  { re: /blur|out of focus|low[\s-]?res|lowres|quality|artifact|noise|noisy|grain|pixel|模糊|分辨率|低清|画质|质量|噪点/i, suggest: "say it in the Look's camera: 'sharp focus, crisp detail, clean high resolution'" },
  { re: /skin|smooth|airbrush|wax|doll|皮肤|磨皮/i, suggest: "'natural skin texture with visible pores' in the Look's camera" },
  { re: /cartoon|anime|manga|illustrat|drawing|sketch|painting|3d|render|cgi|\bcg\b|photoreal|realis|卡通|动漫|动画|插画|手绘|三维|渲染|写实/i, suggest: "name the medium the film is in at the start of the Look's genre ('Live-action, photorealistic' or '2D hand-drawn animation')" },
  { re: /people|person|crowd|extras?|bystander|passers|faces?|人群|路人|其他人|多余的人/i, suggest: "say who is there: 'exactly two people in the room', 'the street is empty'" },
  { re: /shak|jitter|handheld|stutter|flicker|wobbl|抖|晃|闪烁/i, suggest: "set the shot's camera move (static compiles to a locked-off shot) or write 'steady, locked-off camera'" },
  { re: /deform|distort|disfigur|malform|mutat|anatomy|hands?|fingers?|limbs?|arms?|legs?|变形|畸形|扭曲|手指/i, suggest: "say what is there: 'both hands rest on the table, five fingers each', or frame so the hands are out of shot" },
  { re: /dialogue|speech|speak|talk|voice|music|score|song|对白|说话|配乐|音乐/i, suggest: "leave it out: dialogue and music are set per shot (a shot with no lines keeps mouths closed, music 'N/A')" },
  { re: /expos|saturat|washed|过曝|饱和/i, suggest: "say it in the Look's palette or lighting: 'balanced exposure, muted saturation'" },
  { re: /colou?r|颜色|色彩/i, suggest: "name the colours that are there in the Look's palette" },
  { re: /modern|contemporary|anachron|现代/i, suggest: "name the period and what belongs to it in the Look's genre" },
];

const GENERIC = "say what the picture shows instead: H3 has no negative prompt, so a ban only adds the word it bans";

function suggestFor(body: string): string {
  return REWRITES.find((r) => r.re.test(body))?.suggest ?? GENERIC;
}

function clean(text: string): string {
  return text.trim().replace(/[.。;；!！\s]+$/, "");
}

/** What one Look constraint is, whether it goes into the prompt, and what to write instead. */
export function checkConstraint(text: string): ConstraintVerdict {
  const t = clean(text);
  if (!t) return { text, kind: "ok", inPrompt: false };
  const body = t.replace(NEGATION, "").trim();
  const negated = body !== t;
  if (TEXT_THING.test(body)) return { text, kind: "text_ban", inPrompt: false, suggest: suggestFor(body) };
  if (negated) return { text, kind: "ban", inPrompt: true, suggest: suggestFor(body) };
  const parts = t.split(/[,，、/]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 0 && parts.every((p) => BARE_TERM.test(p) || TEXT_THING.test(p))) return { text, kind: "bare", inPrompt: false, suggest: suggestFor(t) };
  return { text, kind: "ok", inPrompt: true };
}

/** The constraints the compiler writes into the prompt, and the ones it leaves out. */
export function promptConstraints(list: readonly string[]): { keep: string[]; dropped: ConstraintVerdict[] } {
  const keep: string[] = [];
  const dropped: ConstraintVerdict[] = [];
  for (const text of list) {
    const v = checkConstraint(text);
    if (v.inPrompt) keep.push(text);
    else if (clean(text)) dropped.push(v);
  }
  return { keep, dropped };
}

const each = (vs: ConstraintVerdict[]) => vs.map((v) => `"${clean(v.text)}" → ${v.suggest}`).join("; ");

/** Lint over a Look's constraints: one finding per kind, each entry with its positive form. */
export function lintConstraints(list: readonly string[]): Warning[] {
  const verdicts = list.map(checkConstraint);
  const of = (k: ConstraintKind) => verdicts.filter((v) => v.kind === k);
  const out: Warning[] = [];
  const bare = of("bare");
  if (bare.length) out.push({ code: "look.constraints.bare", severity: "warn", message: `Look constraints written as negative-prompt words are left out of the prompt (H3 has no negative prompt; the bare word would be drawn): ${each(bare)}` });
  const text = of("text_ban");
  if (text.length) out.push({ code: "look.constraints.text", severity: "info", message: `Look constraints about text are left out of the prompt (${text.map((v) => `"${clean(v.text)}"`).join(", ")}): H3 draws only the text a prompt quotes; remove them from the Look` });
  const ban = of("ban");
  if (ban.length) out.push({ code: "look.constraints.ban", severity: "info", message: `Look constraints written as bans go into the prompt as written, where a ban can add the thing it names: ${each(ban)}` });
  return out;
}
