# Time-lapse Symphony · 延时交响 — Style Prompt

> A place over one day, time bent: machines fast, people slow, every cut on a beat of a score written first.
> 一个地方的一天，时间被弯折：机器快、人慢，每一刀都落在先写好的乐谱节拍上。

<!-- generated from style.json by @openhiggsfield/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Edit & Documentary · 剪辑与纪实  
**Uses:** City and place films · Music montages · Openers and idents · Anniversaries

## 1. Essence, and what it is not

- An edit style: the picture is real-looking footage; the style lives in how time is bent and where the cuts fall.
- The score is the script: minimal → acceleration → climax → a sudden stop → coda; every cut on a beat or its subdivision.
- Machines fast, people slow: traffic and clouds become lines; one fragile thing is slowed.
- One fixed-camera time-lapse returns as the clock.
- Few words, each one earned.

- Not a travel reel: no drone-porn on a pop track.
- Not a news package: no lower thirds, no narrator.
- Not a slideshow: motion in every shot.

## 2. Materials & rendering

- Photoreal footage: time-lapse, hyperlapse, aerials, slow motion.
- Long-exposure light trails at night; crowds as streaks.
- A clean digital or 35 mm look; no VHS.

## 3. Colour logic

- The place's own light: blue hour, sodium orange, noon white.
- One accent (sodium orange) for rules, numbers and trails in the assembler.
- Consistent grade across the whole film; no per-shot looks.
- Example only: blue hour #27496d, sodium #d9772f, noon #e8e6df, night #0b0d12

## 4. Type & subtitles

- Titles: a light grotesk, wide tracking, warm white
- Subtitles: not used; a handful of numbers and one quote
- Placement: numbers lower-left with a sodium rule; the quote centred at the end
- Every number has a source; at most five numbers in the film.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Density follows the score: never cut faster than the current subdivision.
- Speed ramps are the transitions; the brake into slow motion is the breath.
- The hard stop: a dry cut to black on the bar line with the reverb ringing.
- Stepping: on ones.
- Never moves: the fixed clock camera's framing.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `static` (the fixed clock time-lapse) | the time of day without a caption | dawn; nightfall; a day/night flicker |
| `tracking` (hyperlapse through streets) | momentum | a commute; a river of traffic; a route |
| `pedestal` (aerial rise) | scale | the whole place; a climax; a coda |
| `static` (slow motion on one fragile thing) | the breath | a flag; steam; a flock; a bubble |
| `pan` (slow across a skyline at blue hour) | a held chord | the brake; the coda |
| `roll` (top-down traffic as light) | the city as circuit | night; logistics; the climax grid |

- Framing: Match shapes across cuts: clock to clock, arch to arch.
- Framing: People never in close-up except in the slowed moment.
- Transitions: cut, fade_black; never dissolves, wipes, page turns.
- Preferred links: cut, montage, match_cut, jump_cut, loop.

## 7. Sound palette

- Instruments: piano arpeggios, strings in eighths and triplets, horns at the climax, a sub pulse, a single sustained chord for the brake.
- Foley: none, or the slowed thing's own sound at real speed; a city bed compressed by speed.
- Ambience: the place, sped up into a hiss; real speed only in the slowed moment.
- Silence: the hard stop: everything cut on the bar line, reverb left ringing, then the coda alone.
- Voice: none; one quoted line as text at the end.
- Default score field: minimal piano arpeggios building to full ensemble, then a hard stop (100–132 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **Light river.** Traffic at night becomes a river of trails. *Build:* vfx longexposure + timelapse, overhead or high angle, loop link for the climax grid. *Fits content like:* a ring road; a harbour at night; an airport apron.
- **The brake.** Time crashes into slow motion on one fragile thing. *Build:* vfx slowmo, pace still, a 10 s shot placed under the held chord; cue map marks it. *Fits content like:* a soap bubble; steam from a cup; a flock over the square.
- **Clock returns.** The fixed camera comes back at a new hour. *Build:* jump_cut from the first clock shot, same framing, 'hours have passed'. *Fits content like:* a square; a bridge; a station hall.
- **Hard stop.** Dry cut to black on the bar line. *Build:* assembler fade_black with 0 s duration on a cue-map hit; music cut there. *Fits content like:* the end of the climax; a punchline; a title.
- **Shape match.** A cut that rhymes two shapes on the beat. *Build:* match_cut link; beats describe the matching shape first. *Fits content like:* wheel to galaxy; arch to arch; grid to grid.

## 9. Pitfalls of the medium (what H3 gets wrong)

- The model produces drone footage with no time bend. → vfx timelapse or hyperlapse on every wide; beats say 'clouds race, traffic streaks'.
- Cuts drift off the beat. → Build the cue map first and snap clip boundaries to it in the assembler.
- Too many words. → At most five numbers and one quote, all in the assembler.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "city symphony time-lapse film, documentary, musical montage",
    "palette": "the place's own light: blue hour, sodium orange, noon white; one consistent grade",
    "camera": "fixed time-lapse clocks, hyperlapse tracks, aerial rises, one slow-motion breath",
    "lens": "wide to tele, deep focus",
    "lighting": "natural: dawn, noon, blue hour, sodium night",
    "aspectRatio": "16:9"
  },
  "negative": [
    "people are small figures in wide frames, seen from a distance",
    "the camera is tripod-locked or glides on a smooth track"
  ],
  "cinematography": {
    "lens": "wide",
    "dof": "deep",
    "lighting": [
      "blue"
    ],
    "grade": "muted",
    "texture": "35mm",
    "vfx": [
      "timelapse"
    ],
    "pace": "brisk"
  },
  "bySize": {
    "cu": {
      "lens": "portrait",
      "vfx": [
        "slowmo"
      ],
      "pace": "still"
    },
    "els": {
      "angle": "high"
    }
  },
  "loras": [],
  "beatSuffix": "Photoreal time-lapse: machines and clouds race, people streak, the camera steady."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: the place, the clock camera's position, the fragile slowed thing, the score's shape, the numbers, the quote.

- Structures: one day dawn to night; a year in one square; arrival to departure of one ship.
- Openings: the clock camera before dawn, one light on; a single arpeggio and a still frame; the slowed thing first, then time speeds up.
- Endings: the hard stop and a quiet coda; the clock camera at the same hour next day; the quote over the last trail.
