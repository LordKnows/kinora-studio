import { getDb, type Db, type SqlValue } from "@/db";

import { config } from "./config";
import { StudioError, notFound } from "./errors";
import { newId } from "./ids";
import * as repo from "./repo";
import { deleteObject } from "./storage/r2";

/* What a delete removed, kept for a while so it can be put back.

   A delete of a shot, a scene, an element, some pictures or a whole project
   first copies every row it is about to remove (and the rows the database
   removes with it: a scene's shots, a shot's takes, a project's everything)
   into the trash as they are, then deletes as before. Restoring writes the
   rows back with the same ids, so links to them (a timeline clip, a shot's
   anchor, an element named in a shot) work again. What the delete changed
   elsewhere — a picture taken off a shot or an element — is recorded too and
   undone. Picture files are only removed from storage when the entry
   expires, so a restored picture still has its file. Entries expire after
   TRASH_DAYS; the sweep empties them. */

export const TRASH_DAYS = 14;

export type TrashKind = "shot" | "scene" | "element" | "pictures" | "project";

/** Something the delete changed outside the rows it removed, to change back on restore. */
export type Reattach =
  | { kind: "shot_frame"; shotId: string; field: "hero_asset_id" | "end_asset_id"; assetId: string }
  | { kind: "element_ref"; elementId: string; assetId: string; view?: unknown; index: number }
  | { kind: "style_frame"; projectId: string; assetId: string };

type Payload = { rows: Array<{ table: string; row: Record<string, SqlValue> }>; reattach?: Reattach[]; files?: string[]; owner?: string; visibility?: string };

export type TrashEntry = {
  id: string; projectId: string | null; kind: TrashKind; label: string;
  createdAt: number; expiresAt: number; restoredAt?: number; by?: string;
};

const SQL = [
  "CREATE TABLE IF NOT EXISTS trash (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT NOT NULL, label TEXT NOT NULL, payload_json TEXT NOT NULL, by_user TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, restored_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS trash_project ON trash(project_id, created_at)",
];

/* Migration 0024 creates the table; it is also created on first use, so a
   deploy works before the file has been applied on D1. */
const ready = new WeakSet<object>();
async function db(): Promise<Db> {
  const d = await getDb();
  if (!ready.has(d)) {
    for (const s of SQL) await d.run(s);
    ready.add(d);
  }
  return d;
}

async function rows(d: Db, table: string, where: string, params: SqlValue[]): Promise<Array<{ table: string; row: Record<string, SqlValue> }>> {
  return (await d.all<Record<string, SqlValue>>(`SELECT * FROM ${table} WHERE ${where}`, params)).map((row) => ({ table, row }));
}

const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");

/** The rows a delete of this will remove, parents first (the order they are written back in). */
export async function snapshot(kind: Exclude<TrashKind, "pictures">, id: string): Promise<Payload> {
  const d = await getDb();
  if (kind === "shot") {
    return { rows: [...(await rows(d, "shots", "id = ?", [id])), ...(await rows(d, "takes", "shot_id = ?", [id]))] };
  }
  if (kind === "scene") {
    const shots = await rows(d, "shots", "scene_id = ?", [id]);
    const shotIds = shots.map((s) => s.row.id as string);
    return { rows: [...(await rows(d, "scenes", "id = ?", [id])), ...shots, ...(shotIds.length ? await rows(d, "takes", `shot_id IN (${inList(shotIds.length)})`, shotIds) : [])] };
  }
  if (kind === "element") return { rows: await rows(d, "elements", "id = ?", [id]) };
  /* a project: every table that hangs off it; tables an older database does not have yet are skipped */
  const out: Payload = { rows: [] };
  const project = await rows(d, "projects", "id = ?", [id]);
  out.rows.push(...project);
  out.owner = (project[0]?.row.owner as string | undefined) ?? undefined;
  out.visibility = (project[0]?.row.visibility as string | undefined) ?? undefined;
  for (const table of ["scripts", "elements", "assets", "scenes", "shots", "takes", "timelines", "export_jobs", "jobs", "director_notes", "reviews", "voice_cards", "voice_settings", "eval_votes"]) {
    try {
      out.rows.push(...(await rows(d, table, "project_id = ?", [id])));
    } catch (caught) {
      if (!/no such table/i.test(caught instanceof Error ? caught.message : String(caught))) throw caught;
    }
  }
  return out;
}

