import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import * as director from "@/director";
import directorGuide from "@/mcp/guide";
import { CINEMA } from "@/studio/cinematography";
import { cinematographyGuide, editingGuide, filmPlan } from "@/studio/director-guides";
import { EDIT_GRAMMAR, TIMELINE_ONLY, planDurations } from "@/studio/editing";
import { StudioError } from "@/studio/errors";
import * as gpu from "@/studio/gpu";
import * as orch from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import {
  ElementInput, ExportRequest, LookSettings, LoraInput, ProjectInput, ShotInput, ShotPatch, ShotlistInput, TakeRequest, TimelineInput, UpscaleRequest,
} from "@/studio/schemas";
import type { Actor } from "@/studio/types";

/* §6.2 — one McpServer per request (stateless transport), tools calling the
   orchestrator directly so the agent is subject to the same checkpoints,
   budget and confirm rules as the web UI. */

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(caught: unknown): ToolResult {
  if (caught instanceof StudioError) return { isError: true, content: [{ type: "text", text: JSON.stringify(caught.toJSON(), null, 2) }] };
  if (caught instanceof z.ZodError) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "validation", message: "invalid input", details: caught.issues } }, null, 2) }] };
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "backend_error", message: caught instanceof Error ? caught.message : String(caught) } }) }] };
}


/* What the director still owes a shot: the Tier 2 link and the core Tier 3
   keys. Returned as warnings so the agent fixes them before approval. */
export function shotWarnings(label: string, spec: { link?: { type?: string }; linkToPrev?: string; cinematography?: Record<string, unknown> | null }): string[] {
  const out: string[] = [];
  if (!spec.link) out.push(`${label}: no link (Tier 2) — set link.type from the editing grammar (cut, continuous, bridge, insert_return, reverse, match_cut, jump_cut, montage, loop)`);
  const c = spec.cinematography ?? {};
  const missing = ["size", "angle", "lens", "lighting", "grade"].filter((k) => { const v = c[k]; return v === undefined || v === null || (Array.isArray(v) && v.length === 0); });
  if (missing.length) out.push(`${label}: cinematography missing ${missing.join(", ")} (Tier 3) — revise_shot with keys from cinematography_catalog`);
  return out;
}

