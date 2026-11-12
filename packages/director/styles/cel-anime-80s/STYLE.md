# 80s Cel Anime · 80 年代赛璐璐动画 — Style Prompt

> Painted backgrounds, flat hard-shadow cels, light glowing through the frame, played back from tape.
> 手绘背景、硬阴影赛璐璐、透过画面的光，从录像带回放。

<!-- generated from style.json by @openhiggsfield/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Cartoon & Anime · 卡通与动画  
**Uses:** Music videos · Game and tech trailers · Nostalgia · City-at-night stories

## 1. Essence, and what it is not

- Four layers in contrast: airbrushed painted background, flat cel with hard-edged shadow, backlit glow, VHS playback.
- Outlines are coloured, never pure black; shadows are one hard shape per form.
- Characters step at 12 fps while the camera and light move smoothly.
- Night cities, wet streets, neon reflections and window gold.
- Stillness as drama: a held close-up with a light band sweeping across it.

- Not modern digital anime: no gradients inside cels, no clean 60 fps.
- Not moe: no giant eyes, no blush hatching.
- Not a film-print pastiche: tape noise, not gate weave.

## 2. Materials & rendering

- Background: painted gouache and airbrush, soft gradients, glowing windows.
- Cel: flat fills, one hard shadow shape, coloured line.
- Playback: chroma bleed, faint scanlines, darkened corners.

## 3. Colour logic

- Each hour has its own colour model: night city (indigo, violet, magenta, cyan, window gold); seaside noon (cobalt, white, sand, coral).
- The protagonist has one accent colour that pops in every set.
- Skin keeps its own colour under coloured light; never tint the whole frame.
- Example only: indigo #1c1f4a, violet #5a3c8a, neon magenta #ff3fa4, cyan #3fd6ff, window gold #f2c14e

## 4. Type & subtitles

- Titles: a condensed geometric sans with a chrome or glow treatment
- Subtitles: sans, white with a thin dark edge
- Placement: subtitles in the lower 120 px band kept clear of cels; titles as backlit cards
- Titles can be a white flash card in the assembler.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Cels on twos; camera and light on ones.
- Speed lines and a one-beat freeze before impact.
- Cut on bars; a white flash is the loudest transition.
- Stepping: on twos (ask for stepped motion in the beats; the camera stays smooth).
- Never moves: the painted background's brushwork.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `pedestal` (multiplane crane over a tall painted plate) | a world revealed layer by layer | arriving; descending into a place; rising above it |
| `tracking` (side tracking with three parallax layers) | steady momentum | a journey; a chase; progress |
| `static` (held bust with light bands) | speed or tension without animation | a drive; waiting; a decision |
| `push_in` (through a window or screen) | entering another world | a flashback; a broadcast; a dream |
| `pan` (slow, across a painted still) | awe, a held breath | a peak; a memory; a landscape |
| `pov` (rear view into a pseudo-3D road) | speed, pressure ahead | a race; a tunnel; a countdown |

- Framing: Cels readable against the plate; the protagonist's accent colour visible in every shot.
- Framing: Keep the lower band clear for subtitles.
- Transitions: cut, flash_white, fade_black; never dissolves, wipes.
- Preferred links: cut, reverse, insert_return, montage, jump_cut.

## 7. Sound palette

- Instruments: saxophone or synth brass lead, FM electric piano, slap bass, gated-reverb snare, arpeggiated analog synth, FM bells.
- Foley: engines from an RPM curve; rain and tyre hiss; cassette clicks; door buzzers; footsteps on wet pavement.
- Ambience: night city: distant traffic, rain, a radio through a wall.
- Silence: one beat of true silence before the chorus or the impact.
- Voice: an English-dub feel, short lines; a second voice through a phone band-pass.
- Default score field: city pop with synth brass lead and gated snare (100–128 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **Small flat hero in a huge painted world.** A tiny cel figure under a vast painted plate. *Build:* els size, pedestal or tracking move, reference mode for the character. *Fits content like:* a first day in a big company; a child in a museum hall; a lone researcher at an observatory.
- **Light-band sweep on a held cel.** A held close-up; only a band of light moves across it. *Build:* cu, camera static, beats: 'a band of passing light sweeps across the face'. *Fits content like:* a night train; a scanner reading a page; a heartbeat quickening.
- **Speed grammar.** Speed lines, looping plate, a freeze frame on impact. *Build:* pace frantic, vfx freeze on the last beat, montage link. *Fits content like:* a sprint final; a data packet crossing the world; a kitchen rush.
- **Colour-model change.** The same place at another hour. *Build:* jump_cut from the anchor with the new palette named in the beat. *Fits content like:* a day in a shop; a farm's seasons; before and after a renovation.
- **Tape artefacts as punctuation.** A tracking tear marks a cut in time. *Build:* assembler glitch over a cut, or vfx glitch on one beat. *Fits content like:* found home video; a rewind; an interrupted broadcast.

## 9. Pitfalls of the medium (what H3 gets wrong)

- The model produces modern smooth anime with gradients. → Say 'flat cel colours, one hard shadow shape, coloured outline, 1980s OVA' in the beat suffix; texture vhs.
- Faces become moe. → Describe 'narrow realistic eyes, long faces, 1980s character design'.
- Neon tints skin pink. → Name skin colour explicitly in character elements.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "1980s cel anime OVA, city at night, synth-pop melancholy",
    "palette": "indigo and violet night, neon magenta and cyan spill, window gold, one accent per hero",
    "camera": "multiplane cranes and side tracking, held busts with light bands",
    "lens": "normal, painted depth, anamorphic flares on lights",
    "lighting": "backlit practicals, neon spill, rim light on cels",
    "aspectRatio": "16:9"
  },
  "negative": [
    "no gradients inside cels",
    "no moe faces",
    "no 3D rendering"
  ],
  "cinematography": {
    "lens": "normal",
    "dof": "medium",
    "lighting": [
      "neon",
      "practicals",
      "rim"
    ],
    "grade": "cyberpunk",
    "texture": "vhs",
    "animation": "anime",
    "pace": "steady"
  },
  "bySize": {
    "cu": {
      "lens": "portrait",
      "dof": "shallow"
    },
    "els": {
      "lens": "wide",
      "dof": "deep"
    }
  },
  "loras": [],
  "beatSuffix": "Flat 1980s cel animation on twos over a painted background, coloured outlines, hard shadow shapes, VHS playback."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: the hour and its colour model, the hero's accent colour, structure, the signature freeze, opening, ending.

- Structures: one night drive in three songs; a broadcast interrupted three times; a day in a shop, dawn to shutters.
- Openings: a tape tracking in from static; a held bust in a tunnel of light bands; a crane down a painted tower.
- Endings: a freeze frame and a white flash; the tape ejected; the painted plate without the cel.
