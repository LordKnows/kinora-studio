import { test } from "node:test";
import assert from "node:assert/strict";
import { loadStyles, findStyle, suggestStyles } from "../styles/index.js";
import { styleToMarkdown } from "../styles/markdown.js";
import { compileLook, applyStyle } from "../compile/look.js";
import { validateTreatment, treatmentToMarkdown } from "../treatment.js";
import { lintShotlist, hasBreath } from "../lint/shotlist.js";
import { beatTime, cutOnBeats, checkCueMap, snapToGrid, type CueMap } from "../sound/cuemap.js";
import { checkTimeline, toStudioTimeline, totalSeconds, type ExtTimeline } from "../timeline/extended.js";
import { buildCommand } from "../timeline/assemble.js";
import { readingTimeS, checkLines, placeLines, toSrt, spellNumbersForSpeech } from "../narration/srt.js";
import { planBatch, fallbackEstimateUsd } from "../batch.js";
import { effectiveSeconds, h3Frames } from "../catalog.js";
import { forkGuide, forkStyle, diffStyle, checkFork, changesToMarkdown } from "../styles/fork.js";
import { StyleSchema } from "../styles/schema.js";
import type { Shotlist } from "../types.js";

test("every library style parses and renders markdown with 11 sections", () => {
  const styles = loadStyles();
  assert.ok(styles.length >= 16);
  for (const { style } of styles) {
    const md = styleToMarkdown(style);
    for (let i = 1; i <= 11; i++) assert.match(md, new RegExp(`\\n## ${i}\\. `), `${style.slug} missing section ${i}`);
    assert.ok(style.engine.look.genre.length <= 200);
    assert.ok(style.engine.negative.length <= 7);
  }
});

test("findStyle by slug, English and Chinese", () => {
  assert.equal(findStyle("ink-wash")?.style.slug, "ink-wash");
  assert.equal(findStyle("Chinese Ink Wash")?.style.slug, "ink-wash");
  assert.equal(findStyle("中国水墨")?.style.slug, "ink-wash");
  assert.ok(suggestStyles("a product launch for a glass speaker")[0].style.slug === "glass-product");
});

test("compileLook merges negatives, keeps the Studio limits and appends style LoRAs", () => {
  const s = findStyle("ink-wash")!.style;
  const look = compileLook(s, { negative: ["no cars", "no outlines"], loras: [{ id: "lora_h3_turbo_fl2v" }], aspectRatio: "9:16" });
  assert.equal(look.aspectRatio, "9:16");
  assert.equal(look.resolution, "768p");
  assert.ok(look.negative!.length <= 10);
  assert.equal(new Set(look.negative).size, look.negative!.length);
  assert.ok(look.negative!.includes("no cars"));
  assert.equal(look.loras![0].id, "lora_h3_turbo_fl2v");
  for (const k of ["genre", "palette", "camera", "lens", "lighting"] as const) assert.ok(look[k]!.length <= 200);
});

const sample = (): Shotlist => ({
  scenes: [
    { slug: "open", shots: [
      { durationS: 10, mode: "reference", intent: "Establish the scroll and the traveller.", beats: [{ from: 0, to: 10, action: "A traveller walks along a riverbank; the mist thins" }], camera: { move: "pan" }, characters: ["ele_a"], link: { type: "cut" }, cinematography: { size: "els" } },
      { durationS: 12, mode: "keyframe", intent: "The traveller pauses.", beats: [{ from: 0, to: 6, action: "The traveller stops and looks at the water" }, { from: 6, to: 12, action: "A fish leaps; one ripple" }], camera: { move: "static" }, link: { type: "continuous" }, cinematography: { size: "ms", pace: "still" } },
    ] },
    { slug: "turn", shots: [
      { durationS: 5, mode: "text", intent: "A dry stroke.", beats: [{ from: 0, to: 5, action: "One fast stroke crosses the frame" }], camera: { move: "static" }, link: { type: "montage" }, cinematography: { size: "ecu", pace: "frantic" } },
      { durationS: 8, mode: "keyframe", intent: "Return.", beats: [{ from: 0, to: 8, action: "Time has passed; the traveller is further along, the mist returns" }], camera: { move: "pull_out" }, link: { type: "jump_cut" }, cinematography: { size: "ls", pace: "slow" } },
    ] },
    { slug: "close", shots: [
      { durationS: 10, mode: "keyframe", intent: "The seal.", beats: [{ from: 0, to: 10, action: "The figure becomes a dot; a vermilion seal is stamped" }], camera: { move: "tilt" }, link: { type: "continuous" }, cinematography: { size: "cu" } },
      { durationS: 15, mode: "keyframe", intent: "Breath.", beats: [{ from: 0, to: 15, action: "Empty paper; mist drifts" }], camera: { move: "push_in" }, link: { type: "bridge" }, cinematography: { size: "els", pace: "still" } },
    ] },
  ],
});

