import { getDb, type Db, type SqlValue } from "@/db";

import { newId } from "./ids";
import { notFound } from "./errors";
import { DEFAULT_LOOK, LookSettings, ShotInput, TimelineInput } from "./schemas";
import type {
  Approval, Asset, AssetKind, AssetSource, Element, ElementKind, ExportJob, ExportStatus, GpuTypeStats,
  Job, JobKind, JobStatus, Lora, LoraKind, Project, Review, Scene, Script, Shot, Take, TakeStatus, Timeline,
} from "./types";

/* Every table gets a row type, a mapper and a handful of narrow functions.
   No ORM: the SQL is small enough to read, and it runs unchanged on D1. */

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : String(v ?? ""));
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
const opt = <T>(v: unknown, map: (x: unknown) => T): T | undefined => (v === null || v === undefined ? undefined : map(v));
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

async function db(): Promise<Db> {
  return getDb();
}

/* ---------- projects ---------- */

function mapProject(r: Row): Project {
  return {
    id: str(r.id),
    name: str(r.name),
    look: LookSettings.catch(DEFAULT_LOOK).parse(json(r.look_json, {})),
    budgetCapUsd: num(r.budget_cap_usd),
    spentUsd: num(r.spent_usd),
    brief: str(r.brief ?? ""),
    targetSeconds: opt(r.target_seconds, num),
    shotlistApproval: str(r.shotlist_approval) as Approval,
    shotlistApprovedAt: opt(r.shotlist_approved_at, num),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

export async function listProjects(): Promise<Project[]> {
  const rows = await (await db()).all("SELECT * FROM projects ORDER BY updated_at DESC");
  return rows.map(mapProject);
}

export async function getProject(id: string): Promise<Project> {
  const row = await (await db()).get("SELECT * FROM projects WHERE id = ?", [id]);
  if (!row) throw notFound("project", id);
  return mapProject(row);
}

export async function createProject(input: { name: string; look?: Partial<LookSettings>; budgetCapUsd?: number; brief?: string; targetSeconds?: number }): Promise<Project> {
  const now = Date.now();
  const id = newId("prj");
  const look = LookSettings.parse({ ...DEFAULT_LOOK, ...(input.look ?? {}) });
  await (await db()).run(
    "INSERT INTO projects (id, name, look_json, budget_cap_usd, spent_usd, shotlist_approval, brief, target_seconds, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'draft', ?, ?, ?, ?)",
    [id, input.name, JSON.stringify(look), input.budgetCapUsd ?? 50, input.brief ?? "", input.targetSeconds ?? null, now, now],
  );
  return getProject(id);
}

export async function updateProject(id: string, patch: { name?: string; budgetCapUsd?: number; brief?: string; targetSeconds?: number | null }): Promise<Project> {
  const current = await getProject(id);
  await (await db()).run("UPDATE projects SET name = ?, budget_cap_usd = ?, brief = ?, target_seconds = ?, updated_at = ? WHERE id = ?", [
    patch.name ?? current.name,
    patch.budgetCapUsd ?? current.budgetCapUsd,
    patch.brief ?? current.brief,
    patch.targetSeconds === undefined ? (current.targetSeconds ?? null) : patch.targetSeconds,
    Date.now(),
    id,
  ]);
  return getProject(id);
}

export async function setProjectLook(id: string, patch: Partial<LookSettings>): Promise<Project> {
  const current = await getProject(id);
  const look = LookSettings.parse({ ...current.look, ...patch });
  await (await db()).run("UPDATE projects SET look_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(look), Date.now(), id]);
  return getProject(id);
}

export async function setShotlistApproval(id: string, approval: Approval): Promise<Project> {
  await (await db()).run("UPDATE projects SET shotlist_approval = ?, shotlist_approved_at = ?, updated_at = ? WHERE id = ?", [
    approval,
    approval === "approved" ? Date.now() : null,
    Date.now(),
    id,
  ]);
  return getProject(id);
}

export async function addSpent(id: string, usd: number): Promise<void> {
  await (await db()).run("UPDATE projects SET spent_usd = spent_usd + ?, updated_at = ? WHERE id = ?", [usd, Date.now(), id]);
}

export async function deleteProject(id: string): Promise<void> {
  await (await db()).run("DELETE FROM projects WHERE id = ?", [id]);
}

export async function touchProject(id: string): Promise<void> {
  await (await db()).run("UPDATE projects SET updated_at = ? WHERE id = ?", [Date.now(), id]);
}

/* ---------- scripts ---------- */

function mapScript(r: Row): Script {
  return {
    id: str(r.id), projectId: str(r.project_id), version: num(r.version), text: str(r.text),
    approval: str(r.approval) as Approval, approvedAt: opt(r.approved_at, num), createdAt: num(r.created_at),
  };
}

export async function listScripts(projectId: string): Promise<Script[]> {
  const rows = await (await db()).all("SELECT * FROM scripts WHERE project_id = ? ORDER BY version DESC", [projectId]);
  return rows.map(mapScript);
}

export async function latestScript(projectId: string): Promise<Script | undefined> {
  const row = await (await db()).get("SELECT * FROM scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1", [projectId]);
  return row ? mapScript(row) : undefined;
}

export async function getScript(id: string): Promise<Script> {
  const row = await (await db()).get("SELECT * FROM scripts WHERE id = ?", [id]);
  if (!row) throw notFound("script", id);
  return mapScript(row);
}

export async function createScript(projectId: string, text: string): Promise<Script> {
  const d = await db();
  const last = await d.get<{ v: number | null }>("SELECT MAX(version) v FROM scripts WHERE project_id = ?", [projectId]);
  const version = (last?.v ?? 0) + 1;
  const id = newId("scr");
  await d.run("INSERT INTO scripts (id, project_id, version, text, approval, created_at) VALUES (?, ?, ?, ?, 'draft', ?)", [
    id, projectId, version, text, Date.now(),
  ]);
  await touchProject(projectId);
  return getScript(id);
}

export async function approveScript(id: string): Promise<Script> {
  await (await db()).run("UPDATE scripts SET approval = 'approved', approved_at = ? WHERE id = ?", [Date.now(), id]);
  return getScript(id);
}

/* ---------- assets ---------- */

function mapAsset(r: Row): Asset {
  return {
    id: str(r.id), projectId: r.project_id === null || r.project_id === undefined ? null : str(r.project_id),
    url: str(r.url), kind: str(r.kind) as AssetKind, source: str(r.source) as AssetSource,
    width: opt(r.width, num), height: opt(r.height, num), durationS: opt(r.duration_s, num),
    meta: json(r.meta_json, {}), createdAt: num(r.created_at),
  };
}

export async function createAsset(input: {
  projectId: string | null; url: string; kind: AssetKind; source: AssetSource;
  width?: number; height?: number; durationS?: number; meta?: Record<string, unknown>;
}): Promise<Asset> {
  const id = newId("ast");
  await (await db()).run(
    "INSERT INTO assets (id, project_id, url, kind, source, width, height, duration_s, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.projectId, input.url, input.kind, input.source, input.width ?? null, input.height ?? null, input.durationS ?? null, JSON.stringify(input.meta ?? {}), Date.now()],
  );
  return getAsset(id);
}

export async function getAsset(id: string): Promise<Asset> {
  const row = await (await db()).get("SELECT * FROM assets WHERE id = ?", [id]);
  if (!row) throw notFound("asset", id);
  return mapAsset(row);
}

export async function getAssets(ids: string[]): Promise<Map<string, Asset>> {
  const out = new Map<string, Asset>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(",");
  const rows = await (await db()).all(`SELECT * FROM assets WHERE id IN (${marks})`, ids);
  for (const row of rows) {
    const asset = mapAsset(row);
    out.set(asset.id, asset);
  }
  return out;
}

export async function listAssets(projectId: string, kind?: AssetKind): Promise<Asset[]> {
  const sql = kind
    ? "SELECT * FROM assets WHERE (project_id = ? OR project_id IS NULL) AND kind = ? ORDER BY created_at DESC"
    : "SELECT * FROM assets WHERE project_id = ? OR project_id IS NULL ORDER BY created_at DESC";
  const rows = await (await db()).all(sql, kind ? [projectId, kind] : [projectId]);
  return rows.map(mapAsset);
}

/* ---------- elements ---------- */

function mapElement(r: Row): Element {
  return {
    id: str(r.id), projectId: r.project_id === null || r.project_id === undefined ? null : str(r.project_id),
    kind: str(r.kind) as ElementKind, name: str(r.name), description: str(r.description),
    refAssetIds: json<string[]>(r.ref_asset_ids_json, []), voiceAssetId: opt(r.voice_asset_id, str),
    createdAt: num(r.created_at), updatedAt: num(r.updated_at),
  };
}

export async function listElements(projectId: string, includeLibrary = false): Promise<Element[]> {
  const sql = includeLibrary
    ? "SELECT * FROM elements WHERE project_id = ? OR project_id IS NULL ORDER BY kind, name"
    : "SELECT * FROM elements WHERE project_id = ? ORDER BY kind, name";
  const rows = await (await db()).all(sql, [projectId]);
  return rows.map(mapElement);
}

export async function listLibraryElements(): Promise<Element[]> {
  const rows = await (await db()).all("SELECT * FROM elements WHERE project_id IS NULL ORDER BY kind, name");
  return rows.map(mapElement);
}

export async function getElement(id: string): Promise<Element> {
  const row = await (await db()).get("SELECT * FROM elements WHERE id = ?", [id]);
  if (!row) throw notFound("element", id);
  return mapElement(row);
}

export async function getElements(ids: string[]): Promise<Map<string, Element>> {
  const out = new Map<string, Element>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(",");
  const rows = await (await db()).all(`SELECT * FROM elements WHERE id IN (${marks})`, ids);
  for (const row of rows) {
    const el = mapElement(row);
    out.set(el.id, el);
  }
  return out;
}

export async function createElement(projectId: string | null, input: { kind: ElementKind; name: string; description: string; refAssetIds?: string[] }): Promise<Element> {
  const id = newId("ele");
  const now = Date.now();
  await (await db()).run(
    "INSERT INTO elements (id, project_id, kind, name, description, ref_asset_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, projectId, input.kind, input.name, input.description, JSON.stringify(input.refAssetIds ?? []), now, now],
  );
  if (projectId) await touchProject(projectId);
  return getElement(id);
}

export async function updateElement(id: string, patch: Partial<{ kind: ElementKind; name: string; description: string; refAssetIds: string[]; voiceAssetId: string | null }>): Promise<Element> {
  const current = await getElement(id);
  await (await db()).run(
    "UPDATE elements SET kind = ?, name = ?, description = ?, ref_asset_ids_json = ?, voice_asset_id = ?, updated_at = ? WHERE id = ?",
    [
      patch.kind ?? current.kind, patch.name ?? current.name, patch.description ?? current.description,
      JSON.stringify(patch.refAssetIds ?? current.refAssetIds),
      patch.voiceAssetId === undefined ? (current.voiceAssetId ?? null) : patch.voiceAssetId,
      Date.now(), id,
    ],
  );
  return getElement(id);
}

export async function deleteElement(id: string): Promise<void> {
  await (await db()).run("DELETE FROM elements WHERE id = ?", [id]);
}

/** Copy an element (and its refs) into another scope: library (null) or a project. */
export async function copyElement(id: string, targetProjectId: string | null): Promise<Element> {
  const source = await getElement(id);
  return createElement(targetProjectId, { kind: source.kind, name: source.name, description: source.description, refAssetIds: source.refAssetIds });
}

/* ---------- scenes & shots ---------- */

function mapScene(r: Row): Scene {
  return {
    id: str(r.id), projectId: str(r.project_id), index: num(r.idx), slug: str(r.slug), summary: str(r.summary),
    locationElementId: opt(r.location_element_id, str), createdAt: num(r.created_at),
  };
}

function mapShot(r: Row): Shot {
  return {
    id: str(r.id), projectId: str(r.project_id), sceneId: str(r.scene_id), index: num(r.idx),
    spec: json(r.spec_json, {}) as ShotInput,
    heroAssetId: opt(r.hero_asset_id, str), endAssetId: opt(r.end_asset_id, str),
    selectedTakeId: opt(r.selected_take_id, str), promptOverride: opt(r.prompt_override, str),
    createdAt: num(r.created_at), updatedAt: num(r.updated_at),
  };
}

export async function listScenes(projectId: string): Promise<Scene[]> {
  const rows = await (await db()).all("SELECT * FROM scenes WHERE project_id = ? ORDER BY idx", [projectId]);
  return rows.map(mapScene);
}

export async function getScene(id: string): Promise<Scene> {
  const row = await (await db()).get("SELECT * FROM scenes WHERE id = ?", [id]);
  if (!row) throw notFound("scene", id);
  return mapScene(row);
}

export async function createScene(projectId: string, input: { slug: string; summary?: string; location?: string; index?: number }): Promise<Scene> {
  const d = await db();
  const last = await d.get<{ i: number | null }>("SELECT MAX(idx) i FROM scenes WHERE project_id = ?", [projectId]);
  const id = newId("scn");
  await d.run("INSERT INTO scenes (id, project_id, idx, slug, summary, location_element_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    id, projectId, input.index ?? (last?.i ?? -1) + 1, input.slug, input.summary ?? "", input.location ?? null, Date.now(),
  ]);
  return getScene(id);
}

export async function updateScene(id: string, patch: Partial<{ slug: string; summary: string; location: string | null }>): Promise<Scene> {
  const current = await getScene(id);
  await (await db()).run("UPDATE scenes SET slug = ?, summary = ?, location_element_id = ? WHERE id = ?", [
    patch.slug ?? current.slug, patch.summary ?? current.summary,
    patch.location === undefined ? (current.locationElementId ?? null) : patch.location, id,
  ]);
  return getScene(id);
}

export async function deleteScene(id: string): Promise<void> {
  await (await db()).run("DELETE FROM scenes WHERE id = ?", [id]);
}

export async function listShots(projectId: string): Promise<Shot[]> {
  const rows = await (await db()).all(
    "SELECT s.* FROM shots s JOIN scenes c ON c.id = s.scene_id WHERE s.project_id = ? ORDER BY c.idx, s.idx",
    [projectId],
  );
  return rows.map(mapShot);
}

export async function listSceneShots(sceneId: string): Promise<Shot[]> {
  const rows = await (await db()).all("SELECT * FROM shots WHERE scene_id = ? ORDER BY idx", [sceneId]);
  return rows.map(mapShot);
}

export async function getShot(id: string): Promise<Shot> {
  const row = await (await db()).get("SELECT * FROM shots WHERE id = ?", [id]);
  if (!row) throw notFound("shot", id);
  return mapShot(row);
}

export async function createShot(projectId: string, sceneId: string, spec: ShotInput, index?: number): Promise<Shot> {
  const d = await db();
  const last = await d.get<{ i: number | null }>("SELECT MAX(idx) i FROM shots WHERE scene_id = ?", [sceneId]);
  const id = newId("sht");
  const now = Date.now();
  await d.run(
    "INSERT INTO shots (id, project_id, scene_id, idx, spec_json, prompt_override, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, projectId, sceneId, index ?? (last?.i ?? -1) + 1, JSON.stringify(spec), spec.promptOverride ?? null, now, now],
  );
  return getShot(id);
}

export async function updateShot(id: string, patch: Partial<{
  spec: ShotInput; heroAssetId: string | null; endAssetId: string | null; selectedTakeId: string | null; promptOverride: string | null;
}>): Promise<Shot> {
  const current = await getShot(id);
  const pick = <T>(next: T | null | undefined, cur: T | undefined): T | null => (next === undefined ? (cur ?? null) : next);
  await (await db()).run(
    "UPDATE shots SET spec_json = ?, hero_asset_id = ?, end_asset_id = ?, selected_take_id = ?, prompt_override = ?, updated_at = ? WHERE id = ?",
    [
      JSON.stringify(patch.spec ?? current.spec),
      pick(patch.heroAssetId, current.heroAssetId), pick(patch.endAssetId, current.endAssetId),
      pick(patch.selectedTakeId, current.selectedTakeId), pick(patch.promptOverride, current.promptOverride),
      Date.now(), id,
    ],
  );
  return getShot(id);
}

export async function deleteShot(id: string): Promise<void> {
  await (await db()).run("DELETE FROM shots WHERE id = ?", [id]);
}

export async function reorderShots(sceneId: string, shotIds: string[]): Promise<void> {
  const d = await db();
  for (const [i, id] of shotIds.entries()) {
    await d.run("UPDATE shots SET idx = ?, updated_at = ? WHERE id = ? AND scene_id = ?", [i, Date.now(), id, sceneId]);
  }
}

export type ShotlistMergeResult = { created: number; updated: number; deleted: number };

/** Merge a whole shotlist into the project without losing rendered work:
    scenes match by slug, shots by position inside their scene. Matched shots
    keep their takes, hero / end frames, selected take and prompt override.
    Scenes or shots that disappear are deleted only when nothing has been
    rendered for them; otherwise the caller gets the list and refuses. */
export async function mergeShotlist(
  projectId: string,
  scenes: Array<{ slug: string; summary: string; location?: string; shots: ShotInput[] }>,
): Promise<ShotlistMergeResult> {
  const existingScenes = await listScenes(projectId);
  const bySlug = new Map(existingScenes.map((s) => [s.slug, s]));
  const keepScenes = new Set<string>();
  const result: ShotlistMergeResult = { created: 0, updated: 0, deleted: 0 };
  const d = await db();

  for (const [si, incoming] of scenes.entries()) {
    let scene = bySlug.get(incoming.slug);
    if (scene) {
      await d.run("UPDATE scenes SET idx = ?, summary = ?, location_element_id = ? WHERE id = ?", [si, incoming.summary, incoming.location ?? null, scene.id]);
    } else {
      scene = await createScene(projectId, { slug: incoming.slug, summary: incoming.summary, location: incoming.location, index: si });
    }
    keepScenes.add(scene.id);
    const current = await listSceneShots(scene.id);
    for (const [i, spec] of incoming.shots.entries()) {
      const match = current[i];
      if (match) {
        await updateShot(match.id, { spec, promptOverride: spec.promptOverride ?? match.promptOverride ?? null });
        await d.run("UPDATE shots SET idx = ? WHERE id = ?", [i, match.id]);
        result.updated++;
      } else {
        await createShot(projectId, scene.id, spec, i);
        result.created++;
      }
    }
    for (const surplus of current.slice(incoming.shots.length)) {
      await deleteShot(surplus.id);
      result.deleted++;
    }
  }
  for (const scene of existingScenes) {
    if (keepScenes.has(scene.id)) continue;
    await deleteScene(scene.id);
    result.deleted++;
  }
  await touchProject(projectId);
  return result;
}

/** Shots that a merge would delete although they already have takes. */
export async function shotlistRemovals(
  projectId: string,
  scenes: Array<{ slug: string; shots: unknown[] }>,
): Promise<Array<{ shotId: string; scene: string; index: number; takes: number }>> {
  const existingScenes = await listScenes(projectId);
  const incoming = new Map(scenes.map((s) => [s.slug, s.shots.length]));
  const out: Array<{ shotId: string; scene: string; index: number; takes: number }> = [];
  for (const scene of existingScenes) {
    const keep = incoming.get(scene.slug) ?? 0;
    const shots = await listSceneShots(scene.id);
    for (const shot of shots) {
      if (shot.index < keep) continue;
      const takes = await listShotTakes(shot.id);
      if (takes.length) out.push({ shotId: shot.id, scene: scene.slug, index: shot.index, takes: takes.length });
    }
  }
  return out;
}

/* ---------- takes ---------- */

function mapTake(r: Row): Take {
  return {
    id: str(r.id), projectId: str(r.project_id), shotId: str(r.shot_id), n: num(r.n),
    backend: str(r.backend) as Take["backend"], workflow: str(r.workflow), prompt: str(r.prompt),
    input: json(r.input_json, {}), requestId: opt(r.request_id, str), status: str(r.status) as TakeStatus,
    resultUrl: opt(r.result_url, str), lastFrameUrl: opt(r.last_frame_url, str), thumbUrls: json<string[]>(r.thumb_urls_json, []),
    executionMs: opt(r.execution_ms, num), costUsd: opt(r.cost_usd, num), seed: opt(r.seed, num), error: opt(r.error, str),
    gpuTypeId: opt(r.gpu_type_id, str), gpuCostPerHr: opt(r.gpu_cost_per_hr, num), outputSeconds: opt(r.output_seconds, num),
    review: opt(r.review_json, (v) => json<Review | undefined>(v, undefined)),
    createdAt: num(r.created_at), finishedAt: opt(r.finished_at, num),
  };
}

export async function createTake(input: {
  projectId: string; shotId: string; backend: Take["backend"]; workflow: string; prompt: string; input: Record<string, unknown>; seed?: number;
}): Promise<Take> {
  const d = await db();
  const last = await d.get<{ n: number | null }>("SELECT MAX(n) n FROM takes WHERE shot_id = ?", [input.shotId]);
  const id = newId("tke");
  await d.run(
    "INSERT INTO takes (id, project_id, shot_id, n, backend, workflow, prompt, input_json, status, seed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
    [id, input.projectId, input.shotId, (last?.n ?? 0) + 1, input.backend, input.workflow, input.prompt, JSON.stringify(input.input), input.seed ?? null, Date.now()],
  );
  return getTake(id);
}

export async function getTake(id: string): Promise<Take> {
  const row = await (await db()).get("SELECT * FROM takes WHERE id = ?", [id]);
  if (!row) throw notFound("take", id);
  return mapTake(row);
}

export async function listShotTakes(shotId: string): Promise<Take[]> {
  const rows = await (await db()).all("SELECT * FROM takes WHERE shot_id = ? ORDER BY n DESC", [shotId]);
  return rows.map(mapTake);
}

export async function listProjectTakes(projectId: string): Promise<Take[]> {
  const rows = await (await db()).all("SELECT * FROM takes WHERE project_id = ? ORDER BY created_at DESC", [projectId]);
  return rows.map(mapTake);
}

export async function listActiveTakes(): Promise<Take[]> {
  const rows = await (await db()).all("SELECT * FROM takes WHERE status IN ('queued','running') ORDER BY created_at");
  return rows.map(mapTake);
}

export async function findTakeByRequest(requestId: string): Promise<Take | undefined> {
  const row = await (await db()).get("SELECT * FROM takes WHERE request_id = ?", [requestId]);
  return row ? mapTake(row) : undefined;
}

export async function updateTake(id: string, patch: Partial<{
  requestId: string; status: TakeStatus; resultUrl: string; lastFrameUrl: string; thumbUrls: string[];
  executionMs: number; costUsd: number; error: string | null; review: Review; finishedAt: number; input: Record<string, unknown>;
  gpuTypeId: string; gpuCostPerHr: number; outputSeconds: number;
}>): Promise<Take> {
  const cur = await getTake(id);
  const v = <T>(n: T | undefined, c: T | undefined): T | null => (n === undefined ? (c ?? null) : n);
  await (await db()).run(
    `UPDATE takes SET request_id = ?, status = ?, result_url = ?, last_frame_url = ?, thumb_urls_json = ?, execution_ms = ?, cost_usd = ?, error = ?, review_json = ?, finished_at = ?, input_json = ?, gpu_type_id = ?, gpu_cost_per_hr = ?, output_seconds = ? WHERE id = ?`,
    [
      v(patch.requestId, cur.requestId), patch.status ?? cur.status, v(patch.resultUrl, cur.resultUrl), v(patch.lastFrameUrl, cur.lastFrameUrl),
      JSON.stringify(patch.thumbUrls ?? cur.thumbUrls), v(patch.executionMs, cur.executionMs), v(patch.costUsd, cur.costUsd),
      patch.error === undefined ? (cur.error ?? null) : patch.error,
      patch.review ? JSON.stringify(patch.review) : (cur.review ? JSON.stringify(cur.review) : null),
      v(patch.finishedAt, cur.finishedAt), JSON.stringify(patch.input ?? cur.input),
      v(patch.gpuTypeId, cur.gpuTypeId), v(patch.gpuCostPerHr, cur.gpuCostPerHr), v(patch.outputSeconds, cur.outputSeconds), id,
    ],
  );
  return getTake(id);
}

/** Per GPU type: how much GPU time bought how many seconds of video, and
    what that cost at the price the pod was billed. */
export async function gpuTypeStats(): Promise<GpuTypeStats[]> {
  const rows = await (await db()).all(
    `SELECT gpu_type_id, COUNT(*) n, SUM(execution_ms) ms, SUM(output_seconds) secs, MAX(gpu_cost_per_hr) hr
     FROM takes WHERE status = 'completed' AND gpu_type_id IS NOT NULL AND execution_ms IS NOT NULL
     GROUP BY gpu_type_id ORDER BY n DESC`,
  );
  return rows.map((r) => {
    const genSeconds = num(r.ms) / 1000;
    const videoSeconds = num(r.secs);
    const speed = videoSeconds > 0 ? genSeconds / videoSeconds : 0;
    const usdPerHr = opt(r.hr, num);
    return {
      gpuTypeId: str(r.gpu_type_id), takes: num(r.n), genSeconds: Math.round(genSeconds), videoSeconds: Math.round(videoSeconds * 10) / 10,
      secondsPerOutputSecond: Math.round(speed * 100) / 100, usdPerHr,
      usdPerVideoSecond: usdPerHr !== undefined && speed > 0 ? Math.round((speed * usdPerHr) / 3600 * 10000) / 10000 : undefined,
    };
  });
}

/* ---------- loras ---------- */

function mapLora(r: Row): Lora {
  return {
    id: str(r.id), name: str(r.name), kind: str(r.kind) as LoraKind, filename: str(r.filename), hfUrl: opt(r.hf_url, str),
    triggerWords: str(r.trigger_words), defaultStrength: num(r.default_strength), stepsHint: opt(r.steps_hint, num),
    workflows: json<string[]>(r.workflows_json, []), notes: str(r.notes), createdAt: num(r.created_at), updatedAt: num(r.updated_at),
  };
}

export async function listLoras(): Promise<Lora[]> {
  const rows = await (await db()).all("SELECT * FROM loras ORDER BY kind, name");
  return rows.map(mapLora);
}

export async function getLora(id: string): Promise<Lora> {
  const row = await (await db()).get("SELECT * FROM loras WHERE id = ?", [id]);
  if (!row) throw notFound("lora", id);
  return mapLora(row);
}

export async function getLoras(ids: string[]): Promise<Map<string, Lora>> {
  const out = new Map<string, Lora>();
  if (ids.length === 0) return out;
  const rows = await (await db()).all(`SELECT * FROM loras WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  for (const row of rows) {
    const l = mapLora(row);
    out.set(l.id, l);
  }
  return out;
}

export async function createLora(input: { name: string; kind: LoraKind; filename: string; hfUrl?: string; triggerWords: string; defaultStrength: number; stepsHint?: number; workflows: string[]; notes: string }): Promise<Lora> {
  const id = newId("lora");
  const now = Date.now();
  await (await db()).run(
    "INSERT INTO loras (id, name, kind, filename, hf_url, trigger_words, default_strength, steps_hint, workflows_json, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.name, input.kind, input.filename, input.hfUrl ?? null, input.triggerWords, input.defaultStrength, input.stepsHint ?? null, JSON.stringify(input.workflows), input.notes, now, now],
  );
  return getLora(id);
}

export async function updateLora(id: string, patch: Partial<{ name: string; kind: LoraKind; filename: string; hfUrl: string | null; triggerWords: string; defaultStrength: number; stepsHint: number | null; workflows: string[]; notes: string }>): Promise<Lora> {
  const cur = await getLora(id);
  await (await db()).run(
    "UPDATE loras SET name = ?, kind = ?, filename = ?, hf_url = ?, trigger_words = ?, default_strength = ?, steps_hint = ?, workflows_json = ?, notes = ?, updated_at = ? WHERE id = ?",
    [
      patch.name ?? cur.name, patch.kind ?? cur.kind, patch.filename ?? cur.filename,
      patch.hfUrl === undefined ? (cur.hfUrl ?? null) : patch.hfUrl, patch.triggerWords ?? cur.triggerWords, patch.defaultStrength ?? cur.defaultStrength,
      patch.stepsHint === undefined ? (cur.stepsHint ?? null) : patch.stepsHint, JSON.stringify(patch.workflows ?? cur.workflows), patch.notes ?? cur.notes, Date.now(), id,
    ],
  );
  return getLora(id);
}

export async function deleteLora(id: string): Promise<void> {
  await (await db()).run("DELETE FROM loras WHERE id = ?", [id]);
}

/* ---------- timeline ---------- */

export async function getTimeline(projectId: string): Promise<Timeline> {
  const row = await (await db()).get("SELECT timeline_json FROM timelines WHERE project_id = ?", [projectId]);
  return TimelineInput.parse(row ? json(row.timeline_json, {}) : {});
}

export async function setTimeline(projectId: string, timeline: Timeline): Promise<Timeline> {
  await (await db()).run(
    "INSERT INTO timelines (project_id, timeline_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET timeline_json = excluded.timeline_json, updated_at = excluded.updated_at",
    [projectId, JSON.stringify(timeline), Date.now()],
  );
  await touchProject(projectId);
  return timeline;
}

/* ---------- exports ---------- */

function mapExport(r: Row): ExportJob {
  return {
    id: str(r.id), projectId: str(r.project_id), preset: str(r.preset), status: str(r.status) as ExportStatus,
    requestId: opt(r.request_id, str), input: json(r.input_json, {}), resultUrl: opt(r.result_url, str), srtUrl: opt(r.srt_url, str),
    error: opt(r.error, str), createdAt: num(r.created_at), finishedAt: opt(r.finished_at, num),
  };
}

export async function createExport(projectId: string, preset: string, input: Record<string, unknown>): Promise<ExportJob> {
  const id = newId("exp");
  await (await db()).run("INSERT INTO export_jobs (id, project_id, preset, status, input_json, created_at) VALUES (?, ?, ?, 'queued', ?, ?)", [
    id, projectId, preset, JSON.stringify(input), Date.now(),
  ]);
  return getExport(id);
}

export async function getExport(id: string): Promise<ExportJob> {
  const row = await (await db()).get("SELECT * FROM export_jobs WHERE id = ?", [id]);
  if (!row) throw notFound("export", id);
  return mapExport(row);
}

export async function listExports(projectId: string): Promise<ExportJob[]> {
  const rows = await (await db()).all("SELECT * FROM export_jobs WHERE project_id = ? ORDER BY created_at DESC", [projectId]);
  return rows.map(mapExport);
}

export async function listActiveExports(): Promise<ExportJob[]> {
  const rows = await (await db()).all("SELECT * FROM export_jobs WHERE status IN ('queued','running')");
  return rows.map(mapExport);
}

export async function updateExport(id: string, patch: Partial<{ requestId: string; status: ExportStatus; resultUrl: string; srtUrl: string; error: string | null; finishedAt: number }>): Promise<ExportJob> {
  const cur = await getExport(id);
  await (await db()).run("UPDATE export_jobs SET request_id = ?, status = ?, result_url = ?, srt_url = ?, error = ?, finished_at = ? WHERE id = ?", [
    patch.requestId ?? cur.requestId ?? null, patch.status ?? cur.status, patch.resultUrl ?? cur.resultUrl ?? null, patch.srtUrl ?? cur.srtUrl ?? null,
    patch.error === undefined ? (cur.error ?? null) : patch.error, patch.finishedAt ?? cur.finishedAt ?? null, id,
  ]);
  return getExport(id);
}

/* ---------- image jobs ---------- */

function mapJob(r: Row): Job {
  return {
    id: str(r.id), projectId: str(r.project_id), kind: str(r.kind) as JobKind, targetId: str(r.target_id), backend: str(r.backend),
    requestId: opt(r.request_id, str), status: str(r.status) as JobStatus, assetIds: json<string[]>(r.asset_ids_json, []),
    costUsd: opt(r.cost_usd, num), error: opt(r.error, str), createdAt: num(r.created_at), finishedAt: opt(r.finished_at, num),
  };
}

export async function createJob(input: { projectId: string; kind: JobKind; targetId: string; backend: string }): Promise<Job> {
  const id = newId("job");
  await (await db()).run("INSERT INTO jobs (id, project_id, kind, target_id, backend, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)", [
    id, input.projectId, input.kind, input.targetId, input.backend, Date.now(),
  ]);
  return getJob(id);
}

export async function getJob(id: string): Promise<Job> {
  const row = await (await db()).get("SELECT * FROM jobs WHERE id = ?", [id]);
  if (!row) throw notFound("job", id);
  return mapJob(row);
}

export async function listActiveJobs(): Promise<Job[]> {
  const rows = await (await db()).all("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at");
  return rows.map(mapJob);
}

export async function listTargetJobs(targetId: string): Promise<Job[]> {
  const rows = await (await db()).all("SELECT * FROM jobs WHERE target_id = ? ORDER BY created_at DESC", [targetId]);
  return rows.map(mapJob);
}

export async function updateJob(id: string, patch: Partial<{ requestId: string; status: JobStatus; assetIds: string[]; costUsd: number; error: string | null; finishedAt: number }>): Promise<Job> {
  const cur = await getJob(id);
  await (await db()).run("UPDATE jobs SET request_id = ?, status = ?, asset_ids_json = ?, cost_usd = ?, error = ?, finished_at = ? WHERE id = ?", [
    patch.requestId ?? cur.requestId ?? null, patch.status ?? cur.status, JSON.stringify(patch.assetIds ?? cur.assetIds),
    patch.costUsd ?? cur.costUsd ?? null, patch.error === undefined ? (cur.error ?? null) : patch.error, patch.finishedAt ?? cur.finishedAt ?? null, id,
  ]);
  return getJob(id);
}

/* ---------- eval ---------- */

export async function insertEvalVote(input: { projectId: string; takeA: string; takeB: string; winner: string; scores: Record<string, number>; voter: string }): Promise<void> {
  await (await db()).run("INSERT INTO eval_votes (id, project_id, take_a, take_b, winner, scores_json, voter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    newId("vot"), input.projectId, input.takeA, input.takeB, input.winner, JSON.stringify(input.scores), input.voter, Date.now(),
  ]);
}

export async function listEvalVotes(projectId: string): Promise<Array<{ takeA: string; takeB: string; winner: string; scores: Record<string, number>; createdAt: number }>> {
  const rows = await (await db()).all("SELECT * FROM eval_votes WHERE project_id = ? ORDER BY created_at", [projectId]);
  return rows.map((r) => ({ takeA: str(r.take_a), takeB: str(r.take_b), winner: str(r.winner), scores: json(r.scores_json, {}), createdAt: num(r.created_at) }));
}

/* ---------- oauth ---------- */

export type OAuthClient = { clientId: string; clientName: string; redirectUris: string[] };

export async function createOAuthClient(input: { clientName: string; redirectUris: string[] }): Promise<OAuthClient> {
  const clientId = newId("cli");
  await (await db()).run("INSERT INTO oauth_clients (client_id, client_name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?)", [
    clientId, input.clientName, JSON.stringify(input.redirectUris), Date.now(),
  ]);
  return { clientId, ...input };
}

export async function getOAuthClient(clientId: string): Promise<OAuthClient | undefined> {
  const row = await (await db()).get("SELECT * FROM oauth_clients WHERE client_id = ?", [clientId]);
  return row ? { clientId: str(row.client_id), clientName: str(row.client_name), redirectUris: json<string[]>(row.redirect_uris_json, []) } : undefined;
}

export async function saveOAuthCode(input: { code: string; clientId: string; redirectUri: string; codeChallenge: string; scope: string; user: string; expiresAt: number }): Promise<void> {
  await (await db()).run("INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, scope, user, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    input.code, input.clientId, input.redirectUri, input.codeChallenge, input.scope, input.user, input.expiresAt,
  ]);
}

export async function consumeOAuthCode(code: string): Promise<{ clientId: string; redirectUri: string; codeChallenge: string; scope: string; user: string; expiresAt: number } | undefined> {
  const d = await db();
  const row = await d.get("SELECT * FROM oauth_codes WHERE code = ?", [code]);
  if (!row) return undefined;
  await d.run("DELETE FROM oauth_codes WHERE code = ?", [code]);
  return { clientId: str(row.client_id), redirectUri: str(row.redirect_uri), codeChallenge: str(row.code_challenge), scope: str(row.scope), user: str(row.user), expiresAt: num(row.expires_at) };
}

export async function saveOAuthToken(input: { tokenHash: string; kind: "access" | "refresh"; clientId: string; user: string; scope: string; expiresAt: number }): Promise<void> {
  await (await db()).run("INSERT INTO oauth_tokens (token_hash, kind, client_id, user, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    input.tokenHash, input.kind, input.clientId, input.user, input.scope, input.expiresAt, Date.now(),
  ]);
}

export async function getOAuthToken(tokenHash: string): Promise<{ kind: string; clientId: string; user: string; scope: string; expiresAt: number } | undefined> {
  const row = await (await db()).get("SELECT * FROM oauth_tokens WHERE token_hash = ?", [tokenHash]);
  return row ? { kind: str(row.kind), clientId: str(row.client_id), user: str(row.user), scope: str(row.scope), expiresAt: num(row.expires_at) } : undefined;
}

export async function deleteOAuthToken(tokenHash: string): Promise<void> {
  await (await db()).run("DELETE FROM oauth_tokens WHERE token_hash = ?", [tokenHash]);
}

export async function deleteOAuthTokensFor(clientId: string, user: string, kind: "access" | "refresh"): Promise<void> {
  await (await db()).run("DELETE FROM oauth_tokens WHERE client_id = ? AND user = ? AND kind = ?", [clientId, user, kind]);
}

export async function listProjectActiveTakes(projectId: string): Promise<Take[]> {
  const rows = await (await db()).all("SELECT * FROM takes WHERE project_id = ? AND status IN ('queued','running')", [projectId]);
  return rows.map(mapTake);
}

/* ---------- gpu pods ---------- */

export type GpuPodStatus = "creating" | "starting" | "running" | "stopping" | "stopped" | "unavailable" | "terminated";

export type GpuPod = {
  id: string;
  name: string;
  image: string;
  gpuTypeId?: string;
  gpuName?: string;
  dataCenter?: string;
  status: GpuPodStatus;
  message?: string;
  costPerHr?: number;
  hostUrl?: string;
  createdAt: number;
  startedAt?: number;
  stoppedAt?: number;
  accumulatedSeconds: number;
  lastActivityAt?: number;
  updatedAt: number;
};

function mapGpuPod(r: Row): GpuPod {
  return {
    id: str(r.id), name: str(r.name), image: str(r.image), gpuTypeId: opt(r.gpu_type_id, str), gpuName: opt(r.gpu_name, str),
    dataCenter: opt(r.data_center, str), status: str(r.status) as GpuPodStatus, message: opt(r.message, str), costPerHr: opt(r.cost_per_hr, num),
    hostUrl: opt(r.host_url, str), createdAt: num(r.created_at), startedAt: opt(r.started_at, num), stoppedAt: opt(r.stopped_at, num),
    accumulatedSeconds: num(r.accumulated_seconds), lastActivityAt: opt(r.last_activity_at, num), updatedAt: num(r.updated_at),
  };
}

/** The pod the studio currently manages: newest row that is not terminated.
    An "unavailable" row counts only until the next attempt replaces it. */
export async function currentGpuPod(): Promise<GpuPod | undefined> {
  const row = await (await db()).get("SELECT * FROM gpu_pods WHERE status != 'terminated' ORDER BY created_at DESC LIMIT 1");
  return row ? mapGpuPod(row) : undefined;
}

export async function listGpuPods(limit = 20): Promise<GpuPod[]> {
  const rows = await (await db()).all("SELECT * FROM gpu_pods ORDER BY created_at DESC LIMIT ?", [limit]);
  return rows.map(mapGpuPod);
}

export async function insertGpuPod(input: { id: string; name: string; image: string; gpuTypeId?: string; gpuName?: string; dataCenter?: string; status: GpuPodStatus; message?: string; costPerHr?: number; hostUrl?: string }): Promise<GpuPod> {
  const now = Date.now();
  await (await db()).run(
    "INSERT INTO gpu_pods (id, name, image, gpu_type_id, gpu_name, data_center, status, message, cost_per_hr, host_url, created_at, accumulated_seconds, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
    [input.id, input.name, input.image, input.gpuTypeId ?? null, input.gpuName ?? null, input.dataCenter ?? null, input.status, input.message ?? null, input.costPerHr ?? null, input.hostUrl ?? null, now, now],
  );
  return (await getGpuPod(input.id))!;
}

export async function getGpuPod(id: string): Promise<GpuPod | undefined> {
  const row = await (await db()).get("SELECT * FROM gpu_pods WHERE id = ?", [id]);
  return row ? mapGpuPod(row) : undefined;
}

export async function updateGpuPod(id: string, patch: Partial<{
  status: GpuPodStatus; message: string | null; gpuTypeId: string; gpuName: string; dataCenter: string; costPerHr: number; hostUrl: string;
  startedAt: number | null; stoppedAt: number | null; accumulatedSeconds: number; lastActivityAt: number;
}>): Promise<GpuPod> {
  const cur = (await getGpuPod(id))!;
  const v = <T>(n: T | null | undefined, c: T | undefined): T | null => (n === undefined ? (c ?? null) : n);
  await (await db()).run(
    "UPDATE gpu_pods SET status = ?, message = ?, gpu_type_id = ?, gpu_name = ?, data_center = ?, cost_per_hr = ?, host_url = ?, started_at = ?, stopped_at = ?, accumulated_seconds = ?, last_activity_at = ?, updated_at = ? WHERE id = ?",
    [
      patch.status ?? cur.status, v(patch.message, cur.message), patch.gpuTypeId ?? cur.gpuTypeId ?? null, patch.gpuName ?? cur.gpuName ?? null,
      patch.dataCenter ?? cur.dataCenter ?? null, patch.costPerHr ?? cur.costPerHr ?? null, patch.hostUrl ?? cur.hostUrl ?? null,
      v(patch.startedAt, cur.startedAt), v(patch.stoppedAt, cur.stoppedAt), patch.accumulatedSeconds ?? cur.accumulatedSeconds,
      patch.lastActivityAt ?? cur.lastActivityAt ?? null, Date.now(), id,
    ],
  );
  return (await getGpuPod(id))!;
}

/** Back to the pending queue: no request id, no finish time. */
export async function resetTakeForRetry(id: string): Promise<Take> {
  await (await db()).run("UPDATE takes SET status = 'queued', request_id = NULL, finished_at = NULL, error = NULL WHERE id = ?", [id]);
  return getTake(id);
}

export async function setExportInput(id: string, input: Record<string, unknown>): Promise<ExportJob> {
  await (await db()).run("UPDATE export_jobs SET input_json = ? WHERE id = ?", [JSON.stringify(input), id]);
  return getExport(id);
}

export async function listPendingTakes(): Promise<Take[]> {
  const rows = await (await db()).all("SELECT * FROM takes WHERE status = 'queued' AND request_id IS NULL ORDER BY created_at");
  return rows.map(mapTake);
}

export async function listPendingExports(): Promise<ExportJob[]> {
  const rows = await (await db()).all("SELECT * FROM export_jobs WHERE status = 'queued' AND request_id IS NULL ORDER BY created_at");
  return rows.map(mapExport);
}

export type { SqlValue };
