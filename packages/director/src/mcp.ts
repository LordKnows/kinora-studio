#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStyles, findStyle, suggestStyles } from "./styles/index.js";
import { styleToMarkdown } from "./styles/markdown.js";
import { compileLook, applyStyle } from "./compile/look.js";
import { validateTreatment, treatmentToMarkdown } from "./treatment.js";
import { lintShotlist } from "./lint/shotlist.js";
import { checkCueMap, cutOnBeats, hitTimes, type CueMap } from "./sound/cuemap.js";
import { checkTimeline, toStudioTimeline, type ExtTimeline } from "./timeline/extended.js";
import { assemble } from "./timeline/assemble.js";
import { checkLines, placeLines, toSrt, spellNumbersForSpeech, type Line } from "./narration/srt.js";
import { synthesize } from "./narration/tts.js";
import { planBatch, type BatchShot } from "./batch.js";

/**
 * The director MCP: judgement helpers that sit beside the Cinema Studio MCP.
 * Nothing here spends money or talks to the Studio; every output is a payload
 * for a Studio tool (`start_film`, `update_look`, `save_shotlist`, `save_script`,
 * `save_timeline`, `generate_take`) or a local file.
 */
const server = new McpServer({ name: "director", version: "0.1.0" }, {
  instructions: "Director layer for Cinema Studio. Read get_guide('director') first. Flow: suggest_styles/get_style → compile_look (→ start_film) → validate_treatment (→ save_script with its markdown) → apply_style + lint_shotlist (→ save_shotlist) → build_cue_map/check_cue_map → plan_batch (→ generate_take) → check_timeline/to_studio_timeline (→ save_timeline) → assemble_local for J/L cuts, titles, narration.",
});

const text = (x: unknown) => ({ content: [{ type: "text" as const, text: typeof x === "string" ? x : JSON.stringify(x, null, 2) }] });
const docsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");

server.registerTool("get_guide", {
  description: "The director guides: 'director' (judgement: brief, treatment, story, sound, rhythm, camera, delivery), 'technique' (the H3 constraints: modes, links, frame grid, base models, what the assembler can do), 'styles' (the style index).",
  inputSchema: { section: z.enum(["director", "technique", "styles"]).default("director") },
}, async ({ section }) => {
  const file = section === "styles" ? join(dirname(fileURLToPath(import.meta.url)), "..", "styles", "README.md") : join(docsDir, section === "director" ? "DIRECTOR.md" : "TECHNIQUE-H3.md");
  return text(existsSync(file) ? readFileSync(file, "utf8") : `missing ${file}`);
});

server.registerTool("list_styles", {
  description: "Every style preset (user styles first, then the library): slug, names, category, uses, one line.",
  inputSchema: {},
}, async () => text(loadStyles().map(({ style: s, origin }) => ({ slug: s.slug, en: s.en, cn: s.cn, category: s.category, uses: s.uses, line: s.line, line_cn: s.line_cn, origin }))));

server.registerTool("suggest_styles", {
  description: "Two or three styles that fit a topic, with why. Then ask the user to pick by name.",
  inputSchema: { topic: z.string().min(2), n: z.number().int().min(1).max(5).default(3) },
}, async ({ topic, n }) => text(suggestStyles(topic, n).map((r) => ({ slug: r.style.slug, en: r.style.en, cn: r.style.cn, score: r.score, why: r.why, line: r.style.line }))));

server.registerTool("get_style", {
  description: "One style preset in full: as JSON (the compiled engine fields, camera grammar, native moves, pitfalls, variation space) or as STYLE.md.",
  inputSchema: { style: z.string().min(1).describe("slug, English or Chinese name"), format: z.enum(["json", "markdown"]).default("markdown") },
}, async ({ style, format }) => {
  const s = findStyle(style);
  if (!s) return text({ error: `no style matches "${style}"`, available: loadStyles().map((x) => x.style.slug) });
  return text(format === "json" ? s.style : styleToMarkdown(s.style));
});

