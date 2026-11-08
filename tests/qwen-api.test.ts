import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { CanvasCompose, composeCharacter } from "@/studio/canvas";
import * as imaging from "@/studio/imaging";
import { findModel, type ModelEntry } from "@/studio/models";
import * as painter from "@/studio/painter";
import { painterPodEnv } from "@/studio/painter-pod";
import { listReferences } from "@/studio/references";
import * as repo from "@/studio/repo";
import { PainterInfo } from "@/studio/schemas";
import type { Actor } from "@/studio/types";

/* Qwen-Image 3.0 Pro through an API (TokenSail or DashScope): the pose
   gallery's 百炼 model, drawn by the CPU painter pod with the Worker's key —
   never the GPU pod. Its references are re-hosted in R2 for the job's length. */

const web: Actor = { user: "qwen-api@local", via: "web" };
const QWEN3 = findModel("qwen-image-3.0-pro") as ModelEntry;
const calls: Array<{ method: string; url: string }> = [];

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
  Object.assign(process.env, {
    STUDIO_PUBLIC_URL: "https://studio.example", PAINTER_TOKEN: "paint-token",
    R2_ACCOUNT_ID: "acct", R2_BUCKET: "studio", R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_PUBLIC_BASE_URL: "https://studio.example/media",
  });
  setDb(await memoryDb());
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push({ method: req.method, url: req.url });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  delete process.env.TOKENSAIL_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
});

const portrait = async () => (await listReferences("portrait", false)).items[3]!;
const pose = async () => (await listReferences("pose", false)).items[1]!;