export function createStudioServer(actor: Actor): McpServer {
  const server = new McpServer({ name: "cinema-studio", version: "0.1.0" }, { instructions: "Cinema Studio: script → elements → shotlist → hero frames → takes → timeline → export. Call get_director_guide first." });

  const tool = <T extends z.ZodTypeAny>(name: string, description: string, input: T, run: (args: z.infer<T>) => Promise<unknown>) => {
    const cb = async (args: unknown) => {
      try {
        return ok(await run(input.parse(args)));
      } catch (caught) {
        return fail(caught);
      }
    };
    server.registerTool(name, { description, inputSchema: input }, cb as unknown as Parameters<typeof server.registerTool>[2]);
  };

  const id = z.string().min(1);

  tool("get_director_guide", "The director guide. section: workflow (default; the three tiers, H3 rules, budget), editing (Tier 2: the edit grammar — link types, anchors, which H3 workflow each needs), cinematography (Tier 3: the vocabulary keys for size, angle, lens, light, grade, texture, vfx, animation, pace), judgement (brief, treatment, story, sound, rhythm, camera, delivery), technique (the H3 constraints in one place), styles (the style preset index). Read workflow before starting a project.", z.object({ section: z.enum(["workflow", "editing", "cinematography", "judgement", "technique", "styles", "all"]).default("workflow") }), async ({ section }) => {
    if (section === "editing") return editingGuide();
    if (section === "cinematography") return cinematographyGuide();
    if (section === "judgement") return director.DIRECTOR_DOC;
    if (section === "technique") return director.TECHNIQUE_DOC;
    if (section === "styles") return director.STYLES_INDEX_DOC;
    if (section === "all") return [directorGuide, editingGuide(), cinematographyGuide(), director.DIRECTOR_DOC, director.TECHNIQUE_DOC].join("\n\n---\n\n");
    return directorGuide;
  });

  /* ---- the director layer (packages/director), served from the connector ---- */
  const ShotlistShape = z.object({ scenes: z.array(z.object({ slug: z.string(), summary: z.string().optional(), location: z.string().optional(), shots: z.array(z.any()) })) });
  const CueMapShape = z.object({
    sections: z.array(z.object({ id: z.string(), t: z.number().min(0), bpm: z.number(), beatsPerBar: z.number().int().optional(), texture: z.string().optional() })).min(1),
    hits: z.array(z.object({ id: z.string(), section: z.string(), bar: z.number(), beat: z.number(), what: z.string() })).default([]),
    silences: z.array(z.object({ t: z.number(), durationS: z.number(), why: z.string() })).optional(),
  });
  tool("list_styles", "Every style preset: slug, names, category, uses, one line. Styles compile into Look, negatives, per-shot cinematography defaults, allowed camera moves, transitions and sound defaults.", z.object({}), async () =>
    director.loadStyles().map(({ style: s, origin }) => ({ slug: s.slug, en: s.en, cn: s.cn, category: s.category, uses: s.uses, line: s.line, line_cn: s.line_cn, origin })));
  tool("suggest_styles", "Two or three styles that fit a topic, with why. Then ask the user to pick by name.", z.object({ topic: z.string().min(2), n: z.number().int().min(1).max(5).default(3) }), async ({ topic, n }) =>
    director.suggestStyles(topic, n).map((r) => ({ slug: r.style.slug, en: r.style.en, cn: r.style.cn, score: r.score, why: r.why, line: r.style.line })));
  tool("get_style", "One style preset in full: JSON (engine fields, camera grammar, native moves, pitfalls, variation space) or STYLE.md.", z.object({ style: z.string().min(1).describe("slug, English or Chinese name"), format: z.enum(["json", "markdown"]).default("markdown") }), async ({ style, format }) => {
    const s = director.findStyle(style);
    if (!s) throw new StudioError("not_found", `no style matches "${style}"`, { available: director.loadStyles().map((x) => x.style.slug) });
    return format === "json" ? s.style : director.styleToMarkdown(s.style);
  });
  tool("compile_look", "Style → the look object for start_film / update_look (genre, palette, camera, lens, lighting, negatives, LoRAs), plus the style's beat suffix, cinematography defaults, allowed camera moves, transitions and duration guide.", z.object({
    style: z.string().min(1),
    aspectRatio: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional(),
    negative: z.array(z.string().max(80)).optional().describe("extra negatives from the brief"),
    loras: z.array(z.object({ id: z.string(), strength: z.number().min(0).max(2).optional() })).optional(),
    genreSuffix: z.string().max(80).optional(),
    paletteSuffix: z.string().max(80).optional(),
  }), async ({ style, ...o }) => {
    const s = director.findStyle(style);
    if (!s) throw new StudioError("not_found", `no style matches "${style}"`);
    return { look: director.compileLook(s.style, o), beatSuffix: s.style.engine.beatSuffix, cinematographyDefaults: s.style.engine.cinematography, allowedCameraMoves: s.style.camera.grammar.map((g) => g.move), transitions: s.style.camera.transitions, durationGuide: s.style.engine.durations };
  });
  tool("apply_style", "Fill every shot's cinematography with the style defaults (explicit values win), append the beat suffix, default ambience/music, and warn about camera moves and links outside the style's grammar. Returns the shotlist to pass to save_shotlist.", z.object({ style: z.string().min(1), shotlist: ShotlistShape, beatSuffix: z.boolean().default(true), musicForShotsWithScore: z.boolean().default(true) }), async ({ style, shotlist, beatSuffix, musicForShotsWithScore }) => {
    const s = director.findStyle(style);
    if (!s) throw new StudioError("not_found", `no style matches "${style}"`);
    return director.applyStyle(s.style, shotlist as never, { beatSuffix, musicForShotsWithScore });
  });
  tool("lint_project", "Lint the project's saved shotlist (rhythm, variety, breath, link/mode sanity, render-order switches) plus Tier 2 / Tier 3 completeness per shot. Fix the errors and warnings with revise_shot before asking for approval.", z.object({ projectId: id }), async ({ projectId }) => orch.lintProject(projectId));
  tool("apply_style_to_project", "Apply a style preset to the project's saved shotlist (cinematography defaults where unset, beat suffix, sound defaults) and save it; records the style on the Look.", z.object({ projectId: id, style: z.string().min(1), beatSuffix: z.boolean().default(true), musicForShotsWithScore: z.boolean().default(true) }), async ({ projectId, style, ...opts }) => {
    const { warnings, view } = await orch.applyStyleToProject(projectId, style, opts);
    return { warnings, approval: view.project.shotlistApproval };
  });
  tool("plan_project_batch", "The render plan for the project's shots without a finished take: R2VA first, anchors before linked shots, passes, one estimate against the cap (compiler estimates where the shot compiles). Then generate_take in that order.", z.object({ projectId: id, takesPerShot: z.number().int().min(1).max(4).default(1), onlyMissing: z.boolean().default(true) }), async ({ projectId, ...opts }) => orch.planProjectBatch(projectId, opts));
  tool("lint_shotlist", "Deterministic rhythm and craft lint on a shotlist in save_shotlist shape: pace and framing variety, a breath, static use, runs of the same link, dialogue density, beat tiling, link/mode sanity, render-order switches. Run before save_shotlist and fix the errors and warnings.", z.object({ shotlist: ShotlistShape, totalSeconds: z.number().int().optional(), errorsAndWarningsOnly: z.boolean().default(false) }), async ({ shotlist, totalSeconds, errorsAndWarningsOnly }) =>
    director.lintShotlist(shotlist as never, { totalSeconds, errorsAndWarningsOnly }));
  tool("validate_treatment", "Check a treatment (logline, arc, three candidate structures and the chosen one, benchmark, hook ≤ 3 s, ending echo, signature shot, native move, sequences with pace, sound design, silences, J/L cuts). Returns warnings and TREATMENT.md to put in save_script.", z.object({ treatment: z.any(), style: z.string().optional() }), async ({ treatment, style }) => {
    const s = style ? director.findStyle(style) : undefined;
    const r = director.validateTreatment(treatment, s?.style.nativeMoves.map((m) => m.name));
    return { ...r, markdown: r.ok ? director.treatmentToMarkdown(treatment) : undefined };
  });
  tool("check_cue_map", "Validate a cue map (tempo sections, hit points as section/bar/beat, silences) and resolve every hit to seconds; with a shotlist, warn when hits land at shot seams.", z.object({ cueMap: CueMapShape, shotlist: ShotlistShape.optional(), totalSeconds: z.number().optional() }), async ({ cueMap, shotlist, totalSeconds }) =>
    ({ warnings: director.checkCueMap(cueMap as director.CueMap, shotlist as never, totalSeconds), hits: director.hitTimes(cueMap as director.CueMap) }));
  tool("cut_on_beats", "Given a cue map and the shots in order, compute per-clip outS so every cut lands on the grid (subdivision 1 = beat, 0.25 = bar in 4/4, 2 = half beat) within each take's renderable length.", z.object({ cueMap: CueMapShape, shots: z.array(z.object({ durationS: z.number() })), subdivision: z.number().default(1), startS: z.number().default(0) }), async ({ cueMap, shots, subdivision, startS }) =>
    director.cutOnBeats(cueMap as director.CueMap, shots, { subdivision, startS }));
  tool("check_subtitles", "Reading-time check for subtitle / narration lines (CJK ÷ 4.5 + Latin ÷ 15 + 1.5 s, ≥ 1.8 s, ≥ speech + 0.6 s). Places unplaced lines in order. Returns issues, placed lines and the SRT.", z.object({ lines: z.array(z.object({ id: z.string(), text: z.string(), t0: z.number().optional(), t1: z.number().optional(), language: z.string().optional(), speechS: z.number().optional() })), startS: z.number().default(0), gapS: z.number().default(0.3) }), async ({ lines, startS, gapS }) => {
    const placed = director.placeLines(lines as director.Line[], startS, gapS);
    return { issues: director.checkLines(placed), lines: placed, srt: director.toSrt(placed), speech: placed.map((l) => ({ id: l.id, say: director.spellNumbersForSpeech(l.text) })) };
  });
  tool("plan_batch", "Order takes to render: R2VA shots first, then the fl2va family; linked shots after their anchors; one total estimate against the budget cap so a single confirmation covers the batch. Pass each shot's estimateUsd from compile_prompt; without it the estimate is a rough fallback and the plan says so.", z.object({
    shots: z.array(z.object({ shotId: z.string(), index: z.number().int(), durationS: z.number(), mode: z.enum(["text", "keyframe", "reference", "edit"]), link: z.object({ type: z.string(), anchor: z.number().optional(), anchorShotId: z.string().optional() }).optional(), hasTake: z.boolean().optional(), estimateUsd: z.number().optional() })),
    capUsd: z.number(), spentUsd: z.number().default(0), perSecondUsd: z.number().optional(), takesPerShot: z.number().int().min(1).max(4).default(1), onlyMissing: z.boolean().default(true),
  }), async ({ shots, capUsd, spentUsd, perSecondUsd, takesPerShot, onlyMissing }) => director.planBatch(shots as director.BatchShot[], { capUsd, spentUsd }, { perSecondUsd, takesPerShot, onlyMissing }));
  tool("check_timeline", "Validate an extended timeline (clips with J/L cuts, transitions, freezes; titles; narration; music; silences) and return the Studio-shaped timeline for save_timeline plus what only a local ffmpeg assembly would render.", z.object({ timeline: z.any() }), async ({ timeline }) =>
    ({ warnings: director.checkTimeline(timeline as director.ExtTimeline), ...director.toStudioTimeline(timeline as director.ExtTimeline) }));
  tool("start_film", "Tier 1 entry point: give the user's brief and target running time. Creates the project (brief, target, Look draft), and returns the duration plan, the three-tier instructions, the editing grammar and the cinematography vocabulary so the director skills are active from the first call.", z.object({
    name: z.string().min(1).max(120),
    brief: z.string().min(5).max(8000).describe("The user's own words for the film"),
    totalSeconds: z.number().int().min(5).max(3600).describe("Target running time in seconds"),
    shots: z.number().int().min(1).max(120).optional().describe("Preferred shot count; otherwise derived from the length"),
    look: LookSettings.partial().optional(),
    budgetCapUsd: z.number().min(0).max(100000).optional(),
  }), async ({ name, brief, totalSeconds, shots, look, budgetCapUsd }) => {
    const project = await repo.createProject({ name, brief, targetSeconds: totalSeconds, look, budgetCapUsd });
    const plan = filmPlan({ brief, totalSeconds, shots });
    return { project, ...plan, editingGrammar: EDIT_GRAMMAR, timelineOnly: TIMELINE_ONLY, cinematography: CINEMA.map((c) => ({ key: c.key, label: c.label, multi: c.multi, terms: c.terms.map((x) => ({ key: x.key, label: x.label, use: x.use })) })), loras: await repo.listLoras(), nextSteps: ["save_script", "create_element for every character/location/prop", "save_shotlist with link + cinematography per shot", "ask the user to approve the script and the shotlist"] };
  });
  tool("plan_durations", "Split a running time into 5–15 s shots that tile it exactly (deterministic arithmetic; reshape it as the story needs).", z.object({ totalSeconds: z.number().int().min(5).max(3600), shots: z.number().int().min(1).max(120).optional() }), async ({ totalSeconds, shots }) => planDurations(totalSeconds, shots));
  tool("editing_grammar", "Tier 2 reference as data: every link type with its mechanism, default anchor, H3 workflow and when to use it.", z.object({}), async () => ({ grammar: EDIT_GRAMMAR, timelineOnly: TIMELINE_ONLY }));
  tool("cinematography_catalog", "Tier 3 reference as data: every category and key with the prose it compiles to and when to use it.", z.object({ category: z.enum(["size", "angle", "lens", "dof", "lighting", "grade", "texture", "vfx", "animation", "pace"]).optional() }), async ({ category }) => ({ categories: CINEMA.filter((c) => !category || c.key === category) }));

  tool("list_projects", "List projects.", z.object({}), async () => ({ projects: await repo.listProjects() }));
  tool("create_project", "Create a project with an optional Look draft.", ProjectInput, async (input) => ({ project: await repo.createProject(input) }));
  tool("get_project", "Aggregate view: look, budget, approvals, elements, scenes, shots with takes, timeline, blockers.", z.object({ projectId: id }), async ({ projectId }) => orch.getProjectView(projectId));
  tool("update_look", "Patch the project-level Look (genre, palette, camera, lens, lighting, aspect ratio, negatives).", z.object({ projectId: id, look: LookSettings.partial() }), async ({ projectId, look }) => ({ project: await repo.setProjectLook(projectId, look) }));
  tool("gpu_status", "The GPU pod: status (none/starting/running/stopped/unavailable), GPU type, cost per hour, uptime, session cost, allowed GPU types, pending takes. 'unavailable' means none of the allowed GPU types has capacity right now; try again later.", z.object({}), async () => {
    try {
      await gpu.refreshGpu();
    } catch {
      /* show last known */
    }
    return gpu.getGpuState();
  });
  tool("gpu_start", "Start (or create) the GPU pod. Billed per hour while it runs, so confirm first. generate_take starts it automatically.", z.object({ confirm: z.boolean().default(false) }), async ({ confirm }) => gpu.startGpu(actor, confirm));
  tool("gpu_stop", "Stop the GPU pod now (the sweep also stops it after the idle timeout). Queued takes wait until it is started again.", z.object({}), async () => gpu.stopGpu());
  tool("gpu_types", "GPU types RunPod knows, flagged with whether the studio is allowed to use them.", z.object({}), async () => ({ types: await gpu.listGpuTypes() }));
  tool("gpu_stats", "Per GPU type: completed takes, total generation seconds, total video seconds, GPU-seconds per video second, and USD per video second at the price the pod was billed. Use it to rank RUNPOD_GPU_TYPES.", z.object({}), async () => ({ stats: await gpu.gpuStats(), estimateBasis: await gpu.measuredForEstimate() }));
  tool("list_loras", "The LoRA library (speed / style / effect) with filenames, HuggingFace links, trigger words and step hints. Project defaults live in the Look (update_look loras); shots can override with revise_shot loras.", z.object({}), async () => ({ loras: await repo.listLoras() }));
  tool("add_lora", "Register a LoRA: filename inside models/loras, optional HuggingFace file URL (downloaded on the pod when missing), kind, default strength, trigger words, steps hint for speed LoRAs.", LoraInput, async (input) => ({ lora: await repo.createLora(input) }));
  tool("update_lora", "Patch a LoRA's fields.", z.object({ loraId: id }).extend(LoraInput.partial().shape), async ({ loraId, ...patch }) => ({ lora: await repo.updateLora(loraId, patch) }));
  tool("get_budget", "Spent vs cap in USD.", z.object({ projectId: id }), async ({ projectId }) => {
    const p = await repo.getProject(projectId);
    return { capUsd: p.budgetCapUsd, spentUsd: p.spentUsd, remainingUsd: Math.max(0, p.budgetCapUsd - p.spentUsd) };
  });

  tool("save_script", "Save a new script version (returns to draft; the user approves on the Script page).", z.object({ projectId: id, text: z.string().min(1).max(200_000) }), async ({ projectId, text }) => ({ script: await repo.createScript(projectId, text) }));
  tool("get_script", "Latest script and its approval state.", z.object({ projectId: id }), async ({ projectId }) => ({ script: await repo.latestScript(projectId) ?? null }));

  tool("list_elements", "Characters, locations and props of the project (and the global library when includeLibrary).", z.object({ projectId: id, includeLibrary: z.boolean().default(false) }), async ({ projectId, includeLibrary }) => {
    const elements = await repo.listElements(projectId, includeLibrary);
    const assets = await repo.getAssets(elements.flatMap((e) => e.refAssetIds));
    return { elements: elements.map((e) => ({ ...e, refs: e.refAssetIds.map((a) => assets.get(a)).filter(Boolean) })) };
  });
  tool("create_element", "Create a character, location or prop with a concrete visual description.", z.object({ projectId: id }).extend(ElementInput.shape), async ({ projectId, ...input }) => ({ element: await repo.createElement(projectId, input) }));
  tool("update_element", "Patch an element's name, kind or description.", z.object({ elementId: id }).extend(ElementInput.partial().shape), async ({ elementId, ...patch }) => ({ element: await repo.updateElement(elementId, patch) }));
  tool("import_element", "Copy a library element into the project.", z.object({ projectId: id, elementId: id }), async ({ projectId, elementId }) => ({ element: await repo.copyElement(elementId, projectId) }));
  tool("list_assets", "Images, videos and audio available to the project (uploads, last frames of finished takes, exports). Use the ids with select_element_refs / select_hero_frame / select_end_frame. Image generation is disabled for now: ask the user to upload references on the Elements page or hero frames on the Board.", z.object({ projectId: id, kind: z.enum(["image", "video", "audio"]).optional() }), async ({ projectId, kind }) => ({ assets: await repo.listAssets(projectId, kind) }));
  tool("select_element_refs", "Set the element's reference images (asset ids, first one is the primary).", z.object({ elementId: id, assetIds: z.array(id).max(6) }), async ({ elementId, assetIds }) => ({ element: await repo.updateElement(elementId, { refAssetIds: assetIds }) }));

  tool("save_shotlist", "Merge the whole shotlist: scenes match by slug, shots by position, so existing takes and hero frames are kept. Refuses to drop shots that already have takes. Resets the shotlist approval; the user approves on the Board. Every shot should carry its Tier 2 link and Tier 3 cinematography (size, angle, lens, lighting, grade at least); the answer's warnings name the shots that do not.", z.object({ projectId: id }).extend(ShotlistInput.shape), async ({ projectId, scenes }) => {
    const view = await orch.saveShotlist(projectId, { scenes });
    const warnings = view.scenes.flatMap((s) => s.shots.map((sh) => shotWarnings(`${s.slug} #${sh.index + 1} (${sh.id})`, sh.spec)).flat());
    return { approval: view.project.shotlistApproval, merge: view.merge, warnings, scenes: view.scenes.map((s) => ({ id: s.id, slug: s.slug, shots: s.shots.map((sh) => ({ id: sh.id, index: sh.index, intent: sh.spec.intent, mode: sh.spec.mode, durationS: sh.spec.durationS, link: sh.spec.link?.type ?? sh.spec.linkToPrev, cinematography: sh.spec.cinematography ?? null })) })) };
  });
  tool("get_shotlist", "Scenes and shots with their takes, hero frames and approval.", z.object({ projectId: id }), async ({ projectId }) => {
    const view = await orch.getProjectView(projectId);
    return { approval: view.project.shotlistApproval, canGenerate: view.canGenerate, blockers: view.blockers, scenes: view.scenes };
  });
  tool("add_shot", "Append a shot to a scene, with its link and cinematography.", z.object({ sceneId: id, shot: ShotInput }), async ({ sceneId, shot }) => {
    const saved = await orch.addShot(sceneId, shot);
    return { shot: saved, warnings: shotWarnings(saved.id, saved.spec) };
  });
  tool("revise_shot", "Patch a shot. Structural changes (beats, camera move, dialogue, mode…) reset the shotlist approval; promptOverride and camera.note do not.", z.object({ shotId: id, patch: ShotPatch }), async ({ shotId, patch }) => ({ shot: await orch.patchShot(shotId, patch) }));
  tool("compile_prompt", "Preview the compiled H3 prompt, worker input, warnings and cost estimate for a shot.", z.object({ shotId: id, steps: z.number().int().min(4).max(50).optional() }), async ({ shotId, steps }) => orch.compileForShot(shotId, { steps }));

  tool("select_hero_frame", "Choose the hero frame (asset id) for a shot; null clears it.", z.object({ shotId: id, assetId: id.nullable() }), async ({ shotId, assetId }) => ({ shot: await repo.updateShot(shotId, { heroAssetId: assetId }) }));
  tool("select_end_frame", "Choose an end frame (asset id) for a keyframe shot; null clears it.", z.object({ shotId: id, assetId: id.nullable() }), async ({ shotId, assetId }) => ({ shot: await repo.updateShot(shotId, { endAssetId: assetId }) }));

  tool("generate_take", "Render takes for a shot on the H3 worker (costs money; confirm). Requires approved script and shotlist.", z.object({ shotId: id }).extend(TakeRequest.shape), async ({ shotId, ...req }) => orch.createTakes(shotId, req, actor));
  tool("get_take", "Status, video url, last frame, thumbnails, cost and review of a take.", z.object({ takeId: id }), async ({ takeId }) => ({ take: await orch.refreshTake(takeId) }));
  tool("list_takes", "All takes of a shot.", z.object({ shotId: id }), async ({ shotId }) => ({ takes: await repo.listShotTakes(shotId) }));
  tool("cancel_take", "Cancel a queued or running take.", z.object({ takeId: id }), async ({ takeId }) => ({ take: await orch.cancelTake(takeId) }));
  tool("retry_take", "Retry a failed or timed-out take (costs money; confirm).", z.object({ takeId: id, confirm: z.boolean().default(false) }), async ({ takeId, confirm }) => ({ take: await orch.retryTake(takeId, actor, confirm) }));
  tool("regenerate_take", "Open-H3-Regenerate-2K: re-generate a completed take at 1080p / 2K / 4K in three refine steps (costs money; confirm). It redraws, not just upscales: start_sigma 0 is sharper, 0.8 stays closer to the draft (use for character shots). The 2K file sits beside the 768p take and the master-upscaled export uses it.", z.object({ takeId: id }).extend(UpscaleRequest.shape), async ({ takeId, ...req }) => orch.regenerateTake(takeId, req, actor));
  tool("select_take", "Mark a completed take as the shot's pick.", z.object({ shotId: id, takeId: id }), async ({ shotId, takeId }) => ({ shot: await orch.selectTake(shotId, takeId) }));

  tool("auto_timeline", "Build the timeline from the selected (or latest completed) take of every shot.", z.object({ projectId: id }), async ({ projectId }) => ({ timeline: await orch.autoTimeline(projectId) }));
  tool("get_timeline", "The project's timeline.", z.object({ projectId: id }), async ({ projectId }) => ({ timeline: await repo.getTimeline(projectId) }));
  tool("save_timeline", "Replace the timeline (clips with in/out and transitions, music asset, mix).", z.object({ projectId: id, timeline: TimelineInput }), async ({ projectId, timeline }) => ({ timeline: await repo.setTimeline(projectId, timeline) }));
  tool("export_project", "Assemble the timeline into a file (costs money; confirm).", z.object({ projectId: id }).extend(ExportRequest.shape), async ({ projectId, ...req }) => orch.createExportJob(projectId, req, actor));
  tool("get_export", "Status and url of an export.", z.object({ exportId: id }), async ({ exportId }) => ({ export: await orch.refreshExport(exportId) }));

  server.registerResource("director-guide", "studio://guide/director", { title: "Director guide", description: "Workflow, the three tiers and H3 prompt rules", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: directorGuide }],
  }));
  server.registerResource("editing-guide", "studio://guide/editing", { title: "Editing grammar", description: "Tier 2: link types and anchors", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: editingGuide() }],
  }));
  server.registerResource("cinematography-guide", "studio://guide/cinematography", { title: "Cinematography vocabulary", description: "Tier 3: keys for framing, light, grade, technique", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: cinematographyGuide() }],
  }));

  /* A prompt template, for clients that expose MCP prompts: one click puts
     the director in charge of a brief. */
  server.registerPrompt("direct_film", {
    title: "Direct a film from a brief",
    description: "Run the three-tier director workflow on a brief and a running time.",
    argsSchema: { brief: z.string().describe("What the film is"), totalSeconds: z.string().describe("Running time in seconds"), name: z.string().optional().describe("Project name") },
  }, ({ brief, totalSeconds, name }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `You are the director. Call start_film with name "${name ?? "Untitled film"}", this brief and totalSeconds ${totalSeconds}; read what it returns.`,
          "Tier 1: write the Look from the brief (update_look) and the script (save_script); ask me to approve the script.",
          "Tier 2: build the shotlist that tiles the running time; choose a link type for every shot from the editing grammar; create every element first.",
          "Tier 3: every shot gets cinematography (size, angle, lens, lighting, grade at least; animation on every shot if the film is animated), one camera move, verbatim dialogue and sound. Save Tier 2 and 3 together with save_shotlist, fix every warning it returns, then ask me to approve it.",
          "Before any spend, show the estimate and wait for my confirm.",
          "",
          "Brief:",
          brief,
        ].join("\n"),
      },
    }],
  }));

  return server;
}
