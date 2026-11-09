import { FACE_KINDS, type FaceKind, type FaceVerdict } from "./face-verdict";
import * as repo from "./repo";
import { getObject, keyOfPublicUrl } from "./storage/r2";
import type { Asset } from "./types";

export { describeVerdict, faceAllowed, FACE_KINDS, type FaceKind, type FaceVerdict } from "./face-verdict";

/*
 * The face check of an uploaded (or imported) picture, for 18+ work: is the
 * face in it a photograph of a real person, or a 3D render / an illustration?
 * A vision model looks at the picture once (TokenSail's Qwen, or DashScope's
 * Qwen-VL, with the Worker's TOKENSAIL_API_KEY / DASHSCOPE_API_KEY) and the
 * verdict stays on the picture (meta.faceCheck).
 *
 * Let through with 18+: a 3D render or an illustration of an adult who is no
 * real, recognisable person, or a picture with no human face. Kept out: a
 * photograph, anything photorealistic (an AI photo cannot be told from a
 * real one), a real person's likeness (a celebrity in 3D is still them), a
 * minor or an age the model cannot tell, a low-confidence answer, and any
 * picture the check could not see (no key, too large, an error).
 */

/** Where the check runs: TokenSail first, then DashScope; undefined without a key. */
function route(): { url: string; key: string; model: string } | undefined {
  const base = (process.env.QWEN_API_BASE ?? "").replace(/\/+$/, "");
  const model = process.env.FACE_CHECK_MODEL;
  if (process.env.TOKENSAIL_API_KEY) return { url: `${base || "https://api.tokensail.ai/v1"}/chat/completions`, key: process.env.TOKENSAIL_API_KEY, model: model || "qwen3.7-plus" };
  if (process.env.DASHSCOPE_API_KEY) return { url: `${base || "https://dashscope.aliyuncs.com"}/compatible-mode/v1/chat/completions`, key: process.env.DASHSCOPE_API_KEY, model: model || "qwen-vl-max-latest" };
  return undefined;
}

export function faceCheckAvailable(): boolean {
  return !!route();
}

const MAX_BYTES = 7 * 1024 * 1024;

const ASK = `You check one picture uploaded to an image tool, before it is used as a face reference for adult (18+) artwork.
Answer with JSON only: {"kind": ..., "likeness": ..., "age": ..., "confidence": ..., "reason": ...}
- kind: "real_photo" (a camera photograph of a real human, filters and retouching included), "photoreal" (looks like a photograph of a human but may be generated or rendered; you cannot be sure it is not a real photo), "render_3d" (visibly a 3D / CG character render: game, Blender, Daz, MetaHuman and the like, stylised or realistic but clearly rendered), "illustration" (drawing, painting, anime, comic, cartoon), or "no_face" (no human or humanoid face in the picture).
- likeness: true when the face is a recognisable real person (a celebrity, a public figure), whether photographed, rendered or drawn; else false.
- age: "adult" when every person clearly looks 18 or older, "minor" when anyone looks under 18, "unclear" otherwise.
- confidence: 0 to 1, how sure you are of kind.
- reason: one short sentence.
When in doubt between real_photo and photoreal, choose real_photo; between photoreal and render_3d, choose photoreal.`;

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function bytesOf(asset: Asset): Promise<{ bytes: Uint8Array; type: string } | undefined> {
  const key = keyOfPublicUrl(asset.url) ?? (typeof asset.meta.key === "string" ? asset.meta.key : undefined);
  const res = key ? await getObject(key) : await fetch(asset.url);
  if (!res.ok) return undefined;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  return { bytes, type: type.startsWith("image/") ? type : "image/png" };
}

function parse(text: string, model: string): FaceVerdict | undefined {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return undefined;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const kind = FACE_KINDS.includes(o.kind as FaceKind) ? (o.kind as FaceKind) : undefined;
    if (!kind) return undefined;
    const age = o.age === "adult" || o.age === "minor" ? o.age : "unclear";
    const confidence = Math.max(0, Math.min(1, Number(o.confidence) || 0));
    return { kind, likeness: o.likeness === true, age, confidence, reason: String(o.reason ?? "").slice(0, 300), model, at: Date.now() };
  } catch {
    return undefined;
  }
}

/**
 * The face check of a picture: the one on it, or a new one (kept on the picture). Undefined when it cannot be
 * checked — no key, too large, the model did not answer — and then the picture counts as a real face.
 */
export async function faceVerdict(asset: Asset): Promise<FaceVerdict | undefined> {
  const kept = asset.meta.faceCheck as FaceVerdict | undefined;
  if (kept && FACE_KINDS.includes(kept.kind)) return kept;
  const r = route();
  if (!r) return undefined;
  const pic = await bytesOf(asset).catch(() => undefined);
  if (!pic || pic.bytes.length > MAX_BYTES) return undefined;
  const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:${pic.type};base64,${base64(pic.bytes)}` } }, { type: "text", text: ASK }] }];
  const ask = (json: boolean) => fetch(r.url, {
    method: "POST",
    headers: { authorization: `Bearer ${r.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: r.model, temperature: 0, ...(json ? { response_format: { type: "json_object" } } : {}), messages }),
  }).catch(() => undefined);
  /* JSON mode where the vendor has it; the prompt asks for JSON either way */
  let res = await ask(true);
  if (res?.status === 400) res = await ask(false);
  if (!res?.ok) return undefined;
  const body = (await res.json().catch(() => undefined)) as { choices?: Array<{ message?: { content?: string } }> } | undefined;
  const verdict = parse(body?.choices?.[0]?.message?.content ?? "", r.model);
  if (verdict) await repo.updateAssetMeta(asset.id, { ...asset.meta, faceCheck: verdict }).catch(() => undefined);
  return verdict;
}
