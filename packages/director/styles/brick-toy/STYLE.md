# Brick Toy · 积木玩具 — Style Prompt

> A world built from plastic bricks on a tabletop, assembled brick by brick in stop-motion.
> 一个用塑料积木在桌面上搭出的世界，逐块定格拼装。

<!-- generated from style.json by @openhiggsfield/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Materials & 3D · 材质与 3D  
**Uses:** Toys and kids · Product and process builds · Space and vehicles · City and architecture

## 1. Essence, and what it is not

- Everything is studded plastic bricks: glossy, slightly scratched, seams visible.
- Built on a tabletop with a real room's light; shallow focus like a macro lens.
- Things assemble brick by brick, in stepped stop-motion.
- Minifigure-like characters with fixed smiles and claw hands.
- Bright primary palettes with a few greys.

- Not CGI smoothness: the bricks have fingerprints and seams.
- Not real-scale architecture: the stud grid is visible everywhere.
- Not a real brand: generic bricks, no logos on studs.

## 2. Materials & rendering

- ABS plastic: glossy, slight translucency on clear bricks, scratches.
- A tabletop or baseplate, a window's light, a shallow macro depth of field.
- Stop-motion stepping at 12 fps; hands never visible.

## 3. Colour logic

- Brick primaries: red, yellow, blue, green, plus light and dark grey and black.
- One colour per object family; the hero's colour appears nowhere else.
- The baseplate is green, grey or blue; never patterned.
- Example only: red #c4281c, yellow #f5c518, blue #0d5fb2, green #237841, light grey #a0a5a9, dark grey #6c6e68

## 4. Type & subtitles

- Titles: a chunky rounded sans built from brick-like blocks
- Subtitles: a rounded sans, white with a dark edge
- Placement: titles built from bricks are the model's job only if no text; use the assembler for words
- Captions bottom centre; never ask the model for lettering.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Stepped, stop-motion motion at 12 fps; the camera glides smoothly.
- Assembly is the main action: pieces fly in and click.
- Characters move in minifigure poses: no wrists, no knees.
- Stepping: on twos (ask for stepped motion in the beats; the camera stays smooth).
- Never moves: the baseplate, the room light.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period. A default from cost, not a measured limit.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `arc` (slow orbit at table height) | the build as object | a reveal; a finished model; a comparison |
| `push_in` (macro into the stud grid) | the detail matters | a part; a mechanism; a face |
| `static` (locked while the build assembles) | the process | a build; a demolition; a rebuild |
| `tracking` (along a brick road) | a journey through the set | a vehicle; a parade; a delivery |
| `pedestal` (rise to show the whole baseplate) | scale | a city; a map; an ending |

- Framing: Table height, macro depth; the stud grid readable.
- Framing: The hero's colour centred.
- Transitions: cut, fade_black; never dissolves, wipes.
- Preferred links: cut, continuous, jump_cut, loop.

## 7. Sound palette

- Instruments: ukulele, xylophone, a toy drum kit, pizzicato strings, a kazoo for comedy.
- Foley: the brick click; plastic pieces sliding on a table; a minifigure's hollow footstep; a plastic wheel on a baseplate.
- Ambience: a quiet room, a clock, a window.
- Silence: the last brick hovers; music out; the click lands alone.
- Voice: a warm, playful narrator, or a child's.
- Default score field: ukulele and xylophone, light, playful (100–130 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **Brick-by-brick build.** A thing assembles from flying pieces. *Build:* static shot, beats: 'pieces fly in from above and click into place, layer by layer'. *Fits content like:* a house; a rocket; a sandwich.
- **The rebuild.** The same bricks become something else. *Build:* jump_cut from the anchor; beats 'the bricks lift apart and reassemble as…'. *Fits content like:* a product's second life; a plan B; recycling.
- **Minifigure gesture.** A figure's one pose tells the beat. *Build:* reference mode for the figure; one action per beat, claw hands. *Fits content like:* a builder; an astronaut; a shopkeeper.
- **Baseplate reveal.** Rise to show the whole world on one plate. *Build:* pedestal, strong amplitude, els, last shot. *Fits content like:* a city; a farm; a theme park.

## 9. Pitfalls of the medium (what H3 gets wrong)

- A real brand's logo appears on studs. → Negatives 'no logos'; describe 'generic plastic bricks'.
- Motion is smooth CGI. → animation stopmotion; 'stepped stop-motion' in the suffix.
- Scale drifts to life-size. → Keep 'tabletop, macro lens, stud grid visible' in every beat.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "stop-motion brick-toy film on a tabletop, playful build story",
    "palette": "bright plastic primaries, light and dark grey, a green or grey baseplate",
    "camera": "table-height orbits, macro push-ins, locked builds",
    "lens": "macro, shallow depth of field",
    "lighting": "soft window daylight on a tabletop, glossy highlights on plastic",
    "aspectRatio": "16:9"
  },
  "negative": [
    "only bricks, minifigures and the tabletop are in frame; bricks move on their own",
    "every building is a brick model a few bricks tall"
  ],
  "cinematography": {
    "lens": "macro",
    "dof": "shallow",
    "lighting": [
      "highkey",
      "practicals"
    ],
    "grade": "vivid",
    "texture": "digital",
    "animation": "stopmotion",
    "pace": "steady"
  },
  "bySize": {
    "els": {
      "lens": "normal",
      "dof": "medium"
    }
  },
  "loras": [],
  "beatSuffix": "Everything is glossy plastic toy bricks on a tabletop, stepped stop-motion, macro depth of field."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: what is built, the hero's colour, the baseplate, structure, opening, ending.

- Structures: one build from first brick to last; a build, a collapse, a better rebuild; a journey across one baseplate.
- Openings: a single brick on an empty plate; a minifigure looking at a pile; the finished model, then unbuilt.
- Endings: the last brick clicks; the plate rises into view; the figure sits on top of what it built.