describe("Qwen-Image 3.0 Pro through an API", () => {
  let projectId = "";

  it("is an API model on the CPU painter, three pictures, Alibaba's moderation", () => {
    expect(QWEN3).toMatchObject({ runtime: "api", backend: "qwen", apiModel: "qwen-image-3.0-pro", maxRefs: 3, refStyle: "zh", moderation: "alibaba" });
  });

  it("is refused while no key is set anywhere: the painter pod would start for nothing", async () => {
    projectId = (await repo.createProject({ name: "Qwen 3.0" })).id;
    await imaging.setImaging(projectId, { enabled: true }, web);
    await expect(composeCharacter(projectId, CanvasCompose.parse({ model: "qwen-image-3.0-pro", portrait: { id: (await portrait()).id } }), web)).rejects.toThrow(/TOKENSAIL_API_KEY/);
  });

  it("queues with the gallery's options once the Worker has the key, and the CPU pod gets the key", async () => {
    process.env.TOKENSAIL_API_KEY = "sk-tokensail-0000test";
    expect(painterPodEnv()).toMatchObject({ TOKENSAIL_API_KEY: "sk-tokensail-0000test", PAINTER_NAME: "painter-pod" });
    const r = await composeCharacter(projectId, CanvasCompose.parse({ model: "qwen-image-3.0-pro", portrait: { id: (await portrait()).id }, pose: { id: (await pose()).id }, negativePrompt: " 文字水印 ", startPod: true }), web);
    const job = await repo.getJob(r.job.id);
    expect(job.input.backend).toBe("qwen");
    expect(job.input.params).toEqual({ api_model: "qwen-image-3.0-pro", prompt_extend: false, negative_prompt: "文字水印" });
    expect(String(job.input.prompt)).toContain("图1");
    /* nothing on the GPU: no pod was asked for */
    expect(await repo.currentGpuPod().catch(() => undefined)).toBeFalsy();
    expect(r.painters.note).toMatch(/CPU painter pod/);
    await expect(composeCharacter(projectId, CanvasCompose.parse({ model: "qwen-image-3.0-pro", portrait: { id: (await portrait()).id }, pose: { id: (await pose()).id }, costume: { assetId: (await upload(projectId)).id }, extras: [{ assetId: (await upload(projectId)).id }] }), web)).rejects.toThrow(/at most 3/);
  });

  it("only a painter with the key claims it; it may put the references in R2, and they go when the job ends", async () => {
    process.env.TOKENSAIL_API_KEY = "sk-tokensail-0000test";
    const r = await composeCharacter(projectId, CanvasCompose.parse({ model: "qwen-image-3.0-pro", portrait: { id: (await portrait()).id }, promptExtend: true }), web);
    const codex = await painter.claim({ painterId: "codex-only", name: "codex", want: 4, info: { backends: ["codex"], ops: ["paint", "crop", "extract"], features: ["mirror_refs"] } });
    expect(codex.jobs.some((j) => j.jobId === r.job.id)).toBe(false);
    const cpu = await painter.claim({ painterId: "painter-pod-1", name: "painter-pod", want: 4, info: { backends: ["codex", "qwen"], ops: ["paint", "crop", "extract"], features: ["mirror_refs"] } });
    const got = cpu.jobs.find((j) => j.jobId === r.job.id)!;
    expect(got.input).toMatchObject({ backend: "qwen", params: { api_model: "qwen-image-3.0-pro", prompt_extend: true } });
    const stem = `projects/${projectId}/images/${r.job.id}`;
    const ups = await painter.uploadUrls(r.job.id, "painter-pod-1", [`${stem}.ref0.jpg`, `${stem}.png`]);
    expect(ups[0]!.publicUrl).toBe(`https://studio.example/media/${stem}.ref0.jpg`);
    /* the vendor fetches a signed R2 link (an hour), not /media behind Cloudflare Access; the picture itself gets none */
    const fetchUrl = new URL(ups[0]!.fetchUrl!);
    expect(fetchUrl.host).toBe("acct.r2.cloudflarestorage.com");
    expect(fetchUrl.pathname).toBe(`/studio/${stem}.ref0.jpg`);
    expect(fetchUrl.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(fetchUrl.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(ups[1]!.fetchUrl).toBeUndefined();
    await expect(painter.uploadUrls(r.job.id, "painter-pod-1", [`${stem}.ref9.jpg`])).rejects.toMatchObject({ code: "validation" });
    calls.length = 0;
    await painter.finish(r.job.id, "painter-pod-1", { error: "DashScope refused the picture" });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/").pop()).sort()).toEqual([0, 1, 2, 3].map((i) => `${r.job.id}.ref${i}.jpg`));
    expect((await repo.getJob(r.job.id)).status).toBe("failed");
  });
});

describe("the painter heartbeat (/api/painter/claim)", () => {
  /* what painter.py's info() sends: a CPU pod with a Qwen key, the GPU pod with its image models */
  const heartbeat = (backends: string[]) => ({
    version: "1", host: "abc123", backends, ops: ["paint", "crop", "extract"], features: ["mirror_refs"], slots: 2, running: [], onPod: false, instance: "i1",
    runpodPodId: "pod1", codex: { installed: true, logged_in: true },
  });

  it("accepts every backend a painter can report, and keeps its features", () => {
    for (const backends of [["codex", "qwen"], ["codex", "api", "comfy:qwen-image-2.1-turbo", "comfy:qwen-image-2.1", "comfy:qwen-image-edit-2509"]]) {
      const parsed = PainterInfo.parse(heartbeat(backends));
      expect(parsed.backends).toEqual(backends);
      expect(parsed.features).toEqual(["mirror_refs"]);
    }
  });

  it("still refuses a backend that is not one", () => {
    expect(PainterInfo.safeParse(heartbeat(["comfy:../../etc"])).success).toBe(false);
    expect(PainterInfo.safeParse(heartbeat(["midjourney"])).success).toBe(false);
  });
});

async function upload(projectId: string) {
  return repo.createAsset({ projectId, url: `https://studio.example/media/uploads/u/${Math.random().toString(36).slice(2)}.png`, kind: "image", source: "upload", meta: {}, name: "pic" });
}