test("applyStyle fills cinematography, beat suffix and sound, and warns off-grammar moves", () => {
  const s = findStyle("ink-wash")!.style;
  const { shotlist, warnings } = applyStyle(s, sample());
  const first = shotlist.scenes[0].shots[0];
  assert.equal(first.cinematography?.animation, "inkwash");
  assert.equal(first.cinematography?.size, "els");
  assert.equal(first.cinematography?.lens, "wide"); // bySize els override
  assert.equal(first.cinematography?.pace, "still");
  assert.ok(first.beats[0].action.endsWith("Everything is brushed ink on rice paper; most of the frame stays empty paper."));
  assert.equal(first.sound?.music, "N/A");
  assert.ok(first.sound?.ambience);
  assert.equal(first.camera.note, "right to left, handscroll speed");
  // sample is untouched
  assert.equal(sample().scenes[0].shots[0].cinematography?.animation, undefined);
  assert.ok(!warnings.some((w) => w.severity === "error"));
  const off = sample(); off.scenes[0].shots[0].camera.move = "handheld";
  assert.ok(applyStyle(s, off).warnings.some((w) => w.code === "camera.offstyle"));
});

test("lintShotlist flags beats that do not tile, missing links, flat rhythm and anchors", () => {
  const list = sample();
  const w = lintShotlist(list, { totalSeconds: 60 });
  assert.ok(!w.some((x) => x.severity === "error"), JSON.stringify(w));
  assert.ok(w.some((x) => x.code === "rhythm.sizes") === false); // 6 sizes
  const bad = sample();
  bad.scenes[0].shots[0].beats = [{ from: 0, to: 8, action: "too short" }];
  bad.scenes[0].shots[0].link = { type: "continuous" };
  delete bad.scenes[1].shots[0].link;
  const wb = lintShotlist(bad);
  assert.ok(wb.some((x) => x.code === "beats.tile"));
  assert.ok(wb.some((x) => x.code === "link.anchor"));
  assert.ok(wb.some((x) => x.code === "link.missing"));
  const flat: Shotlist = { scenes: [{ slug: "a", shots: Array.from({ length: 6 }, () => ({ durationS: 5, mode: "text" as const, intent: "same thing", beats: [{ from: 0, to: 5, action: "nothing much" }], camera: { move: "push_in" as const }, link: { type: "cut" as const }, cinematography: { size: "ms" as const, pace: "steady" as const } })) }] };
  const wf = lintShotlist(flat, { totalSeconds: 30 });
  for (const code of ["rhythm.pace", "rhythm.sizes", "rhythm.moves", "rhythm.breath", "rhythm.durations", "rhythm.static"]) assert.ok(wf.some((x) => x.code === code), code);
});

