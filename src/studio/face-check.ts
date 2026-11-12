import { FACE_KINDS, faceAllowed, type FaceKind, type FaceVerdict } from "./face-verdict";
import * as repo from "./repo";
import { getObject, keyOfPublicUrl } from "./storage/r2";
import type { Asset } from "./types";

export { describeVerdict, faceAllowed, FACE_KINDS, type FaceKind, type FaceVerdict } from "./face-verdict";

/*
 * The face check of an uploaded (or imported) picture, as it arrives — the
 * only time a model looks at a picture (drawings get their tag from what
 * they were drawn from, provenance.ts). A vision model (TokenSail's
 * qwen3.8-max-0902, or DashScope's Qwen-VL, with the Worker's
 * TOKENSAIL_API_KEY / DASHSCOPE_API_KEY) looks once; the verdict and its
 * tag stay on the picture (meta.faceCheck, meta.realness).
 *
 * 模拟: a 3D render or an illustration of an adult who is no real,
 * recognisable person, or a picture with no human face — the reference of
 * any picture, R18 included. 真实: a photograph, anything photorealistic (an
 * AI photo cannot be told from a real one), a real person's likeness (a
 * celebrity in 3D is still them), a minor or an age the model cannot tell, a
 * low-confidence answer, and any picture the check could not see (no key,
 * an error, a timeout) — not for R18; every other picture as before.
 */

/** Where the check runs: TokenSail first, then DashScope; undefined without a key. */
function route(): { url: string; key: string; model: string } | undefined {
  const base = (process.env.QWEN_API_BASE ?? "").replace(/\/+$/, "");
  const model = process.env.FACE_CHECK_MODEL;
  if (process.env.TOKENSAIL_API_KEY) return { url: `${base || "https://api.tokensail.ai/v1"}/chat/completions`, key: process.env.TOKENSAIL_API_KEY, model: model || "qwen3.8-max-0902" };
  if (process.env.DASHSCOPE_API_KEY) return { url: `${base || "https://dashscope.aliyuncs.com"}/compatible-mode/v1/chat/completions`, key: process.env.DASHSCOPE_API_KEY, model: model || "qwen-vl-max-latest" };
  return undefined;
}

export function faceCheckAvailable(): boolean {
  return !!route();
}

/* larger pictures go by their URL (the vendor fetches it) */
const MAX_INLINE = 10 * 1024 * 1024;

