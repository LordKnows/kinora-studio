# Directing a Studio film

The judgement half of the guide. The implementation half (H3 modes, links, frame grid, what the assembler can do) is `TECHNIQUE-H3.md`; the look is one `styles/<slug>/STYLE.md`. You are the director; the Studio compiles, enforces the two human checkpoints and keeps the ledger.

A film is judged in this order: **sound, rhythm, camera, directing** (performance, staging, emotional arc). Good-looking takes are only the starting point.

## 1. Take the brief

Ask once, in one message, then no more questions until a checkpoint:

- what the film is for and where it will play (decides aspect ratio and length);
- the style, by name, or let `suggest_styles` propose two or three and have the user pick;
- facts, names, products or logos that must appear; material of their own (reference images for elements, a voice, music);
- the narration language (default: the language the user writes in);
- the total budget, and whether they want music and subtitles;
- whether they want to see a storyboard (hero frames) before takes are rendered (default: no).

Defaults: 30–60 s; 16:9; one previz take per shot; narration and subtitles in the user's language. Longer than two minutes multiplies cost: say so.

Record every answer with `add_requirements`, one item each in the user's words. Long sessions get summarised; the list does not.

## 2. Find a benchmark first

Before writing anything, pick one or two reference works that set the bar for this style **and this topic**. Write down what to learn (composition, pacing, camera grammar, colour logic, score structure) and what not to take (characters, designs, melodies, shots, logos, fonts). References teach grammar only.

## 3. Shape the story

- **One subject, one goal, one turn.** Something wants something, something changes, it ends differently.
- **Hook in the first 3 seconds.** No slow logo reveal.
- **An ending that echoes**: bookend the opening, reveal the scale, do the thing right the second time.
- **One native move** from the style's menu (`get_style` §8) at the emotional peak.
- **Cut the extras.** One gag the audience reads at thumbnail size beats three they can't.
- **Not the demo again.** The style's variation space lists three structures, openings and endings far from the obvious; the first idea that comes to mind for a style is usually its cliché.
- **Ask every turn the way reality would.** Why does this happen? Where does the thing come from? Is it within reach? Would it really go like this?
- **Every gag in three parts: problem → solution → the others' reaction.** Reactions are what make it read as real, and they come one after another — the father first, a beat later the grandmother, the girl last. People who react in the same second read as machine-made. Bodies flinch back when startled.
- **Write what AI video can shoot.** Its fixed weak spots: people crossing, small objects in hands, readable text, mirrors and reflections, one-sided features (a tattoo on one arm), a light change inside one shot, one person doing three things, overhead shots that hide faces, crowds. Each raises the reroll rate; leave them out of the story rather than fixing them after the take.
- **Prefer an episodic structure.** Shots that need not match each other are the safest; one continuous action across shots is where continuity breaks. Choose continuous only when the film needs it, and then lean on `continuous` / `bridge` links.
- **Then let a stranger read it.** `review_packet` (story) gives the script alone to a fresh reviewer who finds faults and edits nothing. What it does not understand is not on the page.

## 4. Write the treatment (before the shotlist)

`validate_treatment` checks it and returns TREATMENT.md for `save_script`:

1. three candidate structures, the chosen one and why;
2. logline, arc (setup → turn → ending), how the ending echoes the opening;
3. benchmark learn / don't learn;
4. hook (≤ 3 s), signature shot, native move;
5. 3–6 sequences with seconds and a pace each; the paces must vary and one must be slow or still;
6. a sound design row per sequence (ambience, foley, music state);
7. at least two silences and two audio bridges (J-cut, L-cut) for films over 30 s;
8. the turns: problem, solution, reaction, and why it can happen; and the structure (episodic or continuous).

The script the user approves is this treatment plus the dialogue.

## 5. Prove the look

Elements first: every character, location and prop with a concrete description written in the style's materials (a clay figure, a paper puppet, three ink strokes). The user uploads references; hero frames are chosen on the Board. A character is designed face first: one portrait (the user's own, or drawn) that the user approves, then its expressions and the details the genre and the character call for (at most three, off the face), then the whole figure — never the figure first and the face found inside it. If the user asked for a storyboard, stop after hero frames and wait.

## 5b. Storyboard: staging, composition, colour

The storyboard decides the film more than the plot does. Every shot says, in screen terms:

- **size, angle, move, and who goes where** (`blocking`: enters from frame left, exits frame right). Keep a character's screen direction across the cut; someone who leaves frame right comes in frame left.
- **what moves** (`motion`). At least one of: the camera, the subject, focus, light, something crossing the lens, a passer-by, weather, a prop. If nothing moves the frame is a photograph. A locked camera needs someone walking in it, far to near.
- **why the camera moves**: to follow something (a letter flying, the camera goes with it), to push in for a close-up, to pull out from a detail. Move where it means something, hold still where it does not.
- **a new angle every shot.** Straight-on eye level at most twice in the film; the rest high, low, from behind, over the shoulder, through something. No run of three shots of one size.
- **every frame a still worth keeping.** Eyes on the 38 % or 62 % line, not the centre (`composition`).
- **a colour script before the first image**: each scene's palette as hex colours (`palette`), one accent at most. In black and white the subject must still separate from the background; `sketch_board` with `gray` and `lint_project` (`palette.contrast`) check it.

With a reference film, study it frame by frame for camera positions and how much of the frame people enter and leave by; without one, these rules stand in. `sketch_board` draws the whole board from these fields before any frame exists — show it before asking for the approval.

