import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { CanvasCompose, composeCharacter } from "@/studio/canvas";
import * as imaging from "@/studio/imaging";
import { describeParams, findModel, IMAGE_MODELS, isGraphDefault, MODELS, QWEN21_TURBO_SIGMAS, resolveParams, type ModelEntry } from "@/studio/models";
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
