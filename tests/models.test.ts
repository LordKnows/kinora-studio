import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { CanvasCompose, composeCharacter } from "@/studio/canvas";
import { buildCanvasPrompt, CANVAS_RESOLUTION_SIDE, CANVAS_RESOLUTIONS, CANVAS_SIZES, canvasOutputSize } from "@/studio/canvas-prompt";
import * as imaging from "@/studio/imaging";
import { AGENT_IMAGE_MODELS, canvasLangFor, defaultImageParams, editSizeFor, describeParams, findModel, IMAGE_MODELS, isGraphDefault, MODELS, namePicturesFor, QWEN21_TURBO_SIGMAS, resolveParams, type ModelEntry } from "@/studio/models";
import * as painter from "@/studio/painter";
import { listReferences, setAdultContent } from "@/studio/references";
import * as repo from "@/studio/repo";
import type { Actor } from "@/studio/types";

/* The model registry: every model with the settings its authors recommend,
   resolved as base model → workflow variant → speed LoRA → the caller's
   steps; LoRAs carrying their own settings; and an image model on the GPU
   pod (Qwen-Image 2.1 Turbo) routed to the pod's painter only. */

const web: Actor = { user: "models@local", via: "web" };

async function memoryDb(): Promise<Db> {
  const { default: Database } = await import("better-sqlite3");
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db: Db = {
    async all<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).all(...(params as never[])) as T[]; },
    async get<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).get(...(params as never[])) as T | undefined; },
    async run(sql: string, params: unknown[] = []) { return { changes: Number(sqlite.prepare(sql).run(...(params as never[])).changes) }; },
    async exec(sql: string) { sqlite.exec(sql); },
  };
  await migrate(db);
  return db;
}

beforeAll(async () => {
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  setDb(await memoryDb());
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
});

const H3 = findModel("minimax-h3") as ModelEntry;
const QWEN = findModel("qwen-image-2.1-turbo") as ModelEntry;
const turbo = { id: "lora_h3_turbo_fl2v", name: "H3 turbo 8-step (fl2v)", kind: "speed" };

describe("resolving the settings", () => {
  it("takes the base model's recommendation, its workflow variant, then the speed LoRA's chain", () => {
    const base = resolveParams(H3, { workflow: "I2VA" });
    expect(base.params).toMatchObject({ steps: 20, sampler: "res_multistep", scheduler: "simple", shiftVideo: 1, shiftAudio: 1 });
    expect(resolveParams(H3, { workflow: "R2VA" }).params.scheduler).toBe("beta");
    expect(isGraphDefault(H3, base.params)).toBe(false);
    const fast = resolveParams(H3, { workflow: "R2VA", loras: [turbo] });
    expect(fast.params).toMatchObject({ steps: 8, sampler: "euler", scheduler: "simple", shiftVideo: 6, shiftAudio: 3 });
    expect(fast.sources).toEqual(["MiniMax H3", "H3 turbo 8-step (fl2v)"]);
    /* the turbo chain is what the graphs carry: nothing more to send */
    expect(isGraphDefault(H3, fast.params)).toBe(true);
  });

  it("a speed LoRA with its own chain replaces the graph's, and one with only steps runs on the graph's", () => {
    const own = resolveParams(H3, { loras: [{ id: "x", name: "4-step", kind: "speed", params: { steps: 4, shiftVideo: 5 } }] });
    expect(own.params).toMatchObject({ steps: 4, sampler: "euler", shiftVideo: 5, shiftAudio: 3 });
    expect(isGraphDefault(H3, own.params)).toBe(false);
    const hintOnly = resolveParams(H3, { loras: [{ id: "y", name: "6-step", kind: "speed", stepsHint: 6 }] });
    expect(hintOnly.params).toMatchObject({ steps: 6, sampler: "euler", scheduler: "simple", shiftVideo: 6 });
  });

  it("the caller's steps win with a warning; a fixed schedule ignores them", () => {
    const r = resolveParams(H3, { loras: [turbo], steps: 12 });
    expect(r.params.steps).toBe(12);
    expect(r.warnings[0]).toContain("tuned for 8 steps");
    const q = resolveParams(QWEN, { steps: 30 });
    expect(q.params.steps).toBe(8);
    expect(q.params.sigmas).toEqual(QWEN21_TURBO_SIGMAS);
    expect(q.warnings[0]).toContain("fixed 8-step schedule");
  });

  it("flags a LoRA strength outside its card's range", () => {
    const r = resolveParams(H3, { loras: [{ id: "lora_jojocodex_physics", name: "Physics", kind: "effect", strength: 0.9 }] });
    expect(r.warnings.some((w) => w.includes("0.3–0.5"))).toBe(true);
    expect(describeParams(resolveParams(H3, { loras: [turbo] }).params)).toBe("8 steps · euler/simple · shift 6/3");
  });
});