Then the frames: write what the first and last frame show (`frames`), get it reviewed, and only then draw — with GPT Image when the user has switched it on (`plan_frames` picks the cheapest source for each frame: reuse the anchor's last frame, crop, edit a related frame, or draw new), otherwise by upload or import. Every generated picture gets a cold-reader review (stage frame) before a take is built on it. Everything the action uses is already in the first frame; whoever reacts is already there, facing the camera; people never share one pose; leave room where things land and above heads; wind blows one way. Draw the richer frame first and derive the other from it; a push-in's end frame is a crop of the first.

## 6. Sound is half the film

- **Every visible action has a sound, and no sound without a visible cause**: fill `sfx` per shot from the style's foley list; match the material.
- **Three layers**: `ambience` (room, wind, city), `sfx` (tied to beats) and music. The model renders the first two with the picture; the Studio's assembler adds the music (ducked under the clips and the narration), the narration lines and the silences, and lands the mix on −14 LUFS.
- **At least two real silences** before the turn or the peak; the first sound after a silence is one of the most important in the film.
- **Use sound as a transition** at least twice: a J-cut (`audioLeadS`: the next clip's sound leads its picture) or an L-cut (`audioTrailS`: this clip's sound runs on) on the timeline. The sound is the take's own outside the clip's in and out points, so trim the picture to leave it there.
- **Score in the style's instruments**; "piano and strings" is a warning.

## 7. Rhythm: the music grid comes first

- Build the cue map (`check_cue_map`): tempo sections, hit points as bar and beat, silences. `cut_on_beats` turns it into clip boundaries.
- **Vary the pace**: alternate fast and slow, include one clear acceleration or deceleration, give the audience one breath: a static one-beat hold of 10 s at pace still or slow, or a continuous chain of calm shots adding up to 10 s. `lint_shotlist` warns when every shot has the same pace, length, size or move.
- **Sequences before shots**: 3–6 sequences with a share of the running time, then shots inside each. Never start from N × 5 s as arithmetic; do give each shot one action and the length that action needs: 5 s for a shot that carries an action (people, dialogue, more than one beat, a brisk pace), 8 s at most; 10 s for a held one-beat frame (mist, an empty frame, a locked page); a `continuous` chain for longer action; a `loop` of one period for periodic motion. A short shot is cheaper to retake, and on the takes so far a second of video cost about 1.4 times as much GPU time in takes over 7 s as in takes under 6 s (small samples). Whether H3 holds an action better at 5 s than at 10 s has not been measured: faults turned up in 5 s takes too. `lint_shotlist` hints at long action shots (`duration.complex`); the style's `durations` guide sets the numbers. Both are defaults until the length A/B is run.
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
- Dialogue on H3: on-screen lines only, short, one beat each, in the speaker's voice-card voice; off-screen lines, inner monologue and narration go on the local track, synthesised from the same voice card.
- Identity: open every sequence with `reference` mode and pass identity by frame inside it (`continuous`, `reverse`, `insert_return`, `bridge`).
- One clip is one shot: a reaction the beat needs is staged in the first frame, or it gets its own shot.
- **Write what the model cannot misread**: screen directions, counts, unambiguous places, the cause of every movement and where the hands are; what happens rather than what must not; materials rather than "cartoon"; props with an obvious use kept out of action shots.

## 10. Rendering, cost and checkpoints

- `plan_batch` orders takes (R2VA first, then the fl2va family, linked shots after their anchors) and sums one estimate against the cap: tell the user once, then confirm the batch.
- Previz at the LoRA's step count, one take per shot. Raise steps or upscale only after the user is happy.
- Before any take: the shot review (`review_packet` stage shot → fresh reviewer → `record_review`). It checks every sentence of the prompt against the frames, the element sheets, the palette and the neighbouring shots. Most rerolls are prompt mistakes, not model failures.
- Probe first: `plan_project_batch` names the one or two most fragile shots; render those, and only then the rest.
- Review is human-only: the user cherry-picks takes on the Board and tags what went wrong. You see stills, never motion or sound: say so whenever you judge a take.
- A wrong take: trim it if the fault is at the head or tail; fix it in the edit if you can (retime, mute, freeze); a prop, wardrobe, face or background fault → Viggle Remake from one or two painted frames (the motion stays); only then revise the prompt or the frames and render a new take — never the same input again. Keep every take; a passed-over one can still give an insert. Stop after three attempts on one shot and ask.
- Out of budget: stop, `rough_cut`, and show the user the film so far.
- The script and the shotlist are the user's to approve; when a tool answers `not_approved`, say which page to open. If they switched on delegated approval (Settings → Director), `approve_script` (after a fresh reviewer passed the current text) and `approve_shotlist` (script approved, no lint errors) pass them for the user — with your reasons and confidence in the decision log, and a word to the user each time.

## 11. Assemble and deliver

- `auto_timeline`, then finish the timeline: transitions, J/L cuts, freezes, title cards and captions (the only text in the film), narration, music, silences, fades. `check_timeline` checks it in the director's shape and hands back what `save_timeline` takes; the Studio's assembler renders all of it. After `export_project`, `get_export` lists what was measured on the file and the findings nothing on the timeline explains; fix them before the film review. `assemble_local` renders the same timeline from take files on disk, for work away from the Studio.
- Before delivery a stranger watches it (`review_packet` stage film): the story it understood, what it did not, then shot by shot — repeated actions, prop counts, continuity, jumps and colour breaks at cuts (the export's cut sheet shows 3 frames each side), faces and hands — and what it could not check.
- Deliver: the film, the `.srt` when there is narration, `TREATMENT.md` in the script, `get_retro` (what went wrong, which wording fixed it, which fragile pictures to avoid next time), and one line to the user on what was left for a second round.
