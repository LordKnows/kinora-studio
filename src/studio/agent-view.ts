import type { ProjectView } from "./orchestrator";
import type { Asset, Take } from "./types";

/* What an agent gets back from the aggregate tools. The web reads the full
   project view; an agent reading the same thing got 240–530 KB on real
   projects (every picture with the prompt it was drawn from, every take with
   its compiled prompt and worker input), more than a tool result may hold, so
   the aggregate could not be read at all. Here every row is a summary, and the
   one-row tools (get_take, list_assets with ids, compile_prompt) keep the
   detail. */

type Row = Record<string, unknown>;

const drop = (row: Row): Row => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null && v !== ""));
const clip = (text: unknown, max: number): string | undefined => (typeof text === "string" && text ? (text.length > max ? `${text.slice(0, max)}…` : text) : undefined);

/** A picture, video or sound without the prompt and job record it was made from. */
export function compactAsset(a: Asset): Row {
  const m = a.meta ?? {};
  const auto = m.autoReview as { verdict?: string } | undefined;
  const checks = Array.isArray(m.checks) ? (m.checks as Array<{ code?: string; level?: string }>).filter((c) => c.level === "warn" || c.level === "fail").map((c) => `${c.level}:${c.code}`) : [];
  return drop({
    id: a.id, handle: a.handle, name: a.name ?? clip(m.label, 80), kind: a.kind, source: a.source, url: a.url,
    width: a.width, height: a.height, durationS: a.durationS,
    purpose: m.purpose, op: m.op, review: m.review, reviewedBy: m.reviewedBy, autoReview: auto?.verdict,
    checks: checks.length ? checks : undefined, realness: m.realness,
  });
}

/** A take without its compiled prompt, worker input and thumbnails (get_take has them). */
export function compactTake(t: Take): Row {
  const input = t.input ?? {};
  const loras = Array.isArray(input.loras) ? (input.loras as Array<{ name?: string; file?: string; strength?: number }>).map((l) => `${l.name ?? l.file}${l.strength !== undefined && l.strength !== 1 ? `@${l.strength}` : ""}`) : [];
  return drop({
    id: t.id, n: t.n, workflow: t.workflow, status: t.status,
    steps: input.steps, loras, seed: t.seed, videoSize: input.video_size, experiments: input.studio_experiments,
    outputSeconds: t.outputSeconds, executionMs: t.executionMs, costUsd: t.costUsd, gpuTypeId: t.gpuTypeId,
    resultUrl: t.resultUrl, lastFrameUrl: t.lastFrameUrl, error: clip(t.error, 400),
    review: t.review, retake: input.studio_retake, measured: input.studio_checks ? true : undefined,
    progress: t.status === "queued" || t.status === "running" ? t.progress : undefined,
    upscale: t.upscale ? drop({ status: t.upscale.status, resolution: t.upscale.resolution, url: t.upscale.url, costUsd: t.upscale.costUsd }) : undefined,
    createdAt: t.createdAt, finishedAt: t.finishedAt,
  });
}

/** Scenes and shots as saved, each take and frame as a summary. */
export function compactScenes(view: ProjectView): Row[] {
  return view.scenes.map((scene) => ({
    ...scene,
    shots: scene.shots.map(({ takes, hero, end, selectedTake, ...shot }) => drop({
      ...shot,
      hero: hero ? compactAsset(hero) : undefined,
      end: end ? compactAsset(end) : undefined,
      selectedTakeId: selectedTake?.id ?? shot.selectedTakeId,
      takes: takes.map(compactTake),
    })),
  }));
}

/** The project in one read: everything an agent plans from, with counts where the web shows lists. */
export function agentProjectView(view: ProjectView): Row {
  const pictures = view.assets.filter((a) => a.kind === "image");
  const tally = (rows: Asset[], key: (a: Asset) => unknown) => {
    const out: Record<string, number> = {};
    for (const a of rows) {
      const k = String(key(a) ?? "other");
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  return {
    project: view.project,
    script: view.script,
    /* the library belongs to every project: list_elements with includeLibrary shows it */
    elements: view.elements.filter((e) => e.projectId === view.project.id),
    scenes: compactScenes(view),
    timeline: view.timeline,
    assets: {
      byKind: tally(view.assets, (a) => a.kind),
      picturesByPurpose: tally(pictures, (a) => a.meta?.purpose),
      note: "list_assets lists them (one line each; ids + full for the prompt a picture was drawn from); get_take has a take's prompt, input and thumbnails",
    },
    canGenerate: view.canGenerate,
    blockers: view.blockers,
    delegated: view.delegated,
  };
}