/** Asset rows for a picture delete (the caller adds what it detaches and the files it would remove). */
export async function snapshotAssets(ids: string[]): Promise<Payload> {
  const d = await getDb();
  return { rows: ids.length ? await rows(d, "assets", `id IN (${inList(ids.length)})`, ids) : [] };
}

export async function put(entry: { projectId: string | null; kind: TrashKind; label: string; by?: string }, payload: Payload): Promise<string> {
  const id = newId("trs");
  const now = Date.now();
  await (await db()).run("INSERT INTO trash (id, project_id, kind, label, payload_json, by_user, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    id, entry.projectId, entry.kind, entry.label.slice(0, 200), JSON.stringify(payload), entry.by ?? null, now, now + TRASH_DAYS * 86_400_000,
  ]);
  return id;
}

function map(r: Record<string, unknown>): TrashEntry {
  return {
    id: String(r.id), projectId: r.project_id ? String(r.project_id) : null, kind: String(r.kind) as TrashKind, label: String(r.label),
    createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), ...(r.restored_at ? { restoredAt: Number(r.restored_at) } : {}), ...(r.by_user ? { by: String(r.by_user) } : {}),
  };
}

/** What can still be put back in a project (newest first). */
export async function listForProject(projectId: string): Promise<TrashEntry[]> {
  const list = await (await db()).all<Record<string, unknown>>("SELECT id, project_id, kind, label, by_user, created_at, expires_at, restored_at FROM trash WHERE project_id = ? AND kind != 'project' AND restored_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 50", [projectId, Date.now()]);
  return list.map(map);
}

/** Deleted projects that can still be put back, with who may see them. */
export async function listProjects(): Promise<Array<TrashEntry & { owner?: string; visibility: "shared" | "private" }>> {
  const list = await (await db()).all<Record<string, unknown>>("SELECT * FROM trash WHERE kind = 'project' AND restored_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 50", [Date.now()]);
  return list.map((r) => {
    const p = JSON.parse(String(r.payload_json)) as Payload;
    return { ...map(r), ...(p.owner ? { owner: p.owner } : {}), visibility: p.visibility === "private" ? "private" : "shared" };
  });
}

export async function get(id: string): Promise<TrashEntry & { payload: Payload }> {
  const r = await (await db()).get<Record<string, unknown>>("SELECT * FROM trash WHERE id = ?", [id]);
  if (!r) throw notFound("deleted item", id);
  return { ...map(r), payload: JSON.parse(String(r.payload_json)) as Payload };
}

