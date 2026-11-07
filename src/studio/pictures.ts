import { config } from "./config";
import { StudioError } from "./errors";
import { getProjectView, type ProjectView } from "./orchestrator";
import * as repo from "./repo";
import { deleteObject, keyOfPublicUrl } from "./storage/r2";
import type { Actor, Asset } from "./types";

/*
 * The project's pictures as things to manage: every image has a handle
 * (IMG-12, per project, never reused) and a name, so "redraw IMG-12" means
 * one picture in a conversation; and pictures can be deleted in batches.
 *
 * A delete first says where each picture is in use (a shot's first or last
 * frame, an element's reference, the style frame, a take's keyframe); with
 * confirm it takes them out of those places and deletes the rows, then the
 * R2 files nobody else points at (a take's own last frame stays: the take
 * still shows it).
 */

export type PictureUse = { kind: "first_frame" | "last_frame" | "element_ref" | "style_frame" | "take"; id: string; label: string };

function shotLabel(view: ProjectView, shotId: string): string {
  for (const s of view.scenes) {
    const sh = s.shots.find((x) => x.id === shotId);
    if (sh) return `${s.slug} #${sh.index + 1}`;
  }
  return shotId;
}

/** Where each picture is in use, by asset id. */
export function picturesInUse(view: ProjectView, ids: string[]): Map<string, PictureUse[]> {
  const want = new Set(ids);
  const out = new Map<string, PictureUse[]>(ids.map((id) => [id, []]));
  const add = (id: string | undefined, use: PictureUse) => {
    if (id && want.has(id)) out.get(id)!.push(use);
  };
  for (const s of view.scenes) {
    for (const sh of s.shots) {
      add(sh.heroAssetId, { kind: "first_frame", id: sh.id, label: `first frame of ${shotLabel(view, sh.id)}` });
      add(sh.endAssetId, { kind: "last_frame", id: sh.id, label: `last frame of ${shotLabel(view, sh.id)}` });
      for (const t of sh.takes) {
        const input = JSON.stringify(t.input ?? {});
        for (const a of view.assets) if (want.has(a.id) && a.source !== "frame-extract" && input.includes(a.url)) add(a.id, { kind: "take", id: t.id, label: `read by take #${t.n} of ${shotLabel(view, sh.id)}` });
      }
    }
  }
  for (const e of view.elements) for (const r of e.refAssetIds) add(r, { kind: "element_ref", id: e.id, label: `reference of ${e.name}${e.projectId ? "" : " (library)"}` });
  add(view.project.look.styleFrameAssetId, { kind: "style_frame", id: view.project.id, label: "the style frame" });
  return out;
}

/** An asset id or a handle ("IMG-12") of a picture in this project. */
export async function resolvePicture(projectId: string, ref: string): Promise<Asset> {
  const asset = await repo.getAsset(await repo.resolveAssetRef(projectId, ref));
  if (asset.projectId !== projectId || asset.kind !== "image") throw new StudioError("validation", `${ref} is not a picture of this project`);
  return asset;
}

export async function renamePicture(projectId: string, ref: string, name: string): Promise<Asset> {
  const asset = await resolvePicture(projectId, ref);
  if (!name.trim()) throw new StudioError("validation", "a name cannot be empty");
  return repo.renameAsset(asset.id, name);
}

export type DeletePlan = { deleted: Array<{ id: string; handle?: string; name?: string }>; detached: Array<PictureUse & { picture: string }>; keptFiles: string[]; inUse?: Array<{ id: string; handle?: string; uses: PictureUse[] }> };

/**
 * Delete pictures. Without confirm, pictures that are in use stop it with
 * needs_confirm (the answer lists where). `allowInUse: false` (the agent)
 * refuses those outright: taking a frame off a shot is the user's call.
 */
