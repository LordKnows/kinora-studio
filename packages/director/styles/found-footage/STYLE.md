# Liminal Found Footage · 后室 · 新怪谈录像 — Style Prompt

> One camcorder tape, first person, an empty familiar interior where the camera's own failures carry the plot.
> 一盘摄像机录像带，第一人称，空荡熟悉的室内，摄像机自身的故障推动剧情。

<!-- generated from style.json by @openhiggsfield/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Cinema & Eras · 电影与时代  
**Uses:** Horror and mystery · ARG and game teasers · Liminal spaces · Unsettling brand drops

## 1. Essence, and what it is not

- One continuous first-person camcorder recording: VHS, 4:3 feel, handheld, dated on-screen display.
- An empty, familiar-but-wrong interior that repeats: offices, hotel floors, pools, car parks.
- Dread from emptiness, repetition and the machine failing: focus hunts, exposure pumps, tape tears.
- Nothing chases anyone; nothing is explained.
- Fluorescent hum is the score.

- Not a horror film: no monster close-ups, no jump-scare stings.
- Not a CRT terminal piece: artefacts are tape and lens, not phosphor.
- Not a ruin: clean and lit is part of the wrongness.

## 2. Materials & rendering

- VHS: chroma bleed, tracking noise, soft detail, a date-time stamp in the corner.
- Fluorescent panels, drop ceilings, carpet, laminate; one material's sickly hue dominates.
- Autofocus and auto-exposure that hunt and fail.

## 3. Colour logic

- One dominant sickly hue from the location's materials (mustard, institutional green, hospital blue).
- Exactly one saturated colour: a signal lamp, an exit sign; it is the only thing that blooms.
- White balance drifts; colour is never clean.
- Example only: wallpaper #d5bd66, trim #4d3d26, carpet #8c763c, fluorescent #f2f1e4, signal red #e0241c

## 4. Type & subtitles

- Titles: the camcorder's own OSD font (a blocky monospace), white with a dark edge
- Subtitles: the same OSD font, lower-left
- Placement: OSD corners: REC top-left, date bottom-right; captions like [SILENCE] lower-left
- All on-screen text is OSD added by the assembler; the model draws none.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Handheld walking rhythm; the camera breathes with the operator.
- Long holds; the dread is in the wait.
- A tape tear is the only cut: same framing after, something changed.
- Stepping: on ones.
- Never moves: the OSD.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `pov` (walking down a corridor) | routine, the endless | establishing the space; time passing |
| `pan` (slow, off a detail to the space) | scale; the space goes on | a reveal; a first look |
| `tilt` (a glance down at the feet) | obedience, avoidance | obeying a rule; not looking |
| `zoom` (into the distance with a focus hunt) | seeing and not seeing | a presence; a doubt |
| `static` (camera set down on a surface, recording alone) | abandonment | the operator gone; a long wait |
| `handheld` (backing away while filming) | retreat | leaving a room; a rule broken |

- Framing: Any presence is small, far and in a region of dead lights.
- Framing: Printed notices readable and uncovered.
- Transitions: cut; never dissolves, fades, anything the tape could not do.
- Preferred links: continuous, jump_cut, cut.

## 7. Sound palette

- Instruments: none; a drone of beating sines at most.
- Foley: carpet steps; camcorder motor and zoom servo; ballast tink on flicker; a vending machine; a pipe.
- Ambience: fluorescent hum (100 or 120 Hz plus harmonics), closer in small rooms.
- Silence: digital zero for a second or more, captioned [SILENCE]; everything restrikes at once after.
- Voice: the operator: a few short quiet lines with breath; a PA voice through a ceiling speaker.
- Default score field: N/A.
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **Autofocus hunting.** Something is there only while focus is correct. *Build:* zoom move, camera.note 'autofocus hunts', beat describing the far end going soft and sharp. *Fits content like:* a missing pet on a hotel floor; a figure in an empty stadium; a shape at the end of a ward.
- **Tape tear.** A tear is a cut the universe made: same framing, the clock jumped. *Build:* jump_cut from the anchor; beats name what changed (a light died, the date advanced); assembler adds the tear noise. *Fits content like:* a night-watch log; a lost weekend in a mall; a house that ages between tapes.
- **Camera set down.** The camera records alone on a surface. *Build:* static shot, 15 s, beats 'nothing happens; a light flickers at 11 s'. *Fits content like:* the operator gone; a long wait; an empty lobby at 4 a.m..
- **Rules as text.** Notices drift wrong and finally address the viewer. *Build:* insert shots of blank notice boards; the assembler overlays the text. *Fits content like:* a pool's safety rules; a fire drill; a museum after hours.

## 9. Pitfalls of the medium (what H3 gets wrong)

- The model makes it a clean horror movie with a creature. → Negatives 'no monsters, no gore'; beats describe emptiness only.
- Footage is too sharp and colourful. → texture vhs, grade muted; say 'soft VHS camcorder, chroma bleed' in the suffix.
- The operator's hands or face appear. → pov angle; 'first person, no operator visible'.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "liminal found-footage camcorder tape, slow dread, no monsters",
    "palette": "one sickly institutional hue, near-white fluorescent panels, one saturated signal colour, drifting white balance",
    "camera": "handheld first-person camcorder, long holds, zooms that hunt focus",
    "lens": "camcorder wide, auto-focus and auto-exposure failing",
    "lighting": "fluorescent panels, some dead; flicker",
    "aspectRatio": "16:9"
  },
  "negative": [
    "no on-screen text",
    "no logos",
    "no subtitles",
    "no monsters",
    "no gore",
    "no people"
  ],
  "cinematography": {
    "angle": "pov",
    "lens": "wide",
    "dof": "deep",
    "lighting": [
      "practicals"
    ],
    "grade": "muted",
    "texture": "vhs",
    "pace": "still"
  },
  "bySize": {
    "insert": {
      "lens": "normal"
    }
  },
  "loras": [],
  "beatSuffix": "Soft 1990s VHS camcorder footage, first person, empty fluorescent interior."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: the interior, the sickly hue, the one signal colour, what the OSD reveals, structure, ending.

- Structures: a night-watch round that repeats three times, each time one thing missing; a search for an exit by following the signs, which start to lie; a camera left recording while the operator is away.
- Openings: REC blinks on in a lift; a notice read in close-up; a corridor at full walking pace.
- Endings: the camera set down and left; a tear, then the same corridor dark; the battery icon empties.