/** Write a deleted thing back. Refuses one already restored or expired, and one whose project is gone. */
export async function restore(id: string): Promise<TrashEntry> {
  const d = await db();
  const entry = await get(id);
  if (entry.restoredAt) throw new StudioError("validation", "this was put back already");
  if (entry.expiresAt <= Date.now()) throw new StudioError("validation", `deleted more than ${TRASH_DAYS} days ago; it cannot be put back`);
  if (entry.kind !== "project" && entry.projectId && !(await d.get("SELECT id FROM projects WHERE id = ?", [entry.projectId]))) {
    throw new StudioError("validation", "its project was deleted; put the project back first");
  }
  const written: Array<{ table: string; id: unknown; key: string }> = [];
  try {
    for (const { table, row } of entry.payload.rows) {
      const cols = Object.keys(row);
      /* a picture's handle may have been given to a newer one: it gets the next free number */
      if (table === "assets" && row.seq !== null && row.seq !== undefined && row.project_id) {
        const taken = await d.get("SELECT id FROM assets WHERE project_id = ? AND seq = ?", [row.project_id, row.seq]);
        if (taken) {
          const top = await d.get<{ m: number | null }>("SELECT MAX(seq) m FROM assets WHERE project_id = ?", [row.project_id]);
          row.seq = (top?.m ?? 0) + 1;
        }
      }
      await d.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${inList(cols.length)})`, cols.map((c) => row[c] as SqlValue));
      const key = table === "timelines" || table === "voice_settings" ? "project_id" : "id";
      written.push({ table, id: row[key], key });
    }
  } catch (caught) {
    /* put nothing back halfway */
    for (const w of written.reverse()) await d.run(`DELETE FROM ${w.table} WHERE ${w.key} = ?`, [w.id as SqlValue]).catch(() => undefined);
    throw new StudioError("validation", `could not put it back: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  for (const r of entry.payload.reattach ?? []) await reattach(r);
  await renumber(d, entry);
  await d.run("UPDATE trash SET restored_at = ? WHERE id = ?", [Date.now(), id]);
  return { ...entry, restoredAt: Date.now() };
}

async function reattach(r: Reattach): Promise<void> {
  /* each only where nothing has been put in its place since */
  try {
    if (r.kind === "shot_frame") {
      const shot = await repo.getShot(r.shotId);
      if (r.field === "hero_asset_id" && !shot.heroAssetId) await repo.updateShot(r.shotId, { heroAssetId: r.assetId });
      if (r.field === "end_asset_id" && !shot.endAssetId) await repo.updateShot(r.shotId, { endAssetId: r.assetId });
    } else if (r.kind === "element_ref") {
      const el = await repo.getElement(r.elementId);
      if (el.refAssetIds.includes(r.assetId)) return;
      const refs = [...el.refAssetIds];
      refs.splice(Math.min(r.index, refs.length), 0, r.assetId);
      await repo.updateElement(r.elementId, { refAssetIds: refs, ...(r.view !== undefined ? { refViews: { [r.assetId]: r.view } as never } : {}) });
    } else {
      const project = await repo.getProject(r.projectId);
      if (!project.look.styleFrameAssetId) await repo.setProjectLook(r.projectId, { ...project.look, styleFrameAssetId: r.assetId });
    }
  } catch {
    /* the shot or element went in the meantime: nothing to put it on */
  }
}

/* a restored shot or scene takes back its place; the ones after it move down one */
async function renumber(d: Db, entry: TrashEntry & { payload: Payload }): Promise<void> {
  const top = entry.payload.rows[0];
  if (!top || (entry.kind !== "shot" && entry.kind !== "scene")) return;
  const [table, parent, parentId] = entry.kind === "shot" ? ["shots", "scene_id", top.row.scene_id] : ["scenes", "project_id", top.row.project_id];
  const list = await d.all<{ id: string; idx: number }>(`SELECT id, idx FROM ${table} WHERE ${parent} = ? ORDER BY idx`, [parentId as SqlValue]);
  const mine = list.find((x) => x.id === top.row.id);
  const others = list.filter((x) => x.id !== top.row.id);
  const at = Math.max(0, Math.min(Number(top.row.idx ?? others.length), others.length));
  const order = [...others.slice(0, at), ...(mine ? [mine] : []), ...others.slice(at)];
  for (const [i, x] of order.entries()) if (x.idx !== i) await d.run(`UPDATE ${table} SET idx = ? WHERE id = ?`, [i, x.id]);
}

/** Empty what has expired: the entries, and the picture files they were keeping. */
export async function purgeExpired(now = Date.now()): Promise<number> {
  const d = await db();
  const old = await d.all<{ id: string; payload_json: string; restored_at: number | null }>("SELECT id, payload_json, restored_at FROM trash WHERE expires_at <= ? LIMIT 100", [now]);
  for (const r of old) {
    const files = r.restored_at ? [] : ((JSON.parse(r.payload_json) as Payload).files ?? []);
    if (files.length && config.r2Configured()) for (const key of files) await deleteObject(key).catch(() => undefined);
    await d.run("DELETE FROM trash WHERE id = ?", [r.id]);
  }
  return old.length;
}
