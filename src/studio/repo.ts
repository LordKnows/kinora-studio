import type { z } from "zod";
import { getDb, type Db, type SqlValue } from "@/db";

import { newId } from "./ids";
import { StudioError, notFound } from "./errors";
import { DEFAULT_LOOK, LookSettings, MAX_DETAILS, MAX_ELEMENT_REFS, ShotInput, TimelineInput, VoiceCardInput, VoiceState } from "./schemas";
import type {
  Approval, Asset, AssetKind, AssetSource, Element, ElementKind, ExportJob, ExportStatus, GpuTypeStats,
  Autopilot, Delegation, DirectorNote, Imaging, Job, JobKind, JobStatus, Lora, Painter, PainterPod, LoraKind, NoteKind, Project, ProjectVisibility, Review, ReviewFinding, ReviewStage, Scene, Script, Shot, StageReview,
  Take, TakeProgress, TakeStatus, TakeUpscale, Timeline, VoiceCard, VoiceJob, VoiceJobStatus, Voicing,
} from "./types";
import type { FixedFeature, LoraRef, RefView, ScenePalette, SceneSound } from "./schemas";
import { carryLookLoras, keepShotLoras } from "./shot-loras";
import { isAdultLora, loraParams, type InferenceParams } from "./models";
import { DROP_QWEN_LORA_SEED, DROP_QWEN_LORA_SQL } from "@/db/migrations/0023_drop_qwen_loras";

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
  const d = await getDb();
  lorasCarried ??= carryLookLorasToShots(d).catch((caught) => {
    lorasCarried = undefined;
    throw caught;
  });
  await lorasCarried;
  return d;
}

/* LoRAs moved from the Look to the shots (shot-loras.ts). A project whose
   Look still lists LoRAs is rewritten once, on first use of the database:
   each shot gets use turbo where a speed LoRA loaded and, as its assignment,
   the style / effect LoRAs that loaded on it; then the Look loses the list.
   Shot by shot it is idempotent (a moved shot carries useTurbo), so an
   isolate that stops halfway is finished by the next. */
let lorasCarried: Promise<void> | undefined;
/** The same move, run now (tests write an old project and call it). */
export async function carryLookLorasNow(): Promise<void> {
  await carryLookLorasToShots(await getDb());
}
async function carryLookLorasToShots(d: Db): Promise<void> {
  const projects = await d.all("SELECT id, look_json FROM projects WHERE instr(look_json, '\"loras\"') > 0");
  if (projects.length === 0) return;
  const kinds = new Map((await d.all("SELECT id, kind FROM loras")).map((r) => [str(r.id), str(r.kind)]));
  for (const p of projects) {
    const look = json<Record<string, unknown>>(p.look_json, {});
    const lookLoras = Array.isArray(look.loras) ? (look.loras as LoraRef[]) : [];
    for (const row of await d.all("SELECT id, spec_json FROM shots WHERE project_id = ?", [str(p.id)])) {
      const next = carryLookLoras(json<Record<string, unknown>>(row.spec_json, {}), lookLoras, (id) => kinds.get(id));
      if (next) await d.run("UPDATE shots SET spec_json = ? WHERE id = ?", [JSON.stringify(next), str(row.id)]);
    }
    delete look.loras;
    await d.run("UPDATE projects SET look_json = ? WHERE id = ?", [JSON.stringify(look), str(p.id)]);
  }
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
    autopilot: json<Autopilot | undefined>(r.autopilot_json, undefined),
    delegation: json<Delegation | undefined>(r.delegation_json, undefined),
    imaging: json<Imaging | undefined>(r.imaging_json, undefined),
    owner: opt(r.owner, str) || undefined,
    visibility: r.visibility === "private" ? "private" : "shared",
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

/* Migration 0020 adds owner and visibility; they are also added on first use,
   so a deploy works before it has been applied on D1 (a column that exists
   already answers "duplicate column", which is fine). */
let projectColumnsReady = false;
async function projectsDb(): Promise<Db> {
  const d = await db();
  if (!projectColumnsReady) {
    for (const sql of ["ALTER TABLE projects ADD COLUMN owner TEXT", "ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'"]) {
      try {
        await d.run(sql);
      } catch (caught) {
        if (!/duplicate column/i.test(caught instanceof Error ? caught.message : String(caught))) throw caught;
      }
    }
    projectColumnsReady = true;
  }
  return d;
}

/**
 * The projects a user sees: every shared one and their own private ones,
 * newest first. `null` is the Studio itself (the sweep, hooks): everything.
 */
export async function listProjects(viewer: string | null): Promise<Project[]> {
  const d = await projectsDb();
  const rows = viewer === null
    ? await d.all("SELECT * FROM projects ORDER BY updated_at DESC")
    : await d.all("SELECT * FROM projects WHERE visibility <> 'private' OR owner = ? ORDER BY updated_at DESC", [viewer]);
  return rows.map(mapProject);
}

/** Owner and visibility of these projects (missing ids are left out). */
export async function projectAccessRows(ids: string[]): Promise<Map<string, { owner?: string; visibility: ProjectVisibility }>> {
  const out = new Map<string, { owner?: string; visibility: ProjectVisibility }>();
  const d = await projectsDb();
  for (const part of chunks([...new Set(ids)], 90)) {
    const rows = await d.all(`SELECT id, owner, visibility FROM projects WHERE id IN (${part.map(() => "?").join(",")})`, part);
    for (const r of rows) out.set(str(r.id), { owner: opt(r.owner, str) || undefined, visibility: r.visibility === "private" ? "private" : "shared" });
  }
  return out;
}

/** Tables whose rows belong to a project, by the prefix of their ids (ids.ts). */
export const PROJECT_TABLE_OF_PREFIX = {
  scr: "scripts", ast: "assets", ele: "elements", scn: "scenes", sht: "shots", tke: "takes", exp: "export_jobs",
  job: "jobs", vc: "voice_cards", rev: "reviews", req: "director_notes", dec: "director_notes", vot: "eval_votes", trs: "trash",
  vjb: "voice_jobs",
} as const;

/** The project of each of these rows (null: a library row, in no project); unknown ids are left out. */
export async function projectIdsOf(table: (typeof PROJECT_TABLE_OF_PREFIX)[keyof typeof PROJECT_TABLE_OF_PREFIX], ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const d = await db();
  for (const part of chunks([...new Set(ids)], 90)) {
    let rows: Row[];
    try {
      rows = await d.all(`SELECT id, project_id FROM ${table} WHERE id IN (${part.map(() => "?").join(",")})`, part);
    } catch (caught) {
      /* a table created on first use (voice_cards) that no one has used yet holds no rows */
      if (/no such table/i.test(caught instanceof Error ? caught.message : String(caught))) continue;
      throw caught;
    }
    for (const r of rows) out.set(str(r.id), r.project_id === null || r.project_id === undefined || r.project_id === "" ? null : str(r.project_id));
  }
  return out;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* What is in a private project stays in it. A row of another scope (the
   library, another project) may not point at its pictures, audio or voice
   cards: the others who see that scope would see them, and could not open
   them (auth/scope.ts answers not_found). copyElement copies them instead. */

/** These rows that sit in a private project other than `scope` (null: the library). */
async function inOtherPrivateProject(table: "assets" | "voice_cards", ids: Array<string | null | undefined>, scope: string | null): Promise<Array<{ id: string; projectId: string }>> {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return [];
  const projectOf = await projectIdsOf(table, list);
  const elsewhere = [...projectOf].filter((e): e is [string, string] => !!e[1] && e[1] !== scope);
  if (!elsewhere.length) return [];
  const access = await projectAccessRows(elsewhere.map(([, p]) => p));
  return elsewhere.filter(([, p]) => access.get(p)?.visibility === "private").map(([id, projectId]) => ({ id, projectId }));
}

async function assertStaysPrivate(scope: string | null, refs: { assets?: Array<string | null | undefined>; voiceCards?: Array<string | null | undefined> }): Promise<void> {
  const where = scope ? "this project" : "the library";
  const asset = (await inOtherPrivateProject("assets", refs.assets ?? [], scope))[0];
  if (asset) throw new StudioError("validation", `${asset.id} is in a private project and stays there: import a copy into ${where} first (import_image with its URL)`);
  const card = (await inOtherPrivateProject("voice_cards", refs.voiceCards ?? [], scope))[0];
  if (card) throw new StudioError("validation", `voice card ${card.id} is in a private project and stays there: make a card in ${where} instead`);
}

/** Copies (new rows in `scope`, same files) of these assets, old id → new id. */
async function copyAssets(ids: Iterable<string>, scope: string | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(ids)) {
    const a = await getAsset(id);
    const copy = await createAsset({ projectId: scope, url: a.url, kind: a.kind, source: a.source, width: a.width, height: a.height, durationS: a.durationS, meta: { ...a.meta, copiedFrom: a.id }, name: a.name });
    out.set(id, copy.id);
  }
  return out;
}

/** Copies of the pictures and audio among `ids` that sit in a private project other than `scope`. */
async function copyPrivateAssets(ids: string[], scope: string | null): Promise<Map<string, string>> {
  return copyAssets((await inOtherPrivateProject("assets", ids, scope)).map((x) => x.id), scope);
}

const rekeyed = <V>(m: Record<string, V> | undefined, map: Map<string, string>) => (m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [map.get(k) ?? k, v])) : m);