server.registerTool("compile_look", {
  description: "Style → the `look` object for start_film / update_look (genre, palette, camera, lens, lighting, negatives, LoRAs). Pass the project's speed LoRAs in `loras`.",
  inputSchema: {
    style: z.string().min(1),
    aspectRatio: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional(),
    negative: z.array(z.string().max(80)).optional().describe("extra negatives from the brief"),
    loras: z.array(z.object({ id: z.string(), strength: z.number().min(0).max(2).optional() })).optional(),
    genreSuffix: z.string().max(80).optional(),
    paletteSuffix: z.string().max(80).optional(),
  },
}, async ({ style, ...o }) => {
  const s = findStyle(style);
  if (!s) return text({ error: `no style matches "${style}"` });
  return text({ look: compileLook(s.style, o), beatSuffix: s.style.engine.beatSuffix, cinematographyDefaults: s.style.engine.cinematography, allowedCameraMoves: s.style.camera.grammar.map((g) => g.move), transitions: s.style.camera.transitions });
});

const ShotlistSchema = z.object({ scenes: z.array(z.object({ slug: z.string(), summary: z.string().optional(), location: z.string().optional(), shots: z.array(z.any()) })) });

server.registerTool("apply_style", {
  description: "Fill every shot's cinematography with the style defaults (explicit values win), append the style's beat suffix, default ambience/music, and warn about camera moves and links outside the style's grammar. Returns the shotlist to pass to save_shotlist.",
  inputSchema: { style: z.string().min(1), shotlist: ShotlistSchema, beatSuffix: z.boolean().default(true), musicForShotsWithScore: z.boolean().default(true) },
}, async ({ style, shotlist, beatSuffix, musicForShotsWithScore }) => {
  const s = findStyle(style);
  if (!s) return text({ error: `no style matches "${style}"` });
  return text(applyStyle(s.style, shotlist as any, { beatSuffix, musicForShotsWithScore }));
});

server.registerTool("lint_shotlist", {
  description: "Deterministic rhythm and craft lint on a shotlist in save_shotlist shape: pace and framing variety, a breath, static use, runs of the same link, dialogue density, beats tiling, link/mode sanity, render-order switches. Run before save_shotlist and fix the errors and warnings.",
  inputSchema: { shotlist: ShotlistSchema, totalSeconds: z.number().int().optional(), errorsAndWarningsOnly: z.boolean().default(false) },
}, async ({ shotlist, totalSeconds, errorsAndWarningsOnly }) => text(lintShotlist(shotlist as any, { totalSeconds, errorsAndWarningsOnly })));

server.registerTool("validate_treatment", {
  description: "Check a treatment (logline, arc, three candidate structures and the chosen one, benchmark learn/don't, hook ≤ 3 s, ending echo, signature shot, native move, sequences with pace, sound design table, silences, J/L cuts). Returns warnings and TREATMENT.md to put in save_script.",
  inputSchema: { treatment: z.any(), style: z.string().optional() },
}, async ({ treatment, style }) => {
  const s = style ? findStyle(style) : undefined;
  const r = validateTreatment(treatment, s?.style.nativeMoves.map((m) => m.name));
  return text({ ...r, markdown: r.ok ? treatmentToMarkdown(treatment) : undefined });
});

const CueMapSchema = z.object({
  sections: z.array(z.object({ id: z.string(), t: z.number().min(0), bpm: z.number(), beatsPerBar: z.number().int().optional(), texture: z.string().optional() })).min(1),
  hits: z.array(z.object({ id: z.string(), section: z.string(), bar: z.number(), beat: z.number(), what: z.string() })).default([]),
  silences: z.array(z.object({ t: z.number(), durationS: z.number(), why: z.string() })).optional(),
});

server.registerTool("check_cue_map", {
  description: "Validate a cue map (tempo sections, hit points as section/bar/beat, silences) and resolve every hit to seconds; with a shotlist, warn when hits land at shot seams.",
  inputSchema: { cueMap: CueMapSchema, shotlist: ShotlistSchema.optional(), totalSeconds: z.number().optional() },
}, async ({ cueMap, shotlist, totalSeconds }) => text({ warnings: checkCueMap(cueMap as CueMap, shotlist as any, totalSeconds), hits: hitTimes(cueMap as CueMap) }));