test("treatment validation and markdown", () => {
  const t = {
    title: "The Ferry", style: "ink-wash", totalSeconds: 60,
    logline: "A ferryman crosses the same river every day until the day the river crosses him.",
    arc: { setup: "The ferryman's routine", turn: "The river floods", ending: "He crosses on foot" },
    candidates: [{ name: "journey", shape: "one crossing seen whole" }, { name: "before-after", shape: "the river before and after the flood" }, { name: "list", shape: "five passengers, the last is the river" }],
    chosen: "journey", whyChosen: "The crossing is the native handscroll move.",
    benchmark: [{ work: "Song landscape scrolls", learn: "value order", dontLearn: "any composition" }],
    hook: { description: "an oar breaks the mist", atSecond: 1 }, endingEcho: "the oar laid on the far bank",
    signatureShot: "a 45 s handscroll pan", nativeMove: "The handscroll",
    sequences: [{ name: "dawn", seconds: 15, purpose: "routine", pace: "slow" }, { name: "flood", seconds: 25, purpose: "the turn", pace: "frantic" }, { name: "bank", seconds: 20, purpose: "release", pace: "still" }],
    soundDesign: [{ sequence: "dawn", ambience: "water", foley: "oar", music: "guqin" }, { sequence: "flood", ambience: "roar", foley: "splash", music: "drum" }, { sequence: "bank", ambience: "wind", foley: "steps", music: "silence then one pluck" }],
    silences: [{ atSecond: 14, why: "before the flood" }, { atSecond: 40, why: "before the bank" }],
    audioBridges: [{ atSecond: 15, kind: "j_cut", what: "the roar arrives early" }, { atSecond: 40, kind: "l_cut", what: "water trails into the bank" }],
  };
  const s = findStyle("ink-wash")!.style;
  const r = validateTreatment(t, s.nativeMoves.map((m) => m.name));
  assert.equal(r.ok, true, JSON.stringify(r.warnings));
  assert.ok(!r.warnings.some((w) => w.severity !== "info"), JSON.stringify(r.warnings));
  assert.match(treatmentToMarkdown(t as any), /## Candidate structures/);
  const bad = { ...t, chosen: "nope", hook: { description: "an oar breaks the mist", atSecond: 6 }, sequences: t.sequences.map((x) => ({ ...x, pace: "steady" })), silences: [], audioBridges: [] };
  const rb = validateTreatment(bad);
  assert.equal(rb.ok, false);
  for (const code of ["treatment.chosen", "treatment.hook", "treatment.pace", "treatment.breath", "treatment.silence", "treatment.bridges"]) assert.ok(rb.warnings.some((w) => w.code === code), code);
});

test("cue map: beat times, snapping and cutting on beats", () => {
  const map: CueMap = { sections: [{ id: "a", t: 0, bpm: 120 }, { id: "b", t: 16, bpm: 60 }], hits: [{ id: "h1", section: "a", bar: 3, beat: 1, what: "door" }, { id: "h2", section: "b", bar: 2, beat: 3, what: "stop" }], silences: [{ t: 15, durationS: 1, why: "x" }, { t: 30, durationS: 1, why: "y" }] };
  assert.equal(beatTime(map, "a", 3, 1), 4);
  assert.equal(beatTime(map, "b", 2, 3), 16 + 6);
  assert.equal(snapToGrid(map, 4.3), 4.5);
  assert.equal(snapToGrid(map, 17.2), 17);
  const cuts = cutOnBeats(map, [{ durationS: 10 }, { durationS: 5 }, { durationS: 15 }], { subdivision: 0.25 });
  assert.equal(cuts[0].cutAtS, 10); // bar at 120 bpm = 2 s
  assert.ok(cuts[1].outS <= 5.2 && cuts[1].outS >= 2);
  assert.ok(cuts[2].outS <= 15.1);
  const w = checkCueMap(map, undefined, 60);
  assert.ok(!w.some((x) => x.severity === "error"));
});

test("subtitles: reading time, placement, srt, numbers", () => {
  assert.equal(readingTimeS("Hi"), 1.8);
  assert.ok(Math.abs(readingTimeS("一二三四五六七八九") - (9 / 4.5 + 1.5)) < 1e-9);
  const placed = placeLines([{ id: "1", text: "The river rose twelve metres", speechS: 3 }, { id: "2", text: "十二米" }]);
  assert.ok(placed[0].t1! - placed[0].t0! >= 3.6);
  assert.equal(checkLines(placed).length, 0);
  assert.match(toSrt(placed), /^1\n00:00:00,000 --> /);
  assert.equal(spellNumbersForSpeech("12 metres in 1927"), "twelve metres in one thousand nine hundred and twenty-seven");
  assert.ok(checkLines([{ id: "x", text: "A long sentence that needs a while to read", t0: 0, t1: 1 }]).length === 1);
});

test("extended timeline: studio projection, totals, checks and ffmpeg graph", () => {
  const t: ExtTimeline = {
    clips: [
      { shotId: "s1", takeId: "t1", outS: 10, file: "a.mp4" },
      { shotId: "s2", takeId: "t2", inS: 1.2, outS: 5, file: "b.mp4", transition: "iris", transitionS: 0.5, audioLeadS: 1, freezeS: 0 },
      { shotId: "s3", takeId: "t3", outS: 15, file: "c.mp4", transition: "dissolve", transitionS: 0.4, audioTrailS: 0.8, repeat: 1 },
    ],
    titles: [{ text: "Meanwhile", t: 10, durationS: 3, kind: "card" }, { text: "1927", t: 2, durationS: 2, kind: "caption" }],
    music: { file: "m.mp3", gainDb: -12, fadeOutS: 2 },
    narration: [{ file: "n1.mp3", t: 1 }, { file: "n2.mp3", assetId: "ast_voice", t: 12, gainDb: -2 }],
    silences: [{ t: 9, durationS: 1 }, { t: 20, durationS: 1 }],
    fadeOutS: 1,
    lufs: -16,
  };
  // the Studio's assembler draws and mixes nearly all of it now
  const { timeline, dropped } = toStudioTimeline(t);
  assert.equal(timeline.clips[1].transition, "iris");
  assert.equal(timeline.clips[1].audioLeadS, 1);
  assert.equal(timeline.clips[2].transition, "dissolve");
  assert.equal(timeline.clips[2].transitionS, 0.4);
  assert.equal(timeline.clips[2].audioTrailS, 0.8);
  assert.deepEqual(timeline.titles, [{ text: "Meanwhile", atS: 10, durationS: 3, kind: "card" }, { text: "1927", atS: 2, durationS: 2, kind: "caption" }]);
  assert.deepEqual(timeline.narration, [{ assetId: "ast_voice", atS: 12, gainDb: -2 }]);
  assert.deepEqual(timeline.silences, [{ atS: 9, durationS: 1 }, { atS: 20, durationS: 1 }]);
  assert.equal(timeline.fadeOutS, 1);
  assert.equal(timeline.loudnessLufs, -16);
  // what cannot go along is said: the narration line that is only a file
  assert.deepEqual(dropped.map((d) => d.code), ["studio.narration"]);
  const flash = toStudioTimeline({ clips: [{ shotId: "a", takeId: "a", outS: 5 }, { shotId: "b", takeId: "b", outS: 5, transition: "flash_white", transitionS: 0.8 }] });
  assert.equal(flash.timeline.clips[1].transition, "fade_white");
  assert.equal(flash.timeline.clips[1].transitionS, 0.3);
  assert.ok(Math.abs(totalSeconds(t) - (10 + 3.8 + 15 - 0.5 - 0.4)) < 1e-9);
  assert.ok(!checkTimeline(t).some((w) => w.severity === "error" || w.code === "clip.jl.lead"));
  const cmd = buildCommand(t, { out: "/tmp/x.mp4", dryRun: true });
  assert.match(cmd.filterGraph, /xfade=transition=circleopen/);
  assert.match(cmd.filterGraph, /xfade=transition=fade:duration=0.4/);
  assert.match(cmd.filterGraph, /adelay=8500\|8500/); // s2 starts at 9.5 (iris overlap), audio leads by 1 s
  assert.match(cmd.filterGraph, /\[1:a\]atrim=start=0\.2:end=5,/); // and that second is the take's own sound before inS
  // a clip that starts on its take's first frame has nothing to lead with: said, and the sound stays put
  const none: ExtTimeline = { clips: [{ shotId: "s1", takeId: "t1", outS: 10, file: "a.mp4" }, { shotId: "s2", takeId: "t2", outS: 5, file: "b.mp4", audioLeadS: 1 }] };
  assert.ok(checkTimeline(none).some((w) => w.code === "clip.jl.lead"));
  const flat = buildCommand(none, { out: "/tmp/y.mp4", dryRun: true });
  assert.match(flat.filterGraph, /\[1:a\]atrim=start=0:end=5,.*adelay=10000\|10000/);
  assert.match(cmd.filterGraph, /drawbox=.*Meanwhile|Meanwhile/);
  assert.match(cmd.filterGraph, /loudnorm=I=-16/);
  assert.ok(cmd.args.includes("-filter_complex"));
});

test("batch planning: R2VA first, anchors wait, cap check", () => {
  const plan = planBatch([
    { shotId: "a", index: 0, durationS: 10, mode: "reference", link: { type: "cut" } },
    { shotId: "b", index: 1, durationS: 10, mode: "keyframe", link: { type: "continuous" } },
    { shotId: "c", index: 2, durationS: 5, mode: "text", link: { type: "montage" } },
    { shotId: "d", index: 3, durationS: 10, mode: "reference", link: { type: "match_cut" } },
    { shotId: "e", index: 4, durationS: 10, mode: "keyframe", link: { type: "insert_return", anchorShotId: "b" } },
  ], { capUsd: 10, spentUsd: 9.5 }, { perSecondUsd: 0.05 });
  assert.deepEqual(plan.passes[0], ["a", "c"]);
  assert.ok(plan.passes[1].includes("b") && plan.passes[1].includes("d"));
  assert.deepEqual(plan.passes[2], ["e"]);
  assert.equal(plan.deferred.length, 0);
  assert.equal(plan.withinCap, false);
  assert.equal(plan.groups[0].baseModel, "ref2va");
});

test("length rules: long action shots warn, holds and continuous chains count as a breath", () => {
  const list = sample();
  const w = lintShotlist(list, { totalSeconds: 60 });
  // the 12 s two-beat shot in the sample is an action shot
  assert.ok(w.some((x) => x.code === "duration.complex" && x.shot === 1), JSON.stringify(w));
  // the 15 s calm one-beat push_in over mist is a breath; shorten it and it is not
  const shots = list.scenes.flatMap((sc) => sc.shots);
  assert.equal(hasBreath(shots), true);
  shots[5].durationS = 8; shots[5].beats = [{ from: 0, to: 8, action: "mist" }];
  shots[1].beats = [{ from: 0, to: 6, action: "a" }, { from: 6, to: 12, action: "b" }];
  assert.equal(hasBreath(shots), false);
  // chain of two calm 5 s continuous shots counts
  const chain = [
    { durationS: 5, mode: "text", intent: "a", beats: [{ from: 0, to: 5, action: "mist" }], camera: { move: "pan" }, link: { type: "cut" }, cinematography: { pace: "still" } },
    { durationS: 5, mode: "keyframe", intent: "b", beats: [{ from: 0, to: 5, action: "mist" }], camera: { move: "pan" }, link: { type: "continuous" }, cinematography: { pace: "slow" } },
  ] as any;
  assert.equal(hasBreath(chain), true);
  chain[0].cinematography.pace = "brisk";
  assert.equal(hasBreath(chain), false);
  chain[0].cinematography.pace = "still";
  chain[1].link = { type: "cut" };
  assert.equal(hasBreath(chain), false);
  const s = findStyle("ink-wash")!.style;
  const { warnings } = applyStyle(s, list);
  assert.ok(warnings.some((x) => x.code === "duration.style" && x.shot === 1));
  assert.equal(s.engine.durations.action, 5);
});

test("batch estimates: compile_prompt values win, fallback curve otherwise", () => {
  // linear in the rendered length: 243 frames for 10 s, 294 for 12 s
  assert.ok(Math.abs(fallbackEstimateUsd(10, 0.01) - (243 / 24) * 0.01) < 1e-12);
  assert.ok(Math.abs(fallbackEstimateUsd(12, 0.01) - (294 / 24) * 0.01) < 1e-12);
  assert.ok(fallbackEstimateUsd(12, 0.01) / fallbackEstimateUsd(10, 0.01) < 1.25);
  const plan = planBatch([
    { shotId: "a", index: 0, durationS: 10, mode: "text", link: { type: "cut" }, estimateUsd: 0.105 },
    { shotId: "b", index: 1, durationS: 12, mode: "text", link: { type: "cut" } },
  ], { capUsd: 5, spentUsd: 0 }, { perSecondUsd: 0.01 });
  assert.equal(plan.estimates[0].source, "compile_prompt");
  assert.equal(plan.estimates[1].source, "fallback");
  assert.equal(plan.warnings.length, 1);
  assert.ok(Math.abs(plan.estimates[1].usd - 0.1225) <= 0.0006);
  assert.ok(Math.abs(plan.totalEstimateUsd - (0.105 + plan.estimates[1].usd)) < 1e-9);
});

test("craft lint: dead frame, axis across the cut, unison reactions", () => {
  const base = { durationS: 5, mode: "text" as const, intent: "x", camera: { move: "static" as const }, characters: ["a"] };
  const list: Shotlist = { scenes: [{ slug: "s", shots: [
    { ...base, motion: [], beats: [{ from: 0, to: 5, action: "Everyone looks up at the same time" }], blocking: [{ who: "a", from: "off_left", to: "off_right" }] },
    { ...base, motion: ["subject"], beats: [{ from: 0, to: 5, action: "She walks on toward frame left" }], blocking: [{ who: "a", from: "right", to: "left" }] },
  ] }] };
  const codes = lintShotlist(list).map((w) => w.code);
  for (const c of ["motion.dead", "performance.simultaneous", "blocking.axis"]) assert.ok(codes.includes(c), `missing ${c}`);
  assert.ok(!codes.includes("wording.direction"), "frame-anchored direction is fine");
});

test("local assembly: speed shortens the clip, BT.601 sources convert to tagged BT.709", () => {
  const t: ExtTimeline = { clips: [{ shotId: "a", takeId: "t", file: "/a.mp4", inS: 0, outS: 4, speed: 2 }, { shotId: "b", takeId: "u", file: "/b.mp4", inS: 0, outS: 2, sourceMatrix: "bt709" }] };
  assert.equal(totalSeconds(t), 4);
  const cmd = buildCommand(t, { out: "/tmp/x.mp4", dryRun: true });
  assert.match(cmd.filterGraph, /setpts=\(PTS-STARTPTS\)\/2,colorspace=all=bt709:iall=bt601-6-525/);
  assert.match(cmd.filterGraph, /setparams=colorspace=bt709/);
  assert.match(cmd.filterGraph, /atempo=2/);
  assert.ok(cmd.args.join(" ").includes("-colorspace bt709 -color_primaries bt709 -color_trc bt709"));
});

test("treatment markdown fills schema defaults for a minimal valid treatment", () => {
  const md = treatmentToMarkdown({ title: "T", style: "s", totalSeconds: 10, logline: "a logline long enough", arc: { setup: "setup", turn: "turnn", ending: "endin" }, candidates: [], chosen: "", whyChosen: "", benchmark: [], hook: { description: "hook!", atSecond: 1 }, endingEcho: "", signatureShot: "", nativeMove: "", sequences: [], soundDesign: [] } as never);
  assert.match(md, /# T/);
});

test("frame grid: 17k+5 frames at 24 fps, nearest, clamped to 124–362", () => {
  const frames: Record<number, number> = { 5: 124, 6: 141, 7: 175, 8: 192, 9: 209, 10: 243, 11: 260, 12: 294, 13: 311, 14: 328, 15: 362 };
  for (const [s, f] of Object.entries(frames)) {
    assert.equal(h3Frames(Number(s)), f, `${s} s`);
    assert.equal((h3Frames(Number(s)) - 5) % 17, 0);
    assert.equal(effectiveSeconds(Number(s)), f / 24);
  }
  assert.equal(h3Frames(1), 124);
  assert.equal(h3Frames(60), 362);
  // a take can be shorter than the shot asks: the cue map must not cut past it
  assert.ok(effectiveSeconds(6) < 6 && effectiveSeconds(9) < 9 && effectiveSeconds(14) < 14);
  const map: CueMap = { sections: [{ id: "a", t: 0, bpm: 60 }], hits: [] };
  for (const d of [6, 9, 11, 13, 14]) {
    const [cut] = cutOnBeats(map, [{ durationS: d }], { subdivision: 4 });
    assert.ok(cut.outS <= effectiveSeconds(d) + 1e-9, `${d} s cut at ${cut.outS}`);
  }
});

test("a style of your own: three groups, a fork, what changed and what it costs", () => {
  const base = findStyle("ink-wash")!.style;
  const guide = forkGuide(base);
  assert.deepEqual(guide.map((g) => g.group), ["safe", "character", "essence"]);
  assert.ok(guide[0].sections.some((x) => x.section === "§7 sound palette"));
  assert.ok(guide[1].sections.some((x) => x.section === "§6 camera grammar"));
  assert.deepEqual(guide[2].sections.map((x) => x.section), ["§1 essence"]);

  const mine = forkStyle(base, { slug: "night-ink", en: "Night Ink", cn: "夜墨" });
  assert.equal(mine.lineage, "Based on Chinese Ink Wash (ink-wash).");
  assert.equal(base.slug, "ink-wash"); // the base is not touched
  const taken = { library: ["ink-wash", "watercolor"], others: ["their-style"] };
  assert.ok(checkFork(base, mine, taken).warnings.some((w) => w.code === "style.same"));

  // a safe change: the palette, and the Look that carries it to the model
  mine.colour.examplePalette = "paper #101418, ink #e8e2d2, vermilion #d8402c";
  mine.engine.look.palette = "pale ink on blue-black paper, one vermilion seal red, no other colour";
  mine.sound.instruments = ["guqin", "a low synth drone"];
  let r = checkFork(base, StyleSchema.parse(mine), taken);
  assert.deepEqual(r.changes.map((c) => [c.section, c.group]), [["§3 palette", "safe"], ["§7 sound palette", "safe"]]);
  assert.ok(!r.warnings.some((w) => w.severity !== "info"), JSON.stringify(r.warnings));
  assert.match(changesToMarkdown(base, mine, r.changes), /\| §3 palette \| safe \|/);

  // a palette that never reaches the Look is caught
  const lost = structuredClone(mine); lost.engine.look.palette = base.engine.look.palette;
  assert.ok(checkFork(base, lost, taken).warnings.some((w) => w.code === "style.travel.look"));

  // character and essence are named for what they are
  mine.materials = ["Black lacquer board, gold-leaf strokes", "Raking light on raised lines"];
  mine.essence = ["Gold line on black lacquer", "Light rakes across raised strokes", "No paper anywhere"];
  mine.nativeMoves = mine.nativeMoves.slice(2);
  r = checkFork(base, mine, taken);
  for (const code of ["style.essence", "style.character", "style.signature", "style.travel.pitfalls"]) assert.ok(r.warnings.some((w) => w.code === code), code);
  assert.ok(diffStyle(base, mine, { "§2 materials": "the brand is lacquerware" }).find((c) => c.section === "§2 materials")!.why);

  // slugs
  assert.ok(checkFork(base, { ...mine, slug: "ink-wash" }, taken).warnings.some((w) => w.code === "style.slug.library"));
  assert.ok(checkFork(base, { ...mine, slug: "their-style" }, taken).warnings.some((w) => w.code === "style.slug.taken"));
  assert.ok(checkFork(undefined, { ...mine, slug: "Bad Slug" }, taken).warnings.some((w) => w.code === "style.slug"));
});