export async function deletePictures(projectId: string, refs: string[], actor: Actor, opts: { confirm?: boolean; allowInUse?: boolean } = {}): Promise<DeletePlan> {
  if (!refs.length) throw new StudioError("validation", "name at least one picture");
  if (refs.length > 200) throw new StudioError("validation", "at most 200 pictures at once");
  const assets: Asset[] = [];
  for (const ref of [...new Set(refs)]) assets.push(await resolvePicture(projectId, ref));
  const view = await getProjectView(projectId);
  const uses = picturesInUse(view, assets.map((a) => a.id));
  const inUse = assets.filter((a) => uses.get(a.id)!.length).map((a) => ({ id: a.id, handle: a.handle, uses: uses.get(a.id)! }));
  if (inUse.length && opts.allowInUse === false) {
    throw new StudioError("forbidden", `${inUse.map((u) => u.handle ?? u.id).join(", ")} ${inUse.length === 1 ? "is" : "are"} in use (${inUse.flatMap((u) => u.uses.map((x) => x.label)).slice(0, 4).join("; ")}); the user deletes those on the web`, { inUse });
  }
  if (inUse.length && !opts.confirm) {
    throw new StudioError("needs_confirm", `${inUse.length} of ${assets.length} picture${assets.length > 1 ? "s are" : " is"} in use; deleting takes ${inUse.length > 1 ? "them" : "it"} out of those places`, { inUse });
  }
  /* take them out of where they are used */
  const detached: DeletePlan["detached"] = [];
  const ids = new Set(assets.map((a) => a.id));
  for (const s of view.scenes) {
    for (const sh of s.shots) {
      const patch: { heroAssetId?: null; endAssetId?: null } = {};
      if (sh.heroAssetId && ids.has(sh.heroAssetId)) patch.heroAssetId = null;
      if (sh.endAssetId && ids.has(sh.endAssetId)) patch.endAssetId = null;
      if (Object.keys(patch).length) await repo.updateShot(sh.id, patch);
    }
  }
  for (const e of view.elements) {
    if (!e.refAssetIds.some((r) => ids.has(r))) continue;
    const refViews = Object.fromEntries(Object.entries(e.refViews ?? {}).filter(([k]) => !ids.has(k)));
    await repo.updateElement(e.id, { refAssetIds: e.refAssetIds.filter((r) => !ids.has(r)), refViews });
  }
  if (view.project.look.styleFrameAssetId && ids.has(view.project.look.styleFrameAssetId)) await repo.setProjectLook(projectId, { ...view.project.look, styleFrameAssetId: undefined });
  for (const u of inUse) for (const x of u.uses) if (x.kind !== "take") detached.push({ ...x, picture: u.handle ?? u.id });
  await repo.deleteAssets([...ids]);
  /* files: ours (under projects/ or uploads/), not shared with another asset or a take */
  const keptFiles: string[] = [];
  if (config.r2Configured()) {
    const left = await repo.listAssets(projectId);
    const takes = view.scenes.flatMap((s) => s.shots.flatMap((sh) => sh.takes));
    const takeUrls = new Set(takes.flatMap((t) => [t.resultUrl, t.lastFrameUrl, ...t.thumbUrls].filter((u): u is string => !!u)));
    const takeInputs = takes.map((t) => JSON.stringify(t.input ?? {}));
    for (const a of assets) {
      const urls = [a.url, a.meta.previewUrl, a.meta.diffUrl].filter((u): u is string => typeof u === "string");
      for (const url of urls) {
        const key = keyOfPublicUrl(url);
        if (!key || !(key.startsWith(`projects/${projectId}/`) || key.startsWith("uploads/"))) continue;
        if (left.some((x) => x.url === url || x.meta.previewUrl === url) || takeUrls.has(url) || takeInputs.some((i) => i.includes(url))) {
          keptFiles.push(key);
          continue;
        }
        await deleteObject(key).catch(() => keptFiles.push(key));
      }
    }
  }
  await repo.insertNote(projectId, "decision", "standing", { decision: `deleted ${assets.length} picture${assets.length > 1 ? "s" : ""}: ${assets.map((a) => a.handle ?? a.id).join(", ")}`, why: detached.length ? `taken out of: ${detached.map((d) => d.label).join("; ")}` : "", by: actor.via === "mcp" ? "agent" : actor.user, confidence: actor.via === "mcp" ? "medium" : "user" });
  return { deleted: assets.map((a) => ({ id: a.id, handle: a.handle, name: a.name })), detached, keptFiles };
}