server.registerTool("cut_on_beats", {
  description: "Given a cue map and the shots in order, compute per-clip outS so every cut lands on the grid (subdivision 1 = beat, 0.25 = bar in 4/4, 2 = half beat) within each take's renderable length.",
  inputSchema: { cueMap: CueMapSchema, shots: z.array(z.object({ durationS: z.number() })), subdivision: z.number().default(1), startS: z.number().default(0) },
}, async ({ cueMap, shots, subdivision, startS }) => text(cutOnBeats(cueMap as CueMap, shots, { subdivision, startS })));

server.registerTool("check_subtitles", {
  description: "Reading-time check for subtitle/narration lines (CJK ÷ 4.5 + Latin ÷ 15 + 1.5 s, ≥ 1.8 s, ≥ speech + 0.6 s). Places unplaced lines in order. Returns issues, placed lines and the SRT.",
  inputSchema: { lines: z.array(z.object({ id: z.string(), text: z.string(), t0: z.number().optional(), t1: z.number().optional(), language: z.string().optional(), speechS: z.number().optional() })), startS: z.number().default(0), gapS: z.number().default(0.3) },
}, async ({ lines, startS, gapS }) => {
  const placed = placeLines(lines as Line[], startS, gapS);
  return text({ issues: checkLines(placed), lines: placed, srt: toSrt(placed), speech: placed.map((l) => ({ id: l.id, say: spellNumbersForSpeech(l.text) })) });
});

server.registerTool("synthesize_narration", {
  description: "Render narration lines to audio files with edge-tts (Microsoft neural voices; needs `pip install edge-tts` and network) or macOS `say`. Returns files and measured durations for the timeline's narration track.",
  inputSchema: { lines: z.array(z.object({ id: z.string(), text: z.string() })), outDir: z.string(), engine: z.enum(["edge-tts", "say"]).default("edge-tts"), voice: z.string().optional(), rate: z.string().optional() },
}, async ({ lines, outDir, engine, voice, rate }) => {
  try { return text(await synthesize(lines as Line[], { outDir, engine, voice, rate })); } catch (e) { return text({ error: (e as Error).message }); }
});

server.registerTool("plan_batch", {
  description: "Order takes to render: R2VA shots first, then the fl2va family; linked shots after their anchors (passes); one total estimate against the budget cap so a single confirmation covers the batch.",
  inputSchema: {
    shots: z.array(z.object({ shotId: z.string(), index: z.number().int(), durationS: z.number(), mode: z.enum(["text", "keyframe", "reference", "edit"]), link: z.object({ type: z.string(), anchor: z.number().optional(), anchorShotId: z.string().optional() }).optional(), hasTake: z.boolean().optional(), estimateUsd: z.number().optional() })),
    capUsd: z.number(), spentUsd: z.number().default(0), perSecondUsd: z.number().optional(), takesPerShot: z.number().int().min(1).max(4).default(1), onlyMissing: z.boolean().default(true),
  },
}, async ({ shots, capUsd, spentUsd, perSecondUsd, takesPerShot, onlyMissing }) => text(planBatch(shots as BatchShot[], { capUsd, spentUsd }, { perSecondUsd, takesPerShot, onlyMissing })));

const ExtTimelineSchema = z.any();

server.registerTool("check_timeline", {
  description: "Validate an extended timeline (clips with J/L cuts, transitions, freezes; titles; narration; music; silences) and return the Studio-shaped timeline for save_timeline plus what only the local assembler will render.",
  inputSchema: { timeline: ExtTimelineSchema },
}, async ({ timeline }) => text({ warnings: checkTimeline(timeline as ExtTimeline), ...toStudioTimeline(timeline as ExtTimeline) }));

server.registerTool("assemble_local", {
  description: "Assemble the extended timeline with ffmpeg from downloaded take files: dissolves, fades, iris, wipes, J/L cuts, freezes, title cards and captions, narration, music with ducking, silences, burned subtitles, loudnorm −14 LUFS. dryRun returns the command.",
  inputSchema: { timeline: ExtTimelineSchema, out: z.string(), dryRun: z.boolean().default(false), fontFile: z.string().optional() },
}, async ({ timeline, out, dryRun, fontFile }) => {
  try { return text(await assemble(timeline as ExtTimeline, { out, dryRun, fontFile })); } catch (e) { return text({ error: (e as Error).message }); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
