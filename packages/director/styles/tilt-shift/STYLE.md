# Tilt-shift Miniature · 移轴微缩 — Style Prompt

> A real place seen from high up through a tilt-shift lens: a thin sharp band, toy colours, time-lapse traffic.
> 从高处用移轴镜头看真实世界：一条清晰带、玩具般的色彩、延时的车流。

<!-- generated from style.json by @kinora/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Materials & 3D · 材质与 3D  
**Uses:** City promos · Real estate and campuses · Transport and logistics · Events from above

## 1. Essence, and what it is not

- High oblique views; only a thin horizontal band is sharp, everything else melts.
- Saturated, sunny, model-railway colour.
- Time-lapse: vehicles and people move in fast jittery steps like wind-up toys.
- The world is photoreal; only the lens and the clock make it small.
- One tiny actor the band follows.

- Not a toy or clay render: the place is real.
- Not drone footage: the band, the saturation and the stutter are mandatory.
- Not a game's top-down view: no UI.

## 2. Materials & rendering

- Photoreal city, harbour, farm or campus in bright sun.
- Tilt-shift depth of field: a horizontal sharp band, strong blur above and below.
- Time-lapse stepping at 8–12 fps for traffic and crowds.

## 3. Colour logic

- Saturated primaries on roofs, vehicles and awnings; the ground stays neutral.
- Sunny, high-key, short shadows; dusk allowed for light trails.
- One accent vehicle or roof the eye can follow.
- Example only: sky #8fc3f0, roof red #d9442b, tram yellow #f2c230, harbour #2f7f9c, asphalt #7a7f84

## 4. Type & subtitles

- Titles: a clean rounded sans, white on a small colour chip
- Subtitles: the same, bottom centre
- Placement: small labels near the sharp band; titles in a corner chip
- Labels are assembler captions pointing at the band.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Traffic and crowds step fast; the camera glides slowly.
- A speed drop to real time on one detail is the signature.
- Cloud shadows sweep the model.
- Stepping: on twos (ask for stepped motion in the beats; the camera stays smooth).
- Never moves: the blur band's softness.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period. A default from cost, not a measured limit.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `truck` (high oblique wide, very slow slide) | a whole system at a glance | setting a place; routine; many small actors |
| `tracking` (the band follows one subject) | this one | a single commuter; a delivery; a lost child |
| `push_in` (on an intersection or yard) | a system heating up | rush hour; a festival setting up; a queue |
| `roll` (straight top-down, slow rotation) | the world as a board | patterns; logistics; choreography |
| `pedestal` (vertical rise) | scale, letting go | aftermath; a summary; a system becoming a pattern |
| `static` (locked across hours) | time as the actor | a construction; a market day; a tide |

- Framing: Stay high; the sharp band carries the subject.
- Framing: People and vehicles stay tiny except in one speed-drop close-up.
- Transitions: cut, fade_black; never dissolves that reveal the fake lens.
- Preferred links: cut, continuous, montage, jump_cut.

## 7. Sound palette

- Instruments: marimba, pizzicato strings, glockenspiel, a ticking woodblock, toy piano.
- Foley: sped-up traffic as a hiss; a tiny horn; a train bell; seagulls; a crowd as a murmur.
- Ambience: a city from far above, wind, distant sirens compressed by speed.
- Silence: the speed drop: time-lapse hiss stops, one real sound at real speed.
- Voice: light, amused, a narrator who likes the place.
- Default score field: marimba and pizzicato, ticking, playful (100–132 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **The speed drop.** Time crashes from ×40 to ×1 on one detail. *Build:* vfx speedramp, beats: 'the traffic blurs at speed, then one worker at real speed finishes a shift'. *Fits content like:* one worker finishing; a child dropping an ice cream; a proposal on a crowded pier.
- **The band as pointer.** The sharp band slides to steer the eye. *Build:* camera.note 'the sharp band drifts up to the station'; dof tiltshift. *Fits content like:* a courier through a market; one wrong-way skier; one boat leaving port.
- **God's-eye system.** The place as a sequencer. *Build:* overhead angle, roll move, vfx timelapse. *Fits content like:* a port unloading; an airport turnaround; a harvest.
- **Scale reveal.** Rise until the place becomes a pattern. *Build:* pedestal move, strong amplitude, els size, last shot. *Fits content like:* a festival from setup to crowd; a school at recess; a city grid at night.

## 9. Pitfalls of the medium (what H3 gets wrong)

- The blur band disappears and it becomes drone footage. → dof tiltshift on every shot; say 'thin horizontal sharp band, miniature effect' in the suffix.
- Motion is real-time and smooth. → vfx timelapse on every wide; beats say 'traffic streaks in fast steps'.
- Colours go realistic and grey. → grade vivid; name the toy colours in the palette.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "tilt-shift miniature city film, playful time-lapse",
    "palette": "saturated model-railway colours in bright sun, neutral ground, one accent vehicle",
    "camera": "high oblique slides and rises, the sharp band following one tiny actor",
    "lens": "tilt-shift, thin horizontal sharp band, heavy blur above and below",
    "lighting": "harsh sunny high-key, short shadows; dusk for light trails",
    "aspectRatio": "16:9"
  },
  "negative": [
    "people are tiny figures seen from high above",
    "the frame is a clean photograph from edge to edge"
  ],
  "cinematography": {
    "angle": "high",
    "lens": "tele",
    "dof": "tiltshift",
    "lighting": [
      "harshsun"
    ],
    "grade": "vivid",
    "texture": "digital",
    "vfx": [
      "timelapse"
    ],
    "pace": "brisk"
  },
  "bySize": {
    "els": {
      "angle": "high"
    },
    "cu": {
      "vfx": [
        "speedramp"
      ],
      "pace": "slow"
    }
  },
  "loras": [],
  "beatSuffix": "Tilt-shift miniature look from high above, thin sharp band, saturated toy colours, time-lapse motion."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: the place and its system, the tiny actor, the speed curve, where the band goes, opening, ending.

- Structures: one day dawn to night from one vantage; the relay: the band hands attention from actor to actor; a construction site from empty lot to opening day.
- Openings: mid-bustle with the band already on one oddity; a top-down pattern that tilts into a place; real time first, then the lens lifts.
- Endings: a drop to real time that stays there; lights going out one by one; the band widens until the model is a real place.
