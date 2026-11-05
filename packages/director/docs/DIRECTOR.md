# Directing a Studio film

The judgement half of the guide. The implementation half (H3 modes, links, frame grid, what the assembler can do) is `TECHNIQUE-H3.md`; the look is one `styles/<slug>/STYLE.md`. You are the director; the Studio compiles, enforces the two human checkpoints and keeps the ledger.

A film is judged in this order: **sound, rhythm, camera, directing** (performance, staging, emotional arc). Good-looking takes are only the starting point.

## 1. Take the brief

Ask once, in one message, then no more questions until a checkpoint:

- what the film is for and where it will play (decides aspect ratio and length);
- the style, by name, or let `suggest_styles` propose two or three and have the user pick;
- facts, names, products or logos that must appear; material of their own (reference images for elements, a voice, music);
- the narration language (default: the language the user writes in);
- whether they want to see a storyboard (hero frames) before takes are rendered (default: no).

Defaults: 30–60 s; 16:9; one previz take per shot; narration and subtitles in the user's language. Longer than two minutes multiplies cost: say so.

## 2. Find a benchmark first

Before writing anything, pick one or two reference works that set the bar for this style **and this topic**. Write down what to learn (composition, pacing, camera grammar, colour logic, score structure) and what not to take (characters, designs, melodies, shots, logos, fonts). References teach grammar only.

## 3. Shape the story

- **One subject, one goal, one turn.** Something wants something, something changes, it ends differently.
- **Hook in the first 3 seconds.** No slow logo reveal.
- **An ending that echoes**: bookend the opening, reveal the scale, do the thing right the second time.
- **One native move** from the style's menu (`get_style` §8) at the emotional peak.
- **Cut the extras.** One gag the audience reads at thumbnail size beats three they can't.
- **Not the demo again.** The style's variation space lists three structures, openings and endings far from the obvious; the first idea that comes to mind for a style is usually its cliché.

## 4. Write the treatment (before the shotlist)

`validate_treatment` checks it and returns TREATMENT.md for `save_script`:

1. three candidate structures, the chosen one and why;
2. logline, arc (setup → turn → ending), how the ending echoes the opening;
3. benchmark learn / don't learn;
4. hook (≤ 3 s), signature shot, native move;
5. 3–6 sequences with seconds and a pace each; the paces must vary and one must be slow or still;
6. a sound design row per sequence (ambience, foley, music state);
7. at least two silences and two audio bridges (J-cut, L-cut) for films over 30 s.

The script the user approves is this treatment plus the dialogue.

## 5. Prove the look

Elements first: every character, location and prop with a concrete description written in the style's materials (a clay figure, a paper puppet, three ink strokes). The user uploads references; hero frames are chosen on the Board. If the user asked for a storyboard, stop after hero frames and wait.

## 6. Sound is half the film

- **Every visible action has a sound**: fill `sfx` per shot from the style's foley list; match the material.
- **Three layers**: `ambience` (room, wind, city), `sfx` (tied to beats) and music. The Studio mixes the model's own audio; narration and score are added by the local assembler (`assemble_local`) with ducking.
- **At least two real silences** before the turn or the peak; the first sound after a silence is one of the most important in the film.
- **Use sound as a transition** at least twice: a J-cut (next clip's audio leads) or an L-cut (this clip's audio trails) on the extended timeline.
- **Score in the style's instruments**; "piano and strings" is a warning.

## 7. Rhythm: the music grid comes first

- Build the cue map (`check_cue_map`): tempo sections, hit points as bar and beat, silences. `cut_on_beats` turns it into clip boundaries.
- **Vary the pace**: alternate fast and slow, include one clear acceleration or deceleration, give the audience one breath (a shot ≥ 12 s at pace still or slow). `lint_shotlist` warns when every shot has the same pace, length, size or move.
- **Sequences before shots**: 3–6 sequences with a share of the running time, then 5–15 s shots inside each. Never start from N × 5 s.
- **Pace for the viewer**: hold every subtitle ≥ 1.8 s and ≥ speech + 0.6 s; a 10 s shot holds about two lines; a title card ≥ 4 s. `check_subtitles` checks this.

## 8. Camera: every shot needs a reason

- Choose moves from the style's camera grammar table; each row says what the move expresses and what content it serves. `apply_style` warns about moves outside the grammar.
- Use at least **four different camera moves** and four shot sizes; `static` is the cheapest breath and the move H3 drifts least on.
- **One signature shot** people remember: a long take chained with `continuous`, a scale reveal with `pull_out`, a transition built from the medium with `bridge`.
- **Transitions inside the medium**: the style lists the ones it allows; the assembler renders dissolve, fade to black or white, white flash, iris and wipe. Never ask the model for a transition.
- At key moments the subject fills at least a third of the frame height.

## 9. Performance

- **One primary action per beat**: start state → action → end state. Beats tile the shot exactly.
- Characters change emotion inside the shot; say so in the beat.
- Dialogue is unverified on H3: keep lines short or describe the vocal sound; put narration on the local track instead.
- Identity: open every sequence with `reference` mode and pass identity by frame inside it (`continuous`, `reverse`, `insert_return`, `bridge`).

## 10. Rendering, cost and checkpoints

- `plan_batch` orders takes (R2VA first, then the fl2va family, linked shots after their anchors) and sums one estimate against the cap: tell the user once, then confirm the batch.
- Previz at the LoRA's step count, one take per shot. Raise steps or upscale only after the user is happy.
- Review is human-only: the user cherry-picks takes on the Board. Revise with `revise_shot` and render a new take; stop after three attempts on one shot and ask.
- `approve_script` and `approve_shotlist` are web-only; when a tool answers `not_approved`, say which page to open.

## 11. Assemble and deliver

- `auto_timeline`, then the extended timeline (`check_timeline`): J/L cuts, fades, title cards, narration, music with ducking, silences, subtitles. `to_studio_timeline` keeps the Studio project valid; `assemble_local` renders the full version from the exported takes.
- Deliver: the film, the `.srt` when there is narration, `TREATMENT.md` in the script, and one line to the user on what was left for a second round.
