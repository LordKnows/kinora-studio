import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import directorGuide from "@/mcp/guide";
import { CINEMA } from "@/studio/cinematography";
import { cinematographyGuide, editingGuide, filmPlan } from "@/studio/director-guides";
import { EDIT_GRAMMAR, TIMELINE_ONLY, planDurations } from "@/studio/editing";
import { StudioError } from "@/studio/errors";
import * as gpu from "@/studio/gpu";
import * as orch from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import {
  ElementInput, ExportRequest, LookSettings, LoraInput, ProjectInput, ShotInput, ShotPatch, ShotlistInput, TakeRequest, TimelineInput,
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

  tool("get_director_guide", "The director guide. section: workflow (default; the three tiers, H3 rules, budget), editing (Tier 2: the edit grammar — link types, anchors, which H3 workflow each needs), cinematography (Tier 3: the vocabulary keys for size, angle, lens, light, grade, texture, vfx, animation, pace). Read workflow before starting a project.", z.object({ section: z.enum(["workflow", "editing", "cinematography", "all"]).default("workflow") }), async ({ section }) => {
    if (section === "editing") return editingGuide();
    if (section === "cinematography") return cinematographyGuide();
    if (section === "all") return [directorGuide, editingGuide(), cinematographyGuide()].join("\n\n---\n\n");
    return directorGuide;
  });
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
  tool("compile_prompt", "Preview the compiled H3 prompt, worker input, warnings and cost estimate for a shot.", z.object({ shotId: id, steps: z.number().int().min(4).max(30).optional() }), async ({ shotId, steps }) => orch.compileForShot(shotId, { steps }));

  tool("select_hero_frame", "Choose the hero frame (asset id) for a shot; null clears it.", z.object({ shotId: id, assetId: id.nullable() }), async ({ shotId, assetId }) => ({ shot: await repo.updateShot(shotId, { heroAssetId: assetId }) }));
  tool("select_end_frame", "Choose an end frame (asset id) for a keyframe shot; null clears it.", z.object({ shotId: id, assetId: id.nullable() }), async ({ shotId, assetId }) => ({ shot: await repo.updateShot(shotId, { endAssetId: assetId }) }));

  tool("generate_take", "Render takes for a shot on the H3 worker (costs money; confirm). Requires approved script and shotlist.", z.object({ shotId: id }).extend(TakeRequest.shape), async ({ shotId, ...req }) => orch.createTakes(shotId, req, actor));
  tool("get_take", "Status, video url, last frame, thumbnails, cost and review of a take.", z.object({ takeId: id }), async ({ takeId }) => ({ take: await orch.refreshTake(takeId) }));
  tool("list_takes", "All takes of a shot.", z.object({ shotId: id }), async ({ shotId }) => ({ takes: await repo.listShotTakes(shotId) }));
  tool("cancel_take", "Cancel a queued or running take.", z.object({ takeId: id }), async ({ takeId }) => ({ take: await orch.cancelTake(takeId) }));
  tool("retry_take", "Retry a failed or timed-out take (costs money; confirm).", z.object({ takeId: id, confirm: z.boolean().default(false) }), async ({ takeId, confirm }) => ({ take: await orch.retryTake(takeId, actor, confirm) }));
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