/**
 * Before a project turns private: what other scopes (the library, other
 * projects) took from it while it was shared — pictures and audio an
 * element, a shot or a voice card points at, a voice card an element uses —
 * gets copies of its own there, so it goes on working for everyone else and
 * nothing outside points into the private project. Returns how many rows
 * were given copies.
 */
export async function detachFromProject(projectId: string): Promise<number> {
  const d = await voiceCardsDb();
  const elsewhere = "(x.project_id IS NULL OR x.project_id <> ?)";
  const ids = (rows: Row[]) => [...new Set(rows.map((r) => str(r.id)))];
  const inProject = async (list: Array<string | null | undefined>) =>
    [...(await projectIdsOf("assets", list.filter((x): x is string => !!x)))].filter(([, p]) => p === projectId).map(([id]) => id);
  let n = 0;

  /* elements elsewhere that use one of its voice cards: a card of their own */
  for (const id of ids(await d.all(`SELECT x.id AS id FROM elements x JOIN voice_cards v ON v.id = json_extract(x.meta_json, '$.voiceCardId') WHERE v.project_id = ? AND ${elsewhere}`, [projectId, projectId]))) {
    const el = await getElement(id);
    const card = await getVoiceCard(el.voiceCardId!);
    const audio = await copyAssets(await inProject(card.states.flatMap((st) => st.refAssetIds)), el.projectId);
    const states = card.states.map((st) => ({ ...st, refAssetIds: st.refAssetIds.map((a) => audio.get(a) ?? a) }));
    const copy = await createVoiceCard(el.projectId, { name: card.name, status: card.status, defaultState: card.defaultState, states, source: card.source, notes: card.notes });
    await updateElement(el.id, { voiceCardId: copy.id });
    n++;
  }
  /* elements elsewhere with its pictures among their references (or its audio as their voice) */
  const elementRows = [
    ...(await d.all(`SELECT DISTINCT x.id AS id FROM elements x, json_each(x.ref_asset_ids_json) j JOIN assets a ON a.id = j.value WHERE a.project_id = ? AND ${elsewhere}`, [projectId, projectId])),
    ...(await d.all(`SELECT x.id AS id FROM elements x JOIN assets a ON a.id = x.voice_asset_id WHERE a.project_id = ? AND ${elsewhere}`, [projectId, projectId])),
  ];
  for (const id of ids(elementRows)) {
    const el = await getElement(id);
    const map = await copyAssets(await inProject([...el.refAssetIds, el.voiceAssetId]), el.projectId);
    await updateElement(el.id, {
      refAssetIds: el.refAssetIds.map((a) => map.get(a) ?? a), refViews: rekeyed(el.refViews, map), refFeatures: rekeyed(el.refFeatures, map),
      ...(el.voiceAssetId && map.has(el.voiceAssetId) ? { voiceAssetId: map.get(el.voiceAssetId)! } : {}),
    });
    n++;
  }
  /* shots elsewhere framed on its pictures */
  for (const id of ids(await d.all("SELECT x.id AS id FROM shots x JOIN assets a ON a.id = x.hero_asset_id OR a.id = x.end_asset_id WHERE a.project_id = ? AND x.project_id <> ?", [projectId, projectId]))) {
    const shot = await getShot(id);
    const map = await copyAssets(await inProject([shot.heroAssetId, shot.endAssetId]), shot.projectId);
    await updateShot(id, {
      ...(shot.heroAssetId && map.has(shot.heroAssetId) ? { heroAssetId: map.get(shot.heroAssetId)! } : {}),
      ...(shot.endAssetId && map.has(shot.endAssetId) ? { endAssetId: map.get(shot.endAssetId)! } : {}),
    });
    n++;
  }
  /* voice cards elsewhere with its audio as a reference */
  for (const id of ids(await d.all(`SELECT DISTINCT x.id AS id FROM voice_cards x, json_tree(x.data_json) j JOIN assets a ON j.type = 'text' AND a.id = j.atom WHERE a.project_id = ? AND ${elsewhere}`, [projectId, projectId]))) {
    const card = await getVoiceCard(id);
    const map = await copyAssets(await inProject(card.states.flatMap((st) => st.refAssetIds)), card.projectId);
    await updateVoiceCard(id, { states: card.states.map((st) => ({ ...st, refAssetIds: st.refAssetIds.map((a) => map.get(a) ?? a) })) });
    n++;
  }
  return n;
}

/** Whether another asset row still uses this file (its picture or its preview). */
export async function assetFileInUse(url: string): Promise<boolean> {
  return !!(await (await db()).get("SELECT 1 AS used FROM assets WHERE url = ? OR instr(meta_json, ?) > 0 LIMIT 1", [url, JSON.stringify(url)]));
}

export async function getProject(id: string): Promise<Project> {
  const row = await (await db()).get("SELECT * FROM projects WHERE id = ?", [id]);
  if (!row) throw notFound("project", id);
  return mapProject(row);
}

export async function createProject(input: { name: string; look?: Partial<LookSettings>; budgetCapUsd?: number; brief?: string; targetSeconds?: number; owner?: string; visibility?: ProjectVisibility }): Promise<Project> {
  const now = Date.now();
  const id = newId("prj");
  /* LoRAs are not in the Look: each shot has use turbo (on by default) and the LoRAs the director assigns it (shot-loras.ts) */
  const look = LookSettings.parse({ ...DEFAULT_LOOK, ...(input.look ?? {}) });
  if (input.visibility === "private" && !input.owner) throw new Error("a private project needs an owner");
  await (await projectsDb()).run(
    "INSERT INTO projects (id, name, look_json, budget_cap_usd, spent_usd, shotlist_approval, brief, target_seconds, owner, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'draft', ?, ?, ?, ?, ?, ?)",
    [id, input.name, JSON.stringify(look), input.budgetCapUsd ?? 50, input.brief ?? "", input.targetSeconds ?? null, input.owner ?? null, input.visibility ?? "shared", now, now],
  );
  return getProject(id);
}