describe("the registry and the pod agree", () => {
  const pod = join(__dirname, "..", "workers", "h3-runpod");
  const manifest = JSON.parse(readFileSync(join(pod, "workflows", "image_models.json"), "utf8")) as Record<string, { files: string; workflow: string; variants?: Record<string, { workflow?: string }> }>;

  it("every pod image model has a workflow, a manifest entry and the same download list", () => {
    for (const m of IMAGE_MODELS.filter((x) => x.runtime === "pod")) {
      expect(m.backend).toBe(`comfy:${m.id}`);
      const entry = manifest[m.id]!;
      expect(entry).toBeTruthy();
      expect(m.workflows).toContain(entry.workflow);
      const listed = readFileSync(join(pod, entry.files), "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split("\t")[1]);
      expect(listed).toEqual(m.files!.map((f) => f.url));
      const graph = JSON.parse(readFileSync(join(pod, "workflows", `${entry.workflow}.json`), "utf8")) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
      const loaded = Object.values(graph).flatMap((n) => Object.values(n.inputs ?? {})).filter((v) => typeof v === "string");
      for (const f of m.files!) expect(loaded).toContain(f.file);
      /* a model with a graph per picture count lists them all */
      for (const v of Object.values(entry.variants ?? {})) if (v.workflow) expect(m.workflows).toContain(v.workflow);
    }
  });

  it("ids are unique, image models name a backend, non-commercial licences say so", () => {
    expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
    expect(IMAGE_MODELS.every((m) => !!m.backend)).toBe(true);
    expect(QWEN.commercial).toBe(false);
  });
});

describe("LoRAs carry their settings", () => {
  it("seeded LoRAs know their card; a user's own values and its steps hint fill in the rest", async () => {
    const fal = await repo.getLora("lora_fal_realism_people");
    expect(fal.recommended.strengthRange).toEqual([0.6, 1]);
    expect(fal.baseModel).toBe("minimax-h3");
    const t = await repo.getLora("lora_h3_turbo_ref2v");
    expect(t.recommended).toMatchObject({ steps: 8, sampler: "euler", shiftVideo: 6 });
    const mine = await repo.createLora({ name: "Qwen 6-step", kind: "speed", filename: "p_q_image_2.1_6_steps.safetensors", triggerWords: "", defaultStrength: 1, workflows: [], notes: "", baseModel: "qwen-image-2.1", params: { steps: 6, cfg: 1 } });
    expect(mine.recommended).toMatchObject({ steps: 6, cfg: 1, strength: 1 });
    const edited = await repo.updateLora(mine.id, { params: { steps: 5 } });
    expect(edited.params).toEqual({ steps: 5 });
    expect(edited.baseModel).toBe("qwen-image-2.1");
  });
});

describe("an image model on the GPU pod", () => {
  let projectId = "";
  const portrait = async () => (await listReferences("portrait", false)).items[0]!;
  const costume = async () => (await listReferences("costume", false)).items.find((x) => x.kind === "costume" && x.source === "gia")!;

  it("queues a Qwen job with its settings, <imageN> references and no Codex review", async () => {
    projectId = (await repo.createProject({ name: "Qwen canvas" })).id;
    await imaging.setImaging(projectId, { enabled: true }, web);
    const r = await composeCharacter(projectId, CanvasCompose.parse({ model: "qwen-image-2.1-turbo", portrait: { id: (await portrait()).id }, costume: { id: (await costume()).id }, seed: 42 }), web);
    expect(r.model).toBe("qwen-image-2.1-turbo");
    const job = await repo.getJob(r.job.id);
    expect(job.input.backend).toBe("comfy:qwen-image-2.1-turbo");
    expect(job.input.params).toMatchObject({ steps: 8, cfg: 1, sampler: "euler", sigmas: QWEN21_TURBO_SIGMAS, seed: 42 });
    expect((job.input.check as { review: boolean }).review).toBe(false);
    expect(String(job.input.prompt)).toContain("<image1>中的人物");
    expect(String(job.input.prompt)).not.toContain("图1");
    /* nobody but the GPU pod can draw it: the answer says so */
    expect(r.runner).toContain("GPU pod");
    expect(painter.isPodBackend(job)).toBe(true);
  });

  it("only a painter on the pod that has the model claims it, and it gets the settings", async () => {
    const cpu = await painter.claim({ painterId: "cpu", name: "cpu", want: 4, info: { backends: ["codex"], ops: ["paint", "crop", "extract"] } });
    expect(cpu.jobs.some((j) => j.input.backend === "comfy:qwen-image-2.1-turbo")).toBe(false);
    const gpu = await painter.claim({ painterId: "gpu-pod-1", name: "gpu", want: 4, info: { backends: ["comfy:qwen-image-2.1-turbo"], ops: ["paint", "crop", "extract"], onPod: true } });
    const got = gpu.jobs.find((j) => j.input.backend === "comfy:qwen-image-2.1-turbo")!;
    expect(got.input.params).toMatchObject({ steps: 8, seed: 42 });
  });

  it("takes up to ten pictures, and never an 18+ reference on an uploaded face", async () => {
    const up = await repo.createAsset({ projectId, url: "https://studio.example/media/uploads/u/face.png", kind: "image", source: "upload", meta: {}, name: "face" });
    const nine = Array.from({ length: 9 }, () => ({ assetId: up.id }));
    await expect(composeCharacter(projectId, CanvasCompose.parse({ model: "qwen-image-2.1-turbo", portrait: { id: (await portrait()).id }, extras: nine }), web)).resolves.toBeTruthy();
    await expect(composeCharacter(projectId, CanvasCompose.parse({ model: "gpt-image-codex", portrait: { id: (await portrait()).id }, extras: nine.slice(0, 5) }), web)).rejects.toMatchObject({ code: "validation" });
    await setAdultContent(web, { enabled: true, confirmAdult: true });
    const adultPose = (await listReferences("pose", true)).items.find((x) => x.nsfw)!;
    await expect(composeCharacter(projectId, CanvasCompose.parse({ model: "qwen-image-2.1-turbo", portrait: { assetId: up.id }, pose: { id: adultPose.id } }), web)).rejects.toMatchObject({ code: "validation" });
  });
});

describe("Qwen-Image 2.1 base with ChatR Omni", () => {
  const BASE = findModel("qwen-image-2.1") as ModelEntry;
  const adultUser: Actor = { user: "omni@local", via: "web" };
  let projectId = "";
  const omni = { id: "lora_chatr_omni_v01", strength: 1 };

  it("is seeded in the library with its card's settings, marked 18+, for the base model only", async () => {
    const l = await repo.getLora("lora_chatr_omni_v01");
    expect(l.baseModel).toBe("qwen-image-2.1");
    expect(l.adult).toBe(true);
    expect(l.recommended).toMatchObject({ steps: 35, cfg: 5, strength: 1 });
    expect(l.hfUrl).toContain("chatrlabs/Qwen-Image-2.1-Uncensored-Omni-LoRA-v0.1");
    const r = resolveParams(BASE, { loras: [l] });
    expect(r.params).toMatchObject({ steps: 35, cfg: 5, sampler: "euler", scheduler: "simple" });
    expect(r.sources).toEqual(["Qwen-Image 2.1", "ChatR Omni v0.1 (uncensored)"]);
    expect(resolveParams(BASE).params).toMatchObject({ steps: 40, cfg: 1 });
  });

  it("needs the 18+ switch, the base model, a pod model and library pictures only", async () => {
    projectId = (await repo.createProject({ name: "Omni" })).id;
    await imaging.setImaging(projectId, { enabled: true }, adultUser);
    const portrait = (await listReferences("portrait", false)).items[1]!;
    const recipe = { portrait: { id: portrait.id }, loras: [omni] };
    await expect(composeCharacter(projectId, CanvasCompose.parse({ model: "qwen-image-2.1", ...recipe }), adultUser)).rejects.toMatchObject({ code: "forbidden" });
    await setAdultContent(adultUser, { enabled: true, confirmAdult: true });
    await expect(composeCharacter(projectId, CanvasCompose.parse({ model: "qwen-image-2.1-turbo", ...recipe }), adultUser)).rejects.toMatchObject({ code: "validation" });
    await expect(composeCharacter(projectId, CanvasCompose.parse({ model: "gpt-image-codex", ...recipe }), adultUser)).rejects.toMatchObject({ code: "validation" });
    const up = await repo.createAsset({ projectId, url: "https://studio.example/media/uploads/u/prop.png", kind: "image", source: "upload", meta: {}, name: "prop" });
    await expect(composeCharacter(projectId, CanvasCompose.parse({ model: "qwen-image-2.1", ...recipe, extras: [{ assetId: up.id }] }), adultUser)).rejects.toMatchObject({ code: "validation" });
  });

  it("queues the base model with the LoRA's settings and file, and keeps the adult line in a typed prompt", async () => {
    const portrait = (await listReferences("portrait", false)).items[1]!;
    const r = await composeCharacter(projectId, CanvasCompose.parse({ model: "qwen-image-2.1", portrait: { id: portrait.id }, loras: [omni], prompt: "<image1> at the beach" }), adultUser);
    const job = await repo.getJob(r.job.id);
    expect(job.input.backend).toBe("comfy:qwen-image-2.1");
    expect(job.input.params).toMatchObject({ steps: 35, cfg: 5, sampler: "euler", scheduler: "simple", loras: [{ file: "chatrlabs-omni-lora-v0.1-bf16.safetensors", strength: 1 }] });
    expect((job.input.params as { loras: Array<{ hf_url: string }> }).loras[0]!.hf_url).toMatch(/^https:\/\/huggingface\.co\/chatrlabs\//);
    expect(job.input.prompt).toBe("<image1> at the beach\n画面中的人物均为成年人。");
    expect((job.input.canvas as { loras: Array<{ id: string }> }).loras[0]!.id).toBe("lora_chatr_omni_v01");
  });

  it("a deleted built-in LoRA stays deleted", async () => {
    await repo.deleteLora("lora_chatr_omni_v01");
    expect((await repo.listLoras()).some((l) => l.id === "lora_chatr_omni_v01")).toBe(false);
  });
});

describe("Qwen-Image-Edit 2509: the pose gallery's workflow", () => {
  const QIE = findModel("qwen-image-edit-2509") as ModelEntry;
  let projectId = "";
  const portrait = async () => (await listReferences("portrait", false)).items[2]!;
  const costume = async () => (await listReferences("costume", false)).items.find((x) => x.kind === "costume" && x.source === "gia")!;
  const pose = async () => (await listReferences("pose", false)).items[0]!;

  it("is Apache-2.0, four Lightning steps, 图N references, pose recipes only", () => {
    expect(QIE.commercial).toBe(true);
    expect(QIE.refStyle).toBe("zh");
    expect(QIE.poseRecipe).toBe(true);
    expect(resolveParams(QIE).params).toEqual({ steps: 4, cfg: 1, sampler: "euler", scheduler: "simple" });
    expect(QIE.files!.reduce((n, f) => n + f.gb, 0)).toBeGreaterThan(30);
  });

  it("queues portrait + costume + pose with its settings and a 图N prompt", async () => {
    projectId = (await repo.createProject({ name: "2509" })).id;
    await imaging.setImaging(projectId, { enabled: true }, web);
    const r = await composeCharacter(projectId, CanvasCompose.parse({ model: "qwen-image-edit-2509", portrait: { id: (await portrait()).id }, costume: { id: (await costume()).id }, pose: { id: (await pose()).id } }), web);
    const job = await repo.getJob(r.job.id);
    expect(job.input.backend).toBe("comfy:qwen-image-edit-2509");
    expect(job.input.params).toMatchObject({ steps: 4, cfg: 1, sampler: "euler", scheduler: "simple" });
    expect(job.input.refUrls).toHaveLength(3);
    /* the canvas follows the pose picture (3:4), whatever size was picked: never the costume picture's 2:3 */
    expect(job.input.size).toBe("1008x1344");
    expect(String(job.input.prompt)).toContain("图3中人体模型");
    expect(job.input.mirrorRefs).toBeUndefined();
  });

  it("needs a pose and a portrait or a costume, and no extra pictures", async () => {
    const up = await repo.createAsset({ projectId, url: "https://studio.example/media/uploads/u/prop2.png", kind: "image", source: "upload", meta: {}, name: "prop" });
    const go = (recipe: Record<string, unknown>) => composeCharacter(projectId, CanvasCompose.parse({ model: "qwen-image-edit-2509", ...recipe }), web);
    await expect(go({ portrait: { id: (await portrait()).id }, costume: { id: (await costume()).id } })).rejects.toThrow(/draws a pose/);
    await expect(go({ pose: { id: (await pose()).id } })).rejects.toThrow(/portrait or a costume/);
    await expect(go({ portrait: { id: (await portrait()).id }, pose: { id: (await pose()).id }, extras: [{ assetId: up.id }] })).rejects.toThrow(/extra pictures/);
    /* person + pose: the two-picture graph */
    const two = await go({ costume: { id: (await costume()).id }, pose: { id: (await pose()).id } });
    expect((await repo.getJob(two.job.id)).input.refUrls).toHaveLength(2);
  });

  it("a flipped pose is mirrored by a painter that can, and the prompt says so", async () => {
    const r = await composeCharacter(projectId, CanvasCompose.parse({ model: "gpt-image-codex", portrait: { id: (await portrait()).id }, pose: { id: (await pose()).id, mirror: true } }), web);
    const job = await repo.getJob(r.job.id);
    expect(job.input.mirrorRefs).toEqual([1]);
    expect(String(job.input.prompt)).toContain("已左右镜像");
    expect((job.input.canvas as { mirror?: boolean }).mirror).toBe(true);
    expect(painter.painterInput(job).mirror_refs).toEqual([1]);
    /* an older painter would draw it unflipped: it leaves the job */
    const old = await painter.claim({ painterId: "old-cpu", name: "old", want: 4, info: { backends: ["codex"], ops: ["paint", "crop", "extract"] } });
    expect(old.jobs.some((j) => j.jobId === job.id)).toBe(false);
    const fresh = await painter.claim({ painterId: "new-cpu", name: "new", want: 4, info: { backends: ["codex"], ops: ["paint", "crop", "extract"], features: ["mirror_refs"] } });
    expect(fresh.jobs.find((j) => j.jobId === job.id)?.input.mirror_refs).toEqual([1]);
  });
});

describe("MiniMax H3 Image: the open weights on the GPU pod", () => {
  const H3I = findModel("minimax-h3-image") as ModelEntry;
  let projectId = "";

  it("is a pod model on its distilled chain, self-hosted, with the licence's limits said", () => {
    expect(H3I).toMatchObject({ kind: "image", runtime: "pod", backend: "comfy:minimax-h3-image", workflows: ["H3_IMAGE"], family: "minimax-h3-image", maxRefs: 10, refStyle: "h3", moderation: "none" });
    /* 6 steps without guidance (the model card); drawn at 4 MP whatever size is asked */
    expect(resolveParams(H3I).params).toEqual({ steps: 6, cfg: 1, sampler: "euler", scheduler: "simple", resolution: 2048 });
    expect(defaultImageParams(H3I)).toEqual(resolveParams(H3I).params);
    expect(describeParams(H3I.params)).toBe("6 steps · euler/simple · CFG 1");
    /* not an open-source licence: excluded territories and a revenue / hosting threshold */
    expect(H3I.commercial).toBe("ask");
    expect(H3I.license).toMatch(/EU.*UK.*South Korea.*US/);
    expect(H3I.license).toMatch(/1M USD/);
    /* open weights from HuggingFace, no API: the text encoder is the file the video graphs load */
    expect(H3I.files!.every((f) => f.url.startsWith("https://huggingface.co/Comfy-Org/"))).toBe(true);
    const pod = readFileSync(join(__dirname, "../workers/h3-runpod/models.txt"), "utf8");
    expect(pod).toContain(H3I.files!.find((f) => f.dir === "text_encoders")!.url);
    /* the director may draw with it (Settings → Director) */
    expect(AGENT_IMAGE_MODELS.map((m) => m.id)).toContain("minimax-h3-image");
  });

  it("names its pictures <Picture N>, in the director's prompts and in Canvas recipes", () => {
    expect(namePicturesFor(H3I, "Picture 1 is Mia. Keep picture 2's coat; edit Picture 10.")).toBe("<Picture 1> is Mia. Keep <Picture 2>'s coat; edit <Picture 10>.");
    /* a prompt that already carries the token stays as it is */
    expect(namePicturesFor(H3I, "<Picture 1> wears the coat of Picture 2")).toBe("<Picture 1> wears the coat of <Picture 2>");
    const text = buildCanvasPrompt({ character: { name: "Lin" }, extras: [{ name: "red scarf" }], refStyle: "h3" });
    expect(text).toContain("<Picture 1>是Lin的角色参考");
    expect(text).toContain("融合<Picture 2>（red scarf）");
    expect(text).not.toMatch(/图\d/);
  });

  it("gets its Canvas recipe in English unless the user picks Chinese; the other models stay Chinese", () => {
    expect(canvasLangFor(H3I)).toBe("en");
    expect(canvasLangFor(H3I, "zh")).toBe("zh");
    for (const m of IMAGE_MODELS.filter((x) => x.id !== "minimax-h3-image")) expect(canvasLangFor(m)).toBe("zh");
    expect(canvasLangFor(QWEN, "en")).toBe("en");
  });

  it("is chosen for a project on the web and queues for the GPU pod with its settings", async () => {
    projectId = (await repo.createProject({ name: "H3 Image" })).id;
    await imaging.setImaging(projectId, { enabled: true, model: "minimax-h3-image" }, web);
    const summary = imaging.imagingSummary(await repo.getProject(projectId));
    expect(summary).toMatchObject({ enabled: true, model: "minimax-h3-image", modelLabel: "MiniMax H3 Image", runtime: "pod", backend: "comfy:minimax-h3-image", maxRefs: 10 });
    expect((await imaging.imagingStatus(await repo.getProject(projectId))).settings).toBe("6 steps · euler/simple · CFG 1");
    /* Canvas, text to image: no picture, the project's model */
    const r = await composeCharacter(projectId, CanvasCompose.parse({ text: "a rooftop after rain, neon in the puddles", size: "1344x768", seed: 5 }), web);
    expect(r.model).toBe("minimax-h3-image");
    const job = await repo.getJob(r.job.id);
    expect(job.input).toMatchObject({ backend: "comfy:minimax-h3-image", size: "1344x768" });
    /* composed in English, the model's own language, and the recipe remembers it */
    expect(r.lang).toBe("en");
    expect(String(job.input.prompt)).toBe("a rooftop after rain, neon in the puddles\n- Style: Photorealistic commercial photography, an 85mm portrait lens, soft natural light, real skin texture and fabric detail, 8K clarity. Balanced proportions, consistent lighting.\nAnyone in the picture is an adult. There is no text, logo or watermark anywhere in the picture.");
    expect((job.input.canvas as { lang: string }).lang).toBe("en");
    expect(job.input.params).toMatchObject({ steps: 6, cfg: 1, sampler: "euler", scheduler: "simple", resolution: 2048, seed: 5 });
    expect((job.input.check as { review: boolean }).review).toBe(false);
    expect(painter.isPodBackend(job)).toBe(true);
    expect(r.runner).toContain("GPU pod");
  });

  it("composes the references in English with <Picture N>, or in Chinese when asked", async () => {
    const portrait = (await listReferences("portrait", false)).items[0]!;
    const costume = (await listReferences("costume", false)).items.find((x) => x.kind === "costume" && x.source === "gia")!;
    const recipe = { model: "minimax-h3-image", portrait: { id: portrait.id }, costume: { id: costume.id } };
    const en = await composeCharacter(projectId, CanvasCompose.parse(recipe), web);
    expect(en.lang).toBe("en");
    expect(en.prompt).toContain("From the 2 reference pictures provided, create one complete photograph of one real person:");
    expect(en.prompt).toContain("- Person: the person in <Picture 1>.");
    expect(en.prompt).toContain("dress the person in the complete outfit and accessories shown in <Picture 2>");
    expect(en.prompt).toContain("Everyone in the picture is an adult.");
    /* an English prompt carries no Chinese: the library's names are left to the pictures */
    expect(en.prompt).not.toMatch(/[\u3400-\u9fff]/);
    const zh = await composeCharacter(projectId, CanvasCompose.parse({ ...recipe, lang: "zh" }), web);
    expect(zh.lang).toBe("zh");
    expect(zh.prompt).toContain("<Picture 1>中的人物");
    expect(((await repo.getJob(zh.job.id)).input.canvas as { lang: string }).lang).toBe("zh");
    /* any model can be asked for English: GPT Image reads "Picture N", Qwen-Image 2.1 <imageN> */
    const gpt = await composeCharacter(projectId, CanvasCompose.parse({ ...recipe, model: "gpt-image-codex", lang: "en" }), web);
    expect(gpt.prompt).toContain("- Person: the person in Picture 1.");
    const qwen = await composeCharacter(projectId, CanvasCompose.parse({ ...recipe, model: "qwen-image-2.1-turbo", lang: "en" }), web);
    expect(qwen.prompt).toContain("shown in <image2>");
    /* left out, the others are composed in Chinese as before */
    const before = await composeCharacter(projectId, CanvasCompose.parse({ ...recipe, model: "qwen-image-2.1-turbo" }), web);
    expect(before.lang).toBe("zh");
    expect(before.prompt).toContain("<image1>中的人物");
  });

  it("delivers a Studio shape at 4, 9 or 16 MP: the same shape, on the 32-pixel grid", () => {
    /* workers/painter/test_comfy.py holds the same table: the painter's working_canvas lands on these sizes and keeps them */
    const table: Record<string, Record<string, string>> = {
      "4mp": { "1024x1536": "1664x2496", "1008x1344": "1824x2432", "1024x1024": "2048x2048", "1536x1024": "2496x1664", "1344x768": "2688x1536" },
      "9mp": { "1024x1536": "2496x3744", "1008x1344": "2688x3584", "1024x1024": "3072x3072", "1536x1024": "3744x2496", "1344x768": "4032x2304" },
      "16mp": { "1024x1536": "3328x4992", "1008x1344": "3552x4736", "1024x1024": "4096x4096", "1536x1024": "4992x3328", "1344x768": "5376x3072" },
    };
    expect(H3I.resolutions).toEqual([...CANVAS_RESOLUTIONS]);
    for (const res of CANVAS_RESOLUTIONS) {
      for (const shape of CANVAS_SIZES) {
        const out = canvasOutputSize(shape, res);
        expect(out).toBe(table[res]![shape]);
        const [w, h] = out.split("x").map(Number) as [number, number];
        const [sw, sh] = shape.split("x").map(Number) as [number, number];
        expect(w % 32).toBe(0);
        expect(h % 32).toBe(0);
        expect(w / h).toBeCloseTo(sw / sh, 9);
        /* at least 97% of the area asked for, within what the painter accepts from a pod model */
        expect(w * h).toBeGreaterThanOrEqual(0.97 * CANVAS_RESOLUTION_SIDE[res] ** 2);
        expect(Math.max(w, h)).toBeLessThanOrEqual(6400);
        expect(w * h).toBeLessThanOrEqual(21_000_000);
      }
    }
    /* no resolution: the Studio size itself */
    expect(canvasOutputSize("1344x768", undefined)).toBe("1344x768");
    /* the other models draw at the Studio's sizes only */
    expect(IMAGE_MODELS.filter((m) => m.resolutions?.length).map((m) => m.id)).toEqual(["minimax-h3-image"]);
  });

  it("queues a 16 MP picture at its own size, remembers the shape and the resolution, and refuses it on other models", async () => {
    const r = await composeCharacter(projectId, CanvasCompose.parse({ text: "a harbour at dawn, fishing boats", size: "1344x768", resolution: "16mp" }), web);
    expect(r.size).toBe("5376x3072");
    const job = await repo.getJob(r.job.id);
    expect(job.input.size).toBe("5376x3072");
    /* the floor stays the model's 4 MP: the size asked for is above it, so it is drawn as asked */
    expect(job.input.params).toMatchObject({ steps: 6, resolution: 2048 });
    expect(job.input.canvas).toMatchObject({ size: "1344x768", resolution: "16mp" });
    const four = await composeCharacter(projectId, CanvasCompose.parse({ text: "a harbour at dawn, fishing boats", resolution: "4mp" }), web);
    expect(four.size).toBe("1664x2496");
    /* left out: the Studio size, drawn at 4 MP by the painter and resized */
    const std = await composeCharacter(projectId, CanvasCompose.parse({ text: "a harbour at dawn, fishing boats", size: "1344x768" }), web);
    expect(std.size).toBe("1344x768");
    expect((await repo.getJob(std.job.id)).input.canvas).not.toHaveProperty("resolution");
    for (const model of ["gpt-image-codex", "qwen-image-2.1-turbo"]) {
      await expect(composeCharacter(projectId, CanvasCompose.parse({ text: "a harbour at dawn, fishing boats", model, resolution: "9mp" }), web)).rejects.toThrow(/Studio's sizes only.*MiniMax H3 Image for a 9 MP picture/);
    }
  });

  it("edits a large picture at its own size with H3 Image, and within 4096 px with a model that draws small", () => {
    expect(editSizeFor(H3I, 5376, 3072)).toEqual({ size: "5376x3072", reduced: false });
    expect(editSizeFor(QWEN, 5376, 3072)).toEqual({ size: "4096x2340", reduced: true });
    expect(editSizeFor(findModel("gpt-image-codex")!, 3328, 4992)).toEqual({ size: "2730x4096", reduced: true });
    expect(editSizeFor(QWEN, 1344, 768)).toEqual({ size: "1344x768", reduced: false });
  });

  it("only the pod's painter that has the model claims it", async () => {
    const cpu = await painter.claim({ painterId: "h3i-cpu", name: "cpu", want: 4, info: { backends: ["codex", "api"], ops: ["paint", "crop", "extract"] } });
    expect(cpu.jobs.some((j) => j.input.backend === "comfy:minimax-h3-image")).toBe(false);
    const qwenOnly = await painter.claim({ painterId: "h3i-pod-old", name: "gpu-pod", want: 4, info: { onPod: true, backends: ["codex", "comfy:qwen-image-2.1-turbo"], ops: ["paint", "crop", "extract"] } });
    expect(qwenOnly.jobs.some((j) => j.input.backend === "comfy:minimax-h3-image")).toBe(false);
    expect((await painter.runnerSummary("paint", "comfy:minimax-h3-image")).note).toMatch(/cannot draw minimax-h3-image yet/);
    const pod = await painter.claim({ painterId: "h3i-pod", name: "gpu-pod", want: 4, info: { onPod: true, backends: ["codex", "comfy:minimax-h3-image"], ops: ["paint", "crop", "extract"] } });
    const mine = pod.jobs.filter((j) => j.input.backend === "comfy:minimax-h3-image");
    expect(mine.find((j) => j.input.size === "1344x768")?.input).toMatchObject({ refs: [], params: { steps: 6, resolution: 2048 } });
    /* the 16 MP job reaches the painter at its own size */
    expect(mine.map((j) => j.input.size)).toContain("5376x3072");
  });
});