const ASK = `Look at this picture and say who is in it. It is used as a reference picture in an image tool.
Answer with JSON only: {"kind": ..., "likeness": ..., "age": ..., "confidence": ..., "reason": ...}
- kind:
  "no_face": no human face large and clear enough to copy — a landscape, a room, an object, a creature, or a scene (a game scene included) whose people are small, far away, seen from behind or turned away.
  "render_3d": a 3D / CG render — a video game screenshot or character, Blender, Daz, MetaHuman, Unreal, a 3D model or figure — however realistic it looks. Game UI, a HUD, typical game lighting or materials mean render_3d.
  "illustration": drawn or painted — anime, manga, comic, cartoon, concept art, digital painting.
  "photoreal": a face that looks like a camera photograph, and nothing in the picture shows it is rendered or drawn.
  "real_photo": a camera photograph of a real human (filters and retouching included).
- likeness: true only when the face is clearly a specific real person you recognise (a celebrity, a public figure); false otherwise.
- age: judge every clearly visible person by face, body proportions and context. "adult" when they look 18 or older, "minor" when anyone looks under 18, "unclear" only when you truly cannot tell. Use "adult" for no_face.
- confidence: 0 to 1, how sure you are of kind.
- reason: one short sentence on what you see.`;

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function bytesOf(pic: { url: string; key?: string }): Promise<{ bytes: Uint8Array; type: string } | undefined> {
  const key = keyOfPublicUrl(pic.url) ?? pic.key;
  const res = key ? await getObject(key) : await fetch(pic.url);
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

/** Why a check gave no verdict, kept on the picture (meta.faceCheckError) and shown with its label. */
async function failed(asset: Asset, why: string): Promise<undefined> {
  await repo.updateAssetMeta(asset.id, { ...asset.meta, realness: "real", faceCheckError: { why: why.slice(0, 300), at: Date.now() } }).catch(() => undefined);
  return undefined;
}

/**
 * The face check of a picture: the one on it (unless force), or a new one, kept on the picture. Undefined when it
 * cannot be checked — the reason is kept on the picture — and then the picture is 真实.
 */
/** Ask the model about one stored picture: its verdict, or why there is none. */
export async function checkPicture(pic: { url: string; key?: string }): Promise<{ verdict?: FaceVerdict; why?: string }> {
  const r = route();
  if (!r) return { why: "no TOKENSAIL_API_KEY or DASHSCOPE_API_KEY on the Worker" };
  const data = await bytesOf(pic).catch(() => undefined);
  if (!data) return { why: "the picture could not be read from storage" };
  const image = data.bytes.length <= MAX_INLINE ? `data:${data.type};base64,${base64(data.bytes)}` : pic.url;
  const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: image } }, { type: "text", text: ASK }] }];
  const ask = (json: boolean) => fetch(r.url, {
    method: "POST",
    headers: { authorization: `Bearer ${r.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: r.model, temperature: 0, ...(json ? { response_format: { type: "json_object" } } : {}), messages }),
  }).catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
  /* JSON mode where the vendor has it; the prompt asks for JSON either way */
  let res = await ask(true);
  if (!(res instanceof Error) && res.status === 400) res = await ask(false);
  if (res instanceof Error) return { why: `${r.model} could not be reached: ${res.message}` };
  if (!res.ok) return { why: `${r.model} answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}` };
  const body = (await res.json().catch(() => undefined)) as { choices?: Array<{ message?: { content?: string } }> } | undefined;
  const text = body?.choices?.[0]?.message?.content ?? "";
  const verdict = parse(text, r.model);
  return verdict ? { verdict } : { why: `${r.model} gave no verdict: ${text.slice(0, 160) || "an empty answer"}` };
}

/**
 * The face check of a project picture: the one on it (unless force), or a new one, kept on the picture with its
 * tag. Undefined when it cannot be checked — the reason is kept on the picture — and then the picture is 真实.
 */
export async function faceVerdict(asset: Asset, opts: { force?: boolean } = {}): Promise<FaceVerdict | undefined> {
  const kept = asset.meta.faceCheck as FaceVerdict | undefined;
  if (!opts.force && kept && FACE_KINDS.includes(kept.kind)) return kept;
  const { verdict, why } = await checkPicture({ url: asset.url, key: typeof asset.meta.key === "string" ? asset.meta.key : undefined });
  if (!verdict) return failed(asset, why ?? "no verdict");
  const { faceCheckError: _old, ...meta } = asset.meta;
  await repo.updateAssetMeta(asset.id, { ...meta, faceCheck: verdict, realness: faceAllowed(verdict) ? "sim" : "real" }).catch(() => undefined);
  return verdict;
}

const ARRIVAL_TIMEOUT_MS = 25_000;

/**
 * The face check of a picture as it arrives (an upload, an import): run now so the picture carries its label
 * (模拟 / 真实) from the start — the only time a model looks at a picture. A check that takes too long or fails
 * leaves it 真实 until Check again on the Design page (Pictures tab). Library pictures (meta.reference) need none.
 */
export async function checkOnArrival(asset: Asset): Promise<Asset> {
  if (asset.kind !== "image" || asset.meta.reference || asset.meta.faceCheck || !route()) return asset;
  const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ARRIVAL_TIMEOUT_MS));
  const verdict = await Promise.race([faceVerdict(asset).catch(() => undefined), timeout]);
  const fresh = await repo.getAsset(asset.id).catch(() => undefined);
  if (!fresh) return verdict ? { ...asset, meta: { ...asset.meta, faceCheck: verdict } } : asset;
  if (!fresh.meta.faceCheck && !fresh.meta.faceCheckError) {
    await failed(fresh, `took over ${ARRIVAL_TIMEOUT_MS / 1000} s`);
    return repo.getAsset(asset.id);
  }
  return fresh;
}