/** Shared or private, and who owns it (set when an ownerless project is claimed). Policy lives in auth/scope.ts. */
export async function setProjectVisibility(id: string, visibility: ProjectVisibility, owner: string): Promise<Project> {
  await (await projectsDb()).run("UPDATE projects SET visibility = ?, owner = ?, updated_at = ? WHERE id = ?", [visibility, owner, Date.now(), id]);
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

/** The spend envelope; only the web grants or revokes it (see orchestrator.grantAutopilot). */
export async function setAutopilot(id: string, autopilot: Autopilot | null): Promise<Project> {
  await (await db()).run("UPDATE projects SET autopilot_json = ?, updated_at = ? WHERE id = ?", [autopilot ? JSON.stringify(autopilot) : null, Date.now(), id]);
  return getProject(id);
}

/** Image generation state of a project (switch, model, quota, stop). */
export async function setImaging(id: string, imaging: Imaging | null): Promise<Project> {
  await (await db()).run("UPDATE projects SET imaging_json = ?, updated_at = ? WHERE id = ?", [imaging ? JSON.stringify(imaging) : null, Date.now(), id]);
  return getProject(id);
}

/** Count one finished picture against the quota, atomically. */
export async function bumpImagesUsed(id: string, n = 1): Promise<Project> {
  const p = await getProject(id);
  if (p.imaging) await setImaging(id, { ...p.imaging, usedImages: p.imaging.usedImages + Math.max(1, Math.round(n)) });
  return getProject(id);
}

/** Which checkpoints the director may pass; only the web writes it. */
export async function setDelegation(id: string, delegation: Delegation | null): Promise<Project> {
  await (await db()).run("UPDATE projects SET delegation_json = ?, updated_at = ? WHERE id = ?", [delegation ? JSON.stringify(delegation) : null, Date.now(), id]);
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

/** Back to draft (an overturned delegated approval). */
export async function unapproveScript(id: string): Promise<Script> {
  await (await db()).run("UPDATE scripts SET approval = 'draft', approved_at = NULL WHERE id = ?", [id]);
  return getScript(id);
}

/* ---------- assets ---------- */

function mapAsset(r: Row): Asset {
  return {
    id: str(r.id), projectId: r.project_id === null || r.project_id === undefined ? null : str(r.project_id),
    url: str(r.url), kind: str(r.kind) as AssetKind, source: str(r.source) as AssetSource,
    width: opt(r.width, num), height: opt(r.height, num), durationS: opt(r.duration_s, num),
    meta: json(r.meta_json, {}), createdAt: num(r.created_at),
    ...(r.seq !== null && r.seq !== undefined ? { seq: num(r.seq), handle: `IMG-${num(r.seq)}` } : {}),
    ...(typeof r.name === "string" && r.name ? { name: r.name } : {}),
  };
}

export const ASSET_NAME_MAX = 80;
const cleanName = (name?: string) => name?.replace(/\s+/g, " ").trim().slice(0, ASSET_NAME_MAX) || null;

/** A project's pictures are numbered (IMG-n) from a counter on the project
    that only goes up: taken and bumped in one statement, never reused. */
export async function createAsset(input: {
  projectId: string | null; url: string; kind: AssetKind; source: AssetSource;
  width?: number; height?: number; durationS?: number; meta?: Record<string, unknown>; name?: string;
}): Promise<Asset> {
  const id = newId("ast");
  const name = cleanName(input.name ?? (typeof input.meta?.label === "string" ? input.meta.label : undefined));
  let seq: number | null = null;
  if (input.kind === "image" && input.projectId) {
    const row = await (await db()).get("UPDATE projects SET picture_seq = picture_seq + 1 WHERE id = ? RETURNING picture_seq", [input.projectId]);
    seq = row ? num(row.picture_seq) : null;
  }
  await (await db()).run(
    "INSERT INTO assets (id, project_id, url, kind, source, width, height, duration_s, meta_json, created_at, name, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.projectId, input.url, input.kind, input.source, input.width ?? null, input.height ?? null, input.durationS ?? null, JSON.stringify(input.meta ?? {}), Date.now(), name, seq],
  );
  return getAsset(id);
}

export async function renameAsset(id: string, name: string): Promise<Asset> {
  await (await db()).run("UPDATE assets SET name = ? WHERE id = ?", [cleanName(name), id]);
  return getAsset(id);
}

/** An asset id, or a picture's handle in this project ("IMG-12", "img12", "#12", "12"). */
export async function resolveAssetRef(projectId: string, ref: string): Promise<string> {
  const m = /^(?:img[-_ ]?|#)?(\d{1,6})$/i.exec(ref.trim());
  if (!m) return ref;
  const row = await (await db()).get("SELECT id FROM assets WHERE project_id = ? AND kind = 'image' AND seq = ?", [projectId, Number(m[1])]);
  if (!row) throw notFound("picture", `IMG-${m[1]} in this project`);
  return str(row.id);
}

export async function deleteAssets(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const { changes } = await (await db()).run(`DELETE FROM assets WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  return changes;
}

export async function updateAssetMeta(id: string, meta: Record<string, unknown>): Promise<Asset> {
  await (await db()).run("UPDATE assets SET meta_json = ? WHERE id = ?", [JSON.stringify(meta), id]);
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
    ...elementMeta(r.meta_json),
    createdAt: num(r.created_at), updatedAt: num(r.updated_at),
  };
}

function elementMeta(v: unknown): { fixedFeatures: FixedFeature[]; refViews: Record<string, RefView>; refFeatures: Record<string, string>; voiceCardId?: string; voiceState?: string } {
  const m = json<{ fixedFeatures?: FixedFeature[]; refViews?: Record<string, RefView>; refFeatures?: Record<string, string>; voiceCardId?: unknown; voiceState?: unknown }>(v, {});
  return {
    fixedFeatures: Array.isArray(m.fixedFeatures) ? m.fixedFeatures : [],
    refViews: m.refViews && typeof m.refViews === "object" ? m.refViews : {},
    refFeatures: m.refFeatures && typeof m.refFeatures === "object" ? m.refFeatures : {},
    ...(typeof m.voiceCardId === "string" && m.voiceCardId ? { voiceCardId: m.voiceCardId } : {}),
    ...(typeof m.voiceState === "string" && m.voiceState ? { voiceState: m.voiceState } : {}),
  };
}

/** Fill in each element's voice from its card: the card's states, the element's default state. */
async function withVoices<T extends Element>(elements: T[]): Promise<T[]> {
  const ids = [...new Set(elements.map((e) => e.voiceCardId).filter((x): x is string => !!x))];
  if (!ids.length) return elements;
  const cards = await getVoiceCards(ids);
  for (const el of elements) {
    const card = el.voiceCardId ? cards.get(el.voiceCardId) : undefined;
    if (!card) continue;
    el.voice = { states: card.states, defaultState: el.voiceState ?? card.defaultState, ...(card.source ? { source: card.source } : {}) };
  }
  return elements;
}

function metaJson(m: { fixedFeatures?: FixedFeature[]; refViews?: Record<string, RefView>; refFeatures?: Record<string, string>; voiceCardId?: string | null; voiceState?: string | null }): string {
  return JSON.stringify({
    fixedFeatures: m.fixedFeatures ?? [], refViews: m.refViews ?? {},
    ...(m.refFeatures && Object.keys(m.refFeatures).length ? { refFeatures: m.refFeatures } : {}),
    ...(m.voiceCardId ? { voiceCardId: m.voiceCardId } : {}), ...(m.voiceState ? { voiceState: m.voiceState } : {}),
  });
}

export async function listElements(projectId: string, includeLibrary = false): Promise<Element[]> {
  const sql = includeLibrary
    ? "SELECT * FROM elements WHERE project_id = ? OR project_id IS NULL ORDER BY kind, name"
    : "SELECT * FROM elements WHERE project_id = ? ORDER BY kind, name";
  const rows = await (await db()).all(sql, [projectId]);
  return withVoices(rows.map(mapElement));
}

export async function listLibraryElements(): Promise<Element[]> {
  const rows = await (await db()).all("SELECT * FROM elements WHERE project_id IS NULL ORDER BY kind, name");
  return withVoices(rows.map(mapElement));
}

export async function getElement(id: string): Promise<Element> {
  const row = await (await db()).get("SELECT * FROM elements WHERE id = ?", [id]);
  if (!row) throw notFound("element", id);
  return (await withVoices([mapElement(row)]))[0]!;
}

export async function getElements(ids: string[]): Promise<Map<string, Element>> {
  const out = new Map<string, Element>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(",");
  const rows = await (await db()).all(`SELECT * FROM elements WHERE id IN (${marks})`, ids);
  for (const el of await withVoices(rows.map(mapElement))) out.set(el.id, el);
  return out;
}

export async function createElement(projectId: string | null, input: { kind: ElementKind; name: string; description: string; refAssetIds?: string[]; fixedFeatures?: FixedFeature[]; refViews?: Record<string, RefView>; refFeatures?: Record<string, string>; voiceCardId?: string; voiceState?: string }): Promise<Element> {
  if (input.voiceCardId) await getVoiceCard(input.voiceCardId);
  await assertStaysPrivate(projectId, { assets: input.refAssetIds, voiceCards: [input.voiceCardId] });
  const id = newId("ele");
  const now = Date.now();
  await (await db()).run(
    "INSERT INTO elements (id, project_id, kind, name, description, ref_asset_ids_json, meta_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, projectId, input.kind, input.name, input.description, JSON.stringify(input.refAssetIds ?? []), metaJson(input), now, now],
  );
  if (projectId) await touchProject(projectId);
  return getElement(id);
}

export async function updateElement(id: string, patch: Partial<{ kind: ElementKind; name: string; description: string; refAssetIds: string[]; voiceAssetId: string | null; fixedFeatures: FixedFeature[]; refViews: Record<string, RefView>; refFeatures: Record<string, string>; voiceCardId: string | null; voiceState: string | null }>): Promise<Element> {
  const current = await getElement(id);
  if (patch.voiceCardId) await getVoiceCard(patch.voiceCardId);
  await assertStaysPrivate(current.projectId, { assets: [...(patch.refAssetIds ?? []), patch.voiceAssetId], voiceCards: [patch.voiceCardId] });
  const refAssetIds = patch.refAssetIds ?? current.refAssetIds;
  /* Views follow the refs: a view for an asset that is no longer a ref is dropped. */
  const views = { ...(current.refViews ?? {}), ...(patch.refViews ?? {}) };
  const refViews = Object.fromEntries(Object.entries(views).filter(([a]) => refAssetIds.includes(a)));
  const refFeatures = Object.fromEntries(Object.entries({ ...(current.refFeatures ?? {}), ...(patch.refFeatures ?? {}) }).filter(([a]) => refAssetIds.includes(a) && refViews[a] === "detail"));
  await (await db()).run(
    "UPDATE elements SET kind = ?, name = ?, description = ?, ref_asset_ids_json = ?, voice_asset_id = ?, meta_json = ?, updated_at = ? WHERE id = ?",
    [
      patch.kind ?? current.kind, patch.name ?? current.name, patch.description ?? current.description,
      JSON.stringify(refAssetIds),
      patch.voiceAssetId === undefined ? (current.voiceAssetId ?? null) : patch.voiceAssetId,
      metaJson({
        fixedFeatures: patch.fixedFeatures ?? current.fixedFeatures, refViews, refFeatures,
        voiceCardId: patch.voiceCardId === undefined ? current.voiceCardId : patch.voiceCardId,
        voiceState: patch.voiceState === undefined ? current.voiceState : patch.voiceState,
      }),
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
  /* out of a private project the copy gets pictures (and a voice card) of its own, in the new scope */
  const copied = await copyPrivateAssets(source.refAssetIds, targetProjectId);
  const re = (a: string) => copied.get(a) ?? a;
  const rekey = <V>(m?: Record<string, V>) => rekeyed(m, copied);
  let voiceCardId = source.voiceCardId;
  if (voiceCardId && (await inOtherPrivateProject("voice_cards", [voiceCardId], targetProjectId)).length) {
    const card = await getVoiceCard(voiceCardId);
    const audio = await copyPrivateAssets(card.states.flatMap((st) => st.refAssetIds), targetProjectId);
    const states = card.states.map((st) => ({ ...st, refAssetIds: st.refAssetIds.map((a) => audio.get(a) ?? a) }));
    voiceCardId = (await createVoiceCard(targetProjectId, { name: card.name, status: card.status, defaultState: card.defaultState, states, source: card.source, notes: card.notes })).id;
  }
  return createElement(targetProjectId, { kind: source.kind, name: source.name, description: source.description, refAssetIds: source.refAssetIds.map(re), fixedFeatures: source.fixedFeatures, refViews: rekey(source.refViews), refFeatures: rekey(source.refFeatures), voiceCardId, voiceState: source.voiceState });
}

/**
 * Put a picture among an element's references. A picture tagged with a view
 * takes the place of the one that held that view (a detail: the one of the
 * same fixed feature), so a redrawn view is the one that gets used; before,
 * the older picture stayed first and went on being picked. Over the limit the
 * untagged pictures go first, and the portrait last: it is the identity.
 */
export async function attachElementRef(id: string, assetId: string, tag: { view?: RefView; feature?: string } = {}): Promise<Element> {
  const el = await getElement(id);
  const views = { ...(el.refViews ?? {}) };
  const feats = { ...(el.refFeatures ?? {}) };
  const sameSlot = (a: string) => a !== assetId && !!tag.view && views[a] === tag.view && (tag.view !== "detail" || (feats[a] ?? "") === (tag.feature ?? ""));
  const replaced = el.refAssetIds.find(sameSlot);
  let ids = el.refAssetIds.filter((a) => a !== assetId);
  ids = replaced ? ids.map((a) => (a === replaced ? assetId : a)) : [...ids, assetId];
  if (tag.view) views[assetId] = tag.view;
  if (tag.view === "detail" && tag.feature) feats[assetId] = tag.feature;
  const drop = (pick: (a: string) => boolean) => {
    const out = ids.find((a) => a !== assetId && pick(a));
    if (out) ids = ids.filter((a) => a !== out);
    return !!out;
  };
  while (ids.filter((a) => views[a] === "detail").length > MAX_DETAILS && drop((a) => views[a] === "detail")) { /* the oldest detail goes */ }
  while (ids.length > MAX_ELEMENT_REFS && (drop((a) => !views[a]) || drop((a) => views[a] !== "face") || drop(() => true))) { /* untagged first, the portrait last */ }
  return updateElement(id, { refAssetIds: ids, refViews: views, refFeatures: feats });
}

/* ---------- voice cards ---------- */

/* Created on first use as well as by migrations 0019 and 0025 (one statement each: D1's exec splits on newlines). */
const VOICE_CARDS_SQL = [
  "CREATE TABLE IF NOT EXISTS voice_cards (id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', data_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS voice_cards_project ON voice_cards (project_id)",
  "CREATE TABLE IF NOT EXISTS voice_settings (project_id TEXT PRIMARY KEY, data_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  /* migration 0025 */
  "CREATE TABLE IF NOT EXISTS voice_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, shot_id TEXT, status TEXT NOT NULL, backend_job_id TEXT, data_json TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS voice_jobs_project ON voice_jobs (project_id, created_at)",
  "CREATE INDEX IF NOT EXISTS voice_jobs_status ON voice_jobs (status)",
];
let voiceCardsReady = false;

async function voiceCardsDb(): Promise<Db> {
  const d = await db();
  if (!voiceCardsReady) {
    for (const sql of VOICE_CARDS_SQL) await d.run(sql);
    voiceCardsReady = true;
  }
  return d;
}

function mapVoiceCard(r: Row): VoiceCard {
  const data = json<{ defaultState?: string; states?: VoiceCard["states"]; source?: VoiceCard["source"]; notes?: string }>(r.data_json, {});
  return {
    id: str(r.id), projectId: r.project_id === null || r.project_id === undefined ? null : str(r.project_id),
    name: str(r.name), status: (str(r.status) || "draft") as VoiceCard["status"],
    ...(data.defaultState ? { defaultState: data.defaultState } : {}), states: Array.isArray(data.states) ? data.states : [],
    ...(data.source ? { source: data.source } : {}), ...(data.notes ? { notes: data.notes } : {}),
    createdAt: num(r.created_at), updatedAt: num(r.updated_at),
  };
}

function voiceCardData(c: { defaultState?: string; states: VoiceCard["states"]; source?: VoiceCard["source"]; notes?: string }): string {
  return JSON.stringify({ ...(c.defaultState ? { defaultState: c.defaultState } : {}), states: c.states, ...(c.source ? { source: c.source } : {}), ...(c.notes ? { notes: c.notes } : {}) });
}

function checkStates(c: { defaultState?: string; states: VoiceCard["states"] }): void {
  const ids = c.states.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new Error(`voice card states need distinct ids (${ids.join(", ")})`);
  if (c.defaultState && !ids.includes(c.defaultState)) throw new Error(`defaultState "${c.defaultState}" is not one of the card's states (${ids.join(", ")})`);
}

export async function createVoiceCard(projectId: string | null, raw: z.input<typeof VoiceCardInput>): Promise<VoiceCard> {
  const input = VoiceCardInput.parse(raw);
  checkStates(input);
  await assertStaysPrivate(projectId, { assets: input.states.flatMap((st) => st.refAssetIds) });
  const id = newId("vc");
  const now = Date.now();
  await (await voiceCardsDb()).run(
    "INSERT INTO voice_cards (id, project_id, name, status, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, projectId, input.name, input.status ?? "draft", voiceCardData(input), now, now],
  );
  return getVoiceCard(id);
}

export async function getVoiceCard(id: string): Promise<VoiceCard> {
  const row = await (await voiceCardsDb()).get("SELECT * FROM voice_cards WHERE id = ?", [id]);
  if (!row) throw notFound("voice card", id);
  return mapVoiceCard(row);
}

export async function getVoiceCards(ids: string[]): Promise<Map<string, VoiceCard>> {
  const out = new Map<string, VoiceCard>();
  if (!ids.length) return out;
  const rows = await (await voiceCardsDb()).all(`SELECT * FROM voice_cards WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  for (const row of rows) {
    const card = mapVoiceCard(row);
    out.set(card.id, card);
  }
  return out;
}

/** A project's cards and, with includeLibrary, the global library; no project = the library alone. */
export async function listVoiceCards(projectId: string | null, includeLibrary = true): Promise<VoiceCard[]> {
  const d = await voiceCardsDb();
  const rows = projectId === null
    ? await d.all("SELECT * FROM voice_cards WHERE project_id IS NULL ORDER BY name")
    : await d.all(includeLibrary ? "SELECT * FROM voice_cards WHERE project_id = ? OR project_id IS NULL ORDER BY name" : "SELECT * FROM voice_cards WHERE project_id = ? ORDER BY name", [projectId]);
  return rows.map(mapVoiceCard);
}

export async function updateVoiceCard(id: string, patch: Partial<z.input<typeof VoiceCardInput>> & { projectId?: string | null }): Promise<VoiceCard> {
  const current = await getVoiceCard(id);
  const next = {
    defaultState: patch.defaultState ?? current.defaultState, states: patch.states ? patch.states.map((st) => VoiceState.parse(st)) : current.states,
    source: patch.source ?? current.source, notes: patch.notes ?? current.notes,
  };
  checkStates(next);
  const scope = patch.projectId === undefined ? current.projectId : patch.projectId;
  if (scope !== current.projectId && (await inOtherPrivateProject("voice_cards", [id], scope)).length) {
    throw new StudioError("validation", "this voice card is in a private project and stays there: make a card in the library or the other project instead");
  }
  await assertStaysPrivate(scope, { assets: next.states.flatMap((st) => st.refAssetIds) });
  await (await voiceCardsDb()).run(
    "UPDATE voice_cards SET project_id = ?, name = ?, status = ?, data_json = ?, updated_at = ? WHERE id = ?",
    [scope, patch.name ?? current.name, patch.status ?? current.status, voiceCardData(next), Date.now(), id],
  );
  return getVoiceCard(id);
}

/** A project's voice-API settings (the project's Settings page); undefined until the user sets them. */
export async function getVoicing(projectId: string): Promise<Voicing | undefined> {
  const row = await (await voiceCardsDb()).get("SELECT data_json FROM voice_settings WHERE project_id = ?", [projectId]);
  return row ? json<Voicing | undefined>(row.data_json, undefined) : undefined;
}

export async function setVoicingRow(projectId: string, v: Voicing): Promise<Voicing> {
  await (await voiceCardsDb()).run(
    "INSERT INTO voice_settings (project_id, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at",
    [projectId, JSON.stringify(v), Date.now()],
  );
  return v;
}

/** Every card that uses a voice-API voice id (to forget it once deleted). */
export async function voiceCardsWithApiVoice(voiceId: string): Promise<VoiceCard[]> {
  const rows = await (await voiceCardsDb()).all("SELECT * FROM voice_cards WHERE data_json LIKE ?", [`%"voiceId":"${voiceId}"%`]);
  return rows.map(mapVoiceCard);
}

/* ---------- voice jobs (voice-pod.ts) ---------- */

type VoiceJobData = Omit<VoiceJob, "id" | "projectId" | "status" | "shotId" | "backendJobId" | "createdBy" | "createdAt" | "updatedAt">;

function mapVoiceJob(r: Row): VoiceJob {
  const data = json<VoiceJobData>(r.data_json, {} as VoiceJobData);
  return {
    ...data, takes: Array.isArray(data.takes) ? data.takes : [], seeds: Array.isArray(data.seeds) ? data.seeds : [],
    id: str(r.id), projectId: str(r.project_id), status: str(r.status) as VoiceJobStatus,
    ...(r.shot_id ? { shotId: str(r.shot_id) } : {}), ...(r.backend_job_id ? { backendJobId: str(r.backend_job_id) } : {}),
    ...(r.created_by ? { createdBy: str(r.created_by) } : {}), createdAt: num(r.created_at), updatedAt: num(r.updated_at),
  };
}

function voiceJobData(j: VoiceJob): string {
  const { id: _i, projectId: _p, status: _s, shotId: _sh, backendJobId: _b, createdBy: _c, createdAt: _ca, updatedAt: _u, ...data } = j;
  return JSON.stringify(data);
}

export async function createVoiceJob(input: Omit<VoiceJob, "id" | "status" | "takes" | "createdAt" | "updatedAt">): Promise<VoiceJob> {
  const now = Date.now();
  const job: VoiceJob = { ...input, id: newId("vjb"), status: "queued", takes: [], createdAt: now, updatedAt: now };
  await (await voiceCardsDb()).run(
    "INSERT INTO voice_jobs (id, project_id, shot_id, status, backend_job_id, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [job.id, job.projectId, job.shotId ?? null, job.status, null, voiceJobData(job), job.createdBy ?? null, now, now],
  );
  return job;
}

export async function getVoiceJob(id: string): Promise<VoiceJob> {
  const row = await (await voiceCardsDb()).get("SELECT * FROM voice_jobs WHERE id = ?", [id]);
  if (!row) throw notFound("voice job", id);
  return mapVoiceJob(row);
}

export async function updateVoiceJob(id: string, patch: Partial<Omit<VoiceJob, "id" | "projectId" | "createdAt" | "updatedAt">>): Promise<VoiceJob> {
  const next = { ...(await getVoiceJob(id)), ...patch, updatedAt: Date.now() };
  await (await voiceCardsDb()).run(
    "UPDATE voice_jobs SET shot_id = ?, status = ?, backend_job_id = ?, data_json = ?, updated_at = ? WHERE id = ?",
    [next.shotId ?? null, next.status, next.backendJobId ?? null, voiceJobData(next), next.updatedAt, id],
  );
  return next;
}

/** A project's voice jobs, newest first; with shotId, those for that shot's lines. */
export async function listVoiceJobs(projectId: string, opts: { shotId?: string; limit?: number } = {}): Promise<VoiceJob[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = opts.shotId
    ? await (await voiceCardsDb()).all("SELECT * FROM voice_jobs WHERE project_id = ? AND shot_id = ? ORDER BY created_at DESC LIMIT ?", [projectId, opts.shotId, limit])
    : await (await voiceCardsDb()).all("SELECT * FROM voice_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", [projectId, limit]);
  return rows.map(mapVoiceJob);
}

/** Voice jobs still waiting on the pod, in every project (the sweep asks after them). */
export async function listActiveVoiceJobs(): Promise<VoiceJob[]> {
  const rows = await (await voiceCardsDb()).all("SELECT * FROM voice_jobs WHERE status IN ('queued', 'running') ORDER BY created_at LIMIT 100");
  return rows.map(mapVoiceJob);
}

/** Elements (in any project) that speak with this card. */
export async function elementsUsingVoiceCard(id: string): Promise<Element[]> {
  const rows = await (await db()).all("SELECT * FROM elements WHERE meta_json LIKE ?", [`%"voiceCardId":"${id}"%`]);
  return rows.map(mapElement).filter((e) => e.voiceCardId === id);
}

/* ---------- scenes & shots ---------- */

function mapScene(r: Row): Scene {
  return {
    id: str(r.id), projectId: str(r.project_id), index: num(r.idx), slug: str(r.slug), summary: str(r.summary),
    locationElementId: opt(r.location_element_id, str), palette: json<ScenePalette | undefined>(r.palette_json, undefined),
    ...(r.sound_json ? { sound: json<SceneSound | undefined>(r.sound_json, undefined) } : {}), createdAt: num(r.created_at),
  };
}

/* Migration 0022 adds scenes.sound_json; it is also added on first use, so a
   deploy works before it has been applied on D1 (a column that exists already
   answers "duplicate column"). Per database: tests swap it under one module. */
const sceneSoundReady = new WeakSet<object>();
async function scenesDb(): Promise<Db> {
  const d = await db();
  if (!sceneSoundReady.has(d)) {
    try {
      await d.run("ALTER TABLE scenes ADD COLUMN sound_json TEXT");
    } catch (caught) {
      if (!/duplicate column/i.test(caught instanceof Error ? caught.message : String(caught))) throw caught;
    }
    sceneSoundReady.add(d);
  }
  return d;
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

export async function createScene(projectId: string, input: { slug: string; summary?: string; location?: string; index?: number; palette?: ScenePalette; sound?: SceneSound }): Promise<Scene> {
  const d = await scenesDb();
  const last = await d.get<{ i: number | null }>("SELECT MAX(idx) i FROM scenes WHERE project_id = ?", [projectId]);
  const id = newId("scn");
  await d.run("INSERT INTO scenes (id, project_id, idx, slug, summary, location_element_id, palette_json, sound_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    id, projectId, input.index ?? (last?.i ?? -1) + 1, input.slug, input.summary ?? "", input.location ?? null, input.palette ? JSON.stringify(input.palette) : null, input.sound ? JSON.stringify(input.sound) : null, Date.now(),
  ]);
  return getScene(id);
}

export async function updateScene(id: string, patch: Partial<{ slug: string; summary: string; location: string | null; palette: ScenePalette | null; sound: SceneSound | null }>): Promise<Scene> {
  const current = await getScene(id);
  const palette = patch.palette === undefined ? current.palette : patch.palette;
  const sound = patch.sound === undefined ? current.sound : patch.sound;
  await (await scenesDb()).run("UPDATE scenes SET slug = ?, summary = ?, location_element_id = ?, palette_json = ?, sound_json = ? WHERE id = ?", [
    patch.slug ?? current.slug, patch.summary ?? current.summary,
    patch.location === undefined ? (current.locationElementId ?? null) : patch.location, palette ? JSON.stringify(palette) : null, sound ? JSON.stringify(sound) : null, id,
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
  await assertStaysPrivate(current.projectId, { assets: [patch.heroAssetId, patch.endAssetId] });
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
  scenes: Array<{ slug: string; summary: string; location?: string; palette?: ScenePalette; sound?: SceneSound; shots: ShotInput[] }>,
): Promise<ShotlistMergeResult> {
  const existingScenes = await listScenes(projectId);
  const bySlug = new Map(existingScenes.map((s) => [s.slug, s]));
  const keepScenes = new Set<string>();
  const result: ShotlistMergeResult = { created: 0, updated: 0, deleted: 0 };
  const d = await scenesDb();

  for (const [si, incoming] of scenes.entries()) {
    let scene = bySlug.get(incoming.slug);
    if (scene) {
      /* A palette or a sound row left out keeps the one already set (they are often set on the Board). */
      const palette = incoming.palette ?? scene.palette;
      const sound = incoming.sound ?? scene.sound;
      await d.run("UPDATE scenes SET idx = ?, summary = ?, location_element_id = ?, palette_json = ?, sound_json = ? WHERE id = ?", [si, incoming.summary, incoming.location ?? null, palette ? JSON.stringify(palette) : null, sound ? JSON.stringify(sound) : null, scene.id]);
    } else {
      scene = await createScene(projectId, { slug: incoming.slug, summary: incoming.summary, location: incoming.location, index: si, palette: incoming.palette, sound: incoming.sound });
    }
    keepScenes.add(scene.id);
    const current = await listSceneShots(scene.id);
    for (const [i, spec] of incoming.shots.entries()) {
      const match = current[i];
      if (match) {
        await updateShot(match.id, { spec: keepShotLoras(match.spec, spec), promptOverride: spec.promptOverride ?? match.promptOverride ?? null });
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
    progress: opt(r.progress_json, (v) => json<TakeProgress | undefined>(v, undefined)),
    upscale: opt(r.upscale_json, (v) => json<TakeUpscale | undefined>(v, undefined)),
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
  gpuTypeId: string; gpuCostPerHr: number; outputSeconds: number; progress: TakeProgress | null; upscale: TakeUpscale | null;
}>): Promise<Take> {
  const cur = await getTake(id);
  const v = <T>(n: T | undefined, c: T | undefined): T | null => (n === undefined ? (c ?? null) : n);
  await (await db()).run(
    `UPDATE takes SET request_id = ?, status = ?, result_url = ?, last_frame_url = ?, thumb_urls_json = ?, execution_ms = ?, cost_usd = ?, error = ?, review_json = ?, finished_at = ?, input_json = ?, gpu_type_id = ?, gpu_cost_per_hr = ?, output_seconds = ?, progress_json = ?, upscale_json = ? WHERE id = ?`,
    [
      v(patch.requestId, cur.requestId), patch.status ?? cur.status, v(patch.resultUrl, cur.resultUrl), v(patch.lastFrameUrl, cur.lastFrameUrl),
      JSON.stringify(patch.thumbUrls ?? cur.thumbUrls), v(patch.executionMs, cur.executionMs), v(patch.costUsd, cur.costUsd),
      patch.error === undefined ? (cur.error ?? null) : patch.error,
      patch.review ? JSON.stringify(patch.review) : (cur.review ? JSON.stringify(cur.review) : null),
      v(patch.finishedAt, cur.finishedAt), JSON.stringify(patch.input ?? cur.input),
      v(patch.gpuTypeId, cur.gpuTypeId), v(patch.gpuCostPerHr, cur.gpuCostPerHr), v(patch.outputSeconds, cur.outputSeconds),
      patch.progress === undefined ? (cur.progress ? JSON.stringify(cur.progress) : null) : patch.progress ? JSON.stringify(patch.progress) : null,
      patch.upscale === undefined ? (cur.upscale ? JSON.stringify(cur.upscale) : null) : patch.upscale ? JSON.stringify(patch.upscale) : null, id,
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
  const base = {
    id: str(r.id), name: str(r.name), kind: str(r.kind) as LoraKind, filename: str(r.filename), hfUrl: opt(r.hf_url, str),
    triggerWords: str(r.trigger_words), defaultStrength: num(r.default_strength), stepsHint: opt(r.steps_hint, num),
    workflows: json<string[]>(r.workflows_json, []), notes: str(r.notes), createdAt: num(r.created_at), updatedAt: num(r.updated_at),
    baseModel: typeof r.base_model === "string" && r.base_model ? r.base_model : "minimax-h3", params: json<InferenceParams>(r.params_json, {}),
  };
  return { ...base, recommended: loraParams(base), adult: isAdultLora(base) };
}

/* Migration 0016 adds two columns; they are also added on first use, so a
   deploy works before it has been applied on D1 (a column that exists
   already answers "duplicate column", which is fine). */
let loraColumnsReady = false;
async function loraDb(): Promise<Db> {
  const d = await db();
  if (!loraColumnsReady) {
    for (const sql of ["ALTER TABLE loras ADD COLUMN params_json TEXT NOT NULL DEFAULT '{}'", "ALTER TABLE loras ADD COLUMN base_model TEXT NOT NULL DEFAULT 'minimax-h3'"]) {
      try {
        await d.run(sql);
      } catch (caught) {
        if (!/duplicate column/i.test(caught instanceof Error ? caught.message : String(caught))) throw caught;
      }
    }
    /* the LoRA seeded for Qwen-Image 2.1 (0017) left with the model (0023): removed once per database */
    await d.run("CREATE TABLE IF NOT EXISTS studio_seeds (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    if (!(await d.get("SELECT name FROM studio_seeds WHERE name = ?", [DROP_QWEN_LORA_SEED]))) {
      await d.run(DROP_QWEN_LORA_SQL);
      await d.run("INSERT OR IGNORE INTO studio_seeds (name, applied_at) VALUES (?, ?)", [DROP_QWEN_LORA_SEED, Date.now()]);
    }
    loraColumnsReady = true;
  }
  return d;
}

export async function listLoras(): Promise<Lora[]> {
  const rows = await (await loraDb()).all("SELECT * FROM loras ORDER BY kind, name");
  return rows.map(mapLora);
}

export async function getLora(id: string): Promise<Lora> {
  const row = await (await loraDb()).get("SELECT * FROM loras WHERE id = ?", [id]);
  if (!row) throw notFound("lora", id);
  return mapLora(row);
}

export async function getLoras(ids: string[]): Promise<Map<string, Lora>> {
  const out = new Map<string, Lora>();
  if (ids.length === 0) return out;
  const rows = await (await loraDb()).all(`SELECT * FROM loras WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  for (const row of rows) {
    const l = mapLora(row);
    out.set(l.id, l);
  }
  return out;
}

export async function createLora(input: { name: string; kind: LoraKind; filename: string; hfUrl?: string; triggerWords: string; defaultStrength: number; stepsHint?: number; workflows: string[]; notes: string; baseModel?: string; params?: InferenceParams }): Promise<Lora> {
  const id = newId("lora");
  const now = Date.now();
  await (await loraDb()).run(
    "INSERT INTO loras (id, name, kind, filename, hf_url, trigger_words, default_strength, steps_hint, workflows_json, notes, base_model, params_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.name, input.kind, input.filename, input.hfUrl ?? null, input.triggerWords, input.defaultStrength, input.stepsHint ?? null, JSON.stringify(input.workflows), input.notes, input.baseModel ?? "minimax-h3", JSON.stringify(input.params ?? {}), now, now],
  );
  return getLora(id);
}

export async function updateLora(id: string, patch: Partial<{ name: string; kind: LoraKind; filename: string; hfUrl: string | null; triggerWords: string; defaultStrength: number; stepsHint: number | null; workflows: string[]; notes: string; baseModel: string; params: InferenceParams }>): Promise<Lora> {
  const cur = await getLora(id);
  await (await loraDb()).run(
    "UPDATE loras SET name = ?, kind = ?, filename = ?, hf_url = ?, trigger_words = ?, default_strength = ?, steps_hint = ?, workflows_json = ?, notes = ?, base_model = ?, params_json = ?, updated_at = ? WHERE id = ?",
    [
      patch.name ?? cur.name, patch.kind ?? cur.kind, patch.filename ?? cur.filename,
      patch.hfUrl === undefined ? (cur.hfUrl ?? null) : patch.hfUrl, patch.triggerWords ?? cur.triggerWords, patch.defaultStrength ?? cur.defaultStrength,
      patch.stepsHint === undefined ? (cur.stepsHint ?? null) : patch.stepsHint, JSON.stringify(patch.workflows ?? cur.workflows), patch.notes ?? cur.notes,
      patch.baseModel ?? cur.baseModel, JSON.stringify(patch.params ?? cur.params), Date.now(), id,
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
    costUsd: opt(r.cost_usd, num), error: opt(r.error, str), input: json<Record<string, unknown>>(r.input_json, {}),
    output: json<Record<string, unknown> | undefined>(r.output_json, undefined), createdAt: num(r.created_at), finishedAt: opt(r.finished_at, num),
    claimedAt: opt(r.claimed_at, num), attempts: opt(r.attempts, num),
  };
}

export async function createJob(input: { projectId: string; kind: JobKind; targetId: string; backend: string; input?: Record<string, unknown> }): Promise<Job> {
  const id = newId("job");
  await (await db()).run("INSERT INTO jobs (id, project_id, kind, target_id, backend, status, input_json, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)", [
    id, input.projectId, input.kind, input.targetId, input.backend, JSON.stringify(input.input ?? {}), Date.now(),
  ]);
  return getJob(id);
}

export async function listProjectJobs(projectId: string, limit = 100): Promise<Job[]> {
  const rows = await (await db()).all("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", [projectId, limit]);
  return rows.map(mapJob);
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

export async function updateJob(id: string, patch: Partial<{ requestId: string; status: JobStatus; assetIds: string[]; costUsd: number; error: string | null; finishedAt: number; output: Record<string, unknown> }>): Promise<Job> {
  const cur = await getJob(id);
  await (await db()).run("UPDATE jobs SET request_id = ?, status = ?, asset_ids_json = ?, cost_usd = ?, error = ?, finished_at = ?, output_json = ? WHERE id = ?", [
    patch.requestId ?? cur.requestId ?? null, patch.status ?? cur.status, JSON.stringify(patch.assetIds ?? cur.assetIds),
    patch.costUsd ?? cur.costUsd ?? null, patch.error === undefined ? (cur.error ?? null) : patch.error, patch.finishedAt ?? cur.finishedAt ?? null,
    patch.output ? JSON.stringify(patch.output) : cur.output ? JSON.stringify(cur.output) : null, id,
  ]);
  return getJob(id);
}

/** Hand a queued image job to a painter; false when someone else took it first. */
export async function claimJob(id: string, requestId: string): Promise<boolean> {
  const { changes } = await (await db()).run(
    "UPDATE jobs SET status = 'running', request_id = ?, claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued' AND request_id IS NULL",
    [requestId, Date.now(), id],
  );
  return changes === 1;
}

/** Hand a booked job to its painter again (the answer that carried it was lost); counted as a hand-over. */
export async function rehandJob(id: string): Promise<void> {
  await (await db()).run("UPDATE jobs SET claimed_at = ?, attempts = attempts + 1 WHERE id = ?", [Date.now(), id]);
}

/** Give a job back to the queue (its painter went away). Only if it still holds it. */
export async function releaseJob(id: string, requestId: string, note: string): Promise<boolean> {
  const { changes } = await (await db()).run("UPDATE jobs SET status = 'queued', request_id = NULL, claimed_at = NULL, error = ? WHERE id = ? AND status = 'running' AND request_id = ?", [note, id, requestId]);
  return changes === 1;
}

export async function listQueuedJobs(kind: JobKind, limit = 50): Promise<Job[]> {
  const rows = await (await db()).all("SELECT * FROM jobs WHERE kind = ? AND status = 'queued' AND request_id IS NULL ORDER BY created_at LIMIT ?", [kind, limit]);
  return rows.map(mapJob);
}

/* ---------- painters ---------- */

function mapPainter(r: Row): Painter {
  return {
    id: str(r.id), name: str(r.name), info: json<Painter["info"]>(r.info_json, {}), commands: json<Painter["commands"]>(r.commands_json, []),
    firstSeenAt: num(r.first_seen_at), lastSeenAt: num(r.last_seen_at),
  };
}

export async function upsertPainter(id: string, name: string, info: Painter["info"]): Promise<Painter> {
  const now = Date.now();
  await (await db()).run(
    `INSERT INTO painters (id, name, info_json, commands_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, '[]', ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, info_json = excluded.info_json, last_seen_at = excluded.last_seen_at`,
    [id, name, JSON.stringify(info), now, now],
  );
  return getPainter(id);
}

export async function getPainter(id: string): Promise<Painter> {
  const row = await (await db()).get("SELECT * FROM painters WHERE id = ?", [id]);
  if (!row) throw notFound("painter", id);
  return mapPainter(row);
}

export async function listPainters(): Promise<Painter[]> {
  const rows = await (await db()).all("SELECT * FROM painters ORDER BY last_seen_at DESC");
  return rows.map(mapPainter);
}

export async function setPainterCommands(id: string, commands: Painter["commands"]): Promise<void> {
  await (await db()).run("UPDATE painters SET commands_json = ? WHERE id = ?", [JSON.stringify(commands), id]);
}

/** The pod a painter ran in is gone: it is offline now, not in 90 s when its heartbeats stop counting. */
export async function markPaintersGone(runpodPodId: string): Promise<void> {
  await (await db()).run("UPDATE painters SET last_seen_at = 0 WHERE json_extract(info_json, '$.runpodPodId') = ?", [runpodPodId]);
}

export async function forgetPaintersBefore(ts: number): Promise<void> {
  await (await db()).run("DELETE FROM painters WHERE last_seen_at < ?", [ts]);
}

export async function deletePainter(id: string): Promise<void> {
  await (await db()).run("DELETE FROM painters WHERE id = ?", [id]);
}

/* ---------- the painter pod ---------- */

function mapPainterPod(r: Row): PainterPod {
  return {
    id: str(r.id), name: str(r.name), status: str(r.status) as PainterPod["status"], message: opt(r.message, str), costPerHr: opt(r.cost_per_hr, num),
    startedAt: opt(r.started_at, num), stoppedAt: opt(r.stopped_at, num), lastActivityAt: opt(r.last_activity_at, num),
    accumulatedSeconds: num(r.accumulated_seconds), createdAt: num(r.created_at),
  };
}

/** The Studio's painter pods are named so; rows with another name (an old take-over) are not touched. */
export const PAINTER_POD_NAME = "cinema-studio-painter";

/** The newest painter pod the Studio created (any state, also a failed attempt). */
export async function currentPainterPod(): Promise<PainterPod | undefined> {
  const row = await (await db()).get("SELECT * FROM painter_pods WHERE name LIKE ? ORDER BY created_at DESC LIMIT 1", [`${PAINTER_POD_NAME}%`]);
  return row ? mapPainterPod(row) : undefined;
}

export async function insertPainterPod(input: { id: string; name: string; status: PainterPod["status"]; message?: string; costPerHr?: number; startedAt?: number }): Promise<PainterPod> {
  await (await db()).run("INSERT INTO painter_pods (id, name, status, message, cost_per_hr, started_at, last_activity_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    input.id, input.name, input.status, input.message ?? null, input.costPerHr ?? null, input.startedAt ?? null, input.startedAt ?? null, Date.now(),
  ]);
  return (await currentPainterPod())!;
}

/** Painter pods created since `since` (newest first): which flavors failed to start lately. */
export async function listPainterPodsSince(since: number): Promise<PainterPod[]> {
  const rows = await (await db()).all("SELECT * FROM painter_pods WHERE name LIKE ? AND created_at >= ? ORDER BY created_at DESC", [`${PAINTER_POD_NAME}%`, since]);
  return rows.map(mapPainterPod);
}

/** What every painter pod so far has cost, in USD. */
export async function painterPodsUsd(): Promise<number> {
  const row = await (await db()).get("SELECT COALESCE(SUM(accumulated_seconds * COALESCE(cost_per_hr, 0)), 0) / 3600.0 AS usd FROM painter_pods WHERE name LIKE ?", [`${PAINTER_POD_NAME}%`]);
  return num(row?.usd);
}

export async function updatePainterPod(id: string, patch: Partial<{ status: PainterPod["status"]; message: string | null; costPerHr: number; startedAt: number | null; stoppedAt: number; lastActivityAt: number; accumulatedSeconds: number }>): Promise<void> {
  const cols: Record<string, string> = { status: "status", message: "message", costPerHr: "cost_per_hr", startedAt: "started_at", stoppedAt: "stopped_at", lastActivityAt: "last_activity_at", accumulatedSeconds: "accumulated_seconds" };
  const keys = Object.keys(patch).filter((k) => k in cols) as Array<keyof typeof patch>;
  if (!keys.length) return;
  await (await db()).run(`UPDATE painter_pods SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => (patch[k] ?? null) as SqlValue), id]);
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
  adopted: boolean;
  /** Stop the pod once nothing is left to render (a one-shot, cleared when the pod stops). */
  stopWhenDone: boolean;
  updatedAt: number;
};

function mapGpuPod(r: Row): GpuPod {
  return {
    id: str(r.id), name: str(r.name), image: str(r.image), gpuTypeId: opt(r.gpu_type_id, str), gpuName: opt(r.gpu_name, str),
    dataCenter: opt(r.data_center, str), status: str(r.status) as GpuPodStatus, message: opt(r.message, str), costPerHr: opt(r.cost_per_hr, num),
    hostUrl: opt(r.host_url, str), createdAt: num(r.created_at), startedAt: opt(r.started_at, num), stoppedAt: opt(r.stopped_at, num),
    accumulatedSeconds: num(r.accumulated_seconds), lastActivityAt: opt(r.last_activity_at, num), adopted: num(r.adopted) === 1, stopWhenDone: num(r.stop_when_done) === 1, updatedAt: num(r.updated_at),
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

export async function insertGpuPod(input: { id: string; name: string; image: string; gpuTypeId?: string; gpuName?: string; dataCenter?: string; status: GpuPodStatus; message?: string; costPerHr?: number; hostUrl?: string; adopted?: boolean }): Promise<GpuPod> {
  const now = Date.now();
  await (await db()).run(
    "INSERT OR REPLACE INTO gpu_pods (id, name, image, gpu_type_id, gpu_name, data_center, status, message, cost_per_hr, host_url, created_at, accumulated_seconds, adopted, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
    [input.id, input.name, input.image, input.gpuTypeId ?? null, input.gpuName ?? null, input.dataCenter ?? null, input.status, input.message ?? null, input.costPerHr ?? null, input.hostUrl ?? null, now, input.adopted ? 1 : 0, now],
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

export async function setGpuStopWhenDone(id: string, on: boolean): Promise<void> {
  const run = async () => (await db()).run("UPDATE gpu_pods SET stop_when_done = ?, updated_at = ? WHERE id = ?", [on ? 1 : 0, Date.now(), id]);
  try {
    await run();
  } catch (caught) {
    /* A deploy that has not had migration 0026 applied yet: add the column here (the same statement as the
       migration), once, and go on. The migration then finds it there and is the one to be marked done. */
    if (!/no such column: stop_when_done/i.test(caught instanceof Error ? caught.message : String(caught))) throw caught;
    await (await db()).run("ALTER TABLE gpu_pods ADD COLUMN stop_when_done INTEGER NOT NULL DEFAULT 0");
    await run();
  }
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

/** Takes whose 2K pass is queued or running (the sweep submits and refreshes them). */
export async function listActiveUpscales(): Promise<Take[]> {
  const rows = await (await db()).all("SELECT * FROM takes WHERE upscale_json IS NOT NULL AND (upscale_json LIKE '%\"status\":\"queued\"%' OR upscale_json LIKE '%\"status\":\"running\"%') ORDER BY created_at");
  return rows.map(mapTake).filter((t) => t.upscale && (t.upscale.status === "queued" || t.upscale.status === "running"));
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


/* ---------- stage reviews (cold reader) ---------- */

function mapReview(r: Row): StageReview {
  return {
    id: str(r.id), projectId: str(r.project_id), stage: str(r.stage) as ReviewStage, shotId: opt(r.shot_id, str),
    subjectHash: str(r.subject_hash), verdict: str(r.verdict) as StageReview["verdict"], reviewer: str(r.reviewer) as StageReview["reviewer"],
    basis: str(r.basis), findings: json<ReviewFinding[]>(r.findings_json, []), createdAt: num(r.created_at),
  };
}

export async function insertReview(input: Omit<StageReview, "id" | "createdAt">): Promise<StageReview> {
  const id = newId("rev");
  await (await db()).run(
    "INSERT INTO reviews (id, project_id, stage, shot_id, subject_hash, verdict, reviewer, basis, findings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.projectId, input.stage, input.shotId ?? null, input.subjectHash, input.verdict, input.reviewer, input.basis, JSON.stringify(input.findings), Date.now()],
  );
  const row = await (await db()).get("SELECT * FROM reviews WHERE id = ?", [id]);
  return mapReview(row!);
}

export async function listReviews(projectId: string, filter?: { stage?: ReviewStage; shotId?: string }): Promise<StageReview[]> {
  const where = ["project_id = ?"];
  const args: SqlValue[] = [projectId];
  if (filter?.stage) { where.push("stage = ?"); args.push(filter.stage); }
  if (filter?.shotId) { where.push("shot_id = ?"); args.push(filter.shotId); }
  const rows = await (await db()).all(`SELECT * FROM reviews WHERE ${where.join(" AND ")} ORDER BY created_at DESC`, args);
  return rows.map(mapReview);
}

/* ---------- requirements and decisions ---------- */

function mapNote(r: Row): DirectorNote {
  return {
    id: str(r.id), projectId: str(r.project_id), kind: str(r.kind) as NoteKind, status: str(r.status),
    body: json<Record<string, unknown>>(r.body_json, {}), createdAt: num(r.created_at), updatedAt: num(r.updated_at),
  };
}

export async function insertNote(projectId: string, kind: NoteKind, status: string, body: Record<string, unknown>): Promise<DirectorNote> {
  const id = newId(kind === "requirement" ? "req" : "dec");
  const now = Date.now();
  await (await db()).run("INSERT INTO director_notes (id, project_id, kind, status, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, projectId, kind, status, JSON.stringify(body), now, now]);
  return getNote(id);
}

export async function getNote(id: string): Promise<DirectorNote> {
  const row = await (await db()).get("SELECT * FROM director_notes WHERE id = ?", [id]);
  if (!row) throw notFound("note", id);
  return mapNote(row);
}

export async function updateNote(id: string, patch: { status?: string; body?: Record<string, unknown> }): Promise<DirectorNote> {
  const cur = await getNote(id);
  await (await db()).run("UPDATE director_notes SET status = ?, body_json = ?, updated_at = ? WHERE id = ?", [patch.status ?? cur.status, JSON.stringify({ ...cur.body, ...(patch.body ?? {}) }), Date.now(), id]);
  return getNote(id);
}

export async function listNotes(projectId: string, kind: NoteKind): Promise<DirectorNote[]> {
  const rows = await (await db()).all("SELECT * FROM director_notes WHERE project_id = ? AND kind = ? ORDER BY created_at", [projectId, kind]);
  return rows.map(mapNote);
}

/* ---------- per-user settings ---------- */

export type UserSettings = { adultContentAt?: number };

/* The table is created on first use as well as by migration 0015, so a deploy
   works before the migration has been applied on D1. One statement: D1's
   exec splits on newlines. */
const USER_SETTINGS_SQL = "CREATE TABLE IF NOT EXISTS user_settings (user TEXT PRIMARY KEY, settings_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)";
let settingsReady = false;

async function settingsDb(): Promise<Db> {
  const d = await db();
  if (!settingsReady) {
    await d.run(USER_SETTINGS_SQL);
    settingsReady = true;
  }
  return d;
}

export async function getUserSettings(user: string): Promise<UserSettings> {
  const row = await (await settingsDb()).get("SELECT settings_json FROM user_settings WHERE user = ?", [user]);
  const raw = json<Record<string, unknown>>(row?.settings_json, {});
  return typeof raw.adultContentAt === "number" ? { adultContentAt: raw.adultContentAt } : {};
}

/** Merge a patch into a user's settings; null clears a key. */
export async function setUserSettings(user: string, patch: { [K in keyof UserSettings]?: UserSettings[K] | null }): Promise<UserSettings> {
  const cur = await getUserSettings(user);
  const next: Record<string, unknown> = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  await (await settingsDb()).run(
    "INSERT INTO user_settings (user, settings_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at",
    [user, JSON.stringify(next), Date.now()],
  );
  return getUserSettings(user);
}

/* ---------- 我的: a user's own pictures in the Canvas library ---------- */

export type UserReference = {
  id: string;
  user: string;
  kind: "portrait" | "costume" | "pose";
  name: string;
  tags: string[];
  url: string;
  key: string;
  width?: number;
  height?: number;
  /** a pose: what its picture is (photo / mannequin / depth) */
  picture?: string;
  meta: Record<string, unknown>;
  createdAt: number;
};

/* Created on first use as well as by migration 0018 (one statement each: D1's exec splits on newlines). */
const USER_REFERENCES_SQL = [
  "CREATE TABLE IF NOT EXISTS user_references (id TEXT PRIMARY KEY, user TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]', url TEXT NOT NULL, key TEXT NOT NULL, width INTEGER, height INTEGER, picture TEXT, meta_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS user_references_user ON user_references (user, created_at)",
];
let userReferencesReady = false;

async function userReferencesDb(): Promise<Db> {
  const d = await db();
  if (!userReferencesReady) {
    for (const sql of USER_REFERENCES_SQL) await d.run(sql);
    userReferencesReady = true;
  }
  return d;
}

function mapUserReference(r: Record<string, unknown>): UserReference {
  return {
    id: String(r.id), user: String(r.user), kind: r.kind as UserReference["kind"], name: String(r.name), tags: json<string[]>(r.tags_json, []),
    url: String(r.url), key: String(r.key), ...(r.width != null ? { width: Number(r.width) } : {}), ...(r.height != null ? { height: Number(r.height) } : {}),
    ...(r.picture ? { picture: String(r.picture) } : {}), meta: json<Record<string, unknown>>(r.meta_json, {}), createdAt: Number(r.created_at),
  };
}

export async function listUserReferences(user: string): Promise<UserReference[]> {
  const rows = await (await userReferencesDb()).all<Record<string, unknown>>("SELECT * FROM user_references WHERE user = ? ORDER BY created_at DESC", [user]);
  return rows.map(mapUserReference);
}

export async function getUserReference(id: string): Promise<UserReference | undefined> {
  const row = await (await userReferencesDb()).get<Record<string, unknown>>("SELECT * FROM user_references WHERE id = ?", [id]);
  return row ? mapUserReference(row) : undefined;
}

export async function findUserReferenceByUrl(url: string): Promise<UserReference | undefined> {
  const row = await (await userReferencesDb()).get<Record<string, unknown>>("SELECT * FROM user_references WHERE url = ?", [url]);
  return row ? mapUserReference(row) : undefined;
}

export async function createUserReference(input: Omit<UserReference, "id" | "createdAt">): Promise<UserReference> {
  const id = newId("myref");
  await (await userReferencesDb()).run(
    "INSERT INTO user_references (id, user, kind, name, tags_json, url, key, width, height, picture, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.user, input.kind, input.name, JSON.stringify(input.tags), input.url, input.key, input.width ?? null, input.height ?? null, input.picture ?? null, JSON.stringify(input.meta), Date.now()],
  );
  return (await getUserReference(id))!;
}

export async function updateUserReference(id: string, patch: Partial<Pick<UserReference, "name" | "tags" | "picture" | "meta">>): Promise<UserReference> {
  const cur = await getUserReference(id);
  if (!cur) throw notFound("reference", id);
  const next = { ...cur, ...patch };
  await (await userReferencesDb()).run("UPDATE user_references SET name = ?, tags_json = ?, picture = ?, meta_json = ? WHERE id = ?", [next.name, JSON.stringify(next.tags), next.picture ?? null, JSON.stringify(next.meta), id]);
  return (await getUserReference(id))!;
}

export async function deleteUserReference(id: string): Promise<void> {
  await (await userReferencesDb()).run("DELETE FROM user_references WHERE id = ?", [id]);
}

/* ---------- styles of the users' own ---------- */

export type UserStyleRow = { slug: string; user: string; basedOn?: string; style: unknown; changes: unknown[]; createdAt: number; updatedAt: number };

/* Created on first use as well as by migration 0021 (one statement each: D1's exec splits on newlines). */
const USER_STYLES_SQL = [
  "CREATE TABLE IF NOT EXISTS user_styles (slug TEXT PRIMARY KEY, user TEXT NOT NULL, based_on TEXT, style_json TEXT NOT NULL, changes_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS user_styles_user ON user_styles (user, updated_at)",
];
/* Per database, not per isolate: tests swap the database under one module. */
const userStylesReady = new WeakSet<object>();

async function userStylesDb(): Promise<Db> {
  const d = await db();
  if (!userStylesReady.has(d)) {
    for (const sql of USER_STYLES_SQL) await d.run(sql);
    userStylesReady.add(d);
  }
  return d;
}

function mapUserStyle(r: Record<string, unknown>): UserStyleRow {
  return {
    slug: String(r.slug), user: String(r.user), ...(r.based_on ? { basedOn: String(r.based_on) } : {}),
    style: json<unknown>(r.style_json, {}), changes: json<unknown[]>(r.changes_json, []), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

export async function listUserStyles(): Promise<UserStyleRow[]> {
  const rows = await (await userStylesDb()).all<Record<string, unknown>>("SELECT * FROM user_styles ORDER BY updated_at DESC");
  return rows.map(mapUserStyle);
}

export async function getUserStyle(slug: string): Promise<UserStyleRow | undefined> {
  const row = await (await userStylesDb()).get<Record<string, unknown>>("SELECT * FROM user_styles WHERE slug = ?", [slug]);
  return row ? mapUserStyle(row) : undefined;
}

export async function putUserStyle(input: { slug: string; user: string; basedOn?: string; style: unknown; changes: unknown[] }): Promise<UserStyleRow> {
  const d = await userStylesDb();
  const now = Date.now();
  const cur = await getUserStyle(input.slug);
  if (cur) {
    await d.run("UPDATE user_styles SET based_on = ?, style_json = ?, changes_json = ?, updated_at = ? WHERE slug = ?", [input.basedOn ?? null, JSON.stringify(input.style), JSON.stringify(input.changes), now, input.slug]);
  } else {
    await d.run("INSERT INTO user_styles (slug, user, based_on, style_json, changes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [input.slug, input.user, input.basedOn ?? null, JSON.stringify(input.style), JSON.stringify(input.changes), now, now]);
  }
  return (await getUserStyle(input.slug))!;
}

export async function deleteUserStyle(slug: string): Promise<void> {
  await (await userStylesDb()).run("DELETE FROM user_styles WHERE slug = ?", [slug]);
}
