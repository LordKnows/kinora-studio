# Impasto Oil Painting · 油画厚涂 — Style Prompt

> Thick oil paint that moves: knife-ridged strokes catching raking light, a painting alive on the canvas.
> 会动的厚涂油画：刮刀堆起的颜料在侧光下起伏，画布上的画活了。

<!-- generated from style.json by @openhiggsfield/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Hand-drawn & Painting · 手绘与绘画  
**Uses:** Music videos · Art and culture · Emotional brand films · Memory and biography

## 1. Essence, and what it is not

- Paint has relief: every stroke is a ridge with a lit side and a shadow side.
- Raking studio light across the canvas is part of the image, not an effect on it.
- Forms are built from a few confident knife and brush marks, never blended smooth.
- Motion is paint re-laid, stroke by stroke; the surface stays a painting between frames.
- Saturated, warm, expressionist colour with a strong dark ground.

- Not a photo with an oil filter: the strokes have to be larger than the detail they describe.
- Not watercolour: nothing is translucent.
- Not a gallery pan across a finished canvas: the paint moves.

## 2. Materials & rendering

- Linen canvas weave visible in thin passages; thick ridges in the lights.
- Palette-knife planes for architecture and sky; round-brush commas for foliage and cloth.
- A dark warm underpainting that shows at the edges of every stroke.

## 3. Colour logic

- A dark ground (umber or deep blue) under everything; the lights are the thickest paint.
- Complementary pairs carry mood: orange against blue, violet against yellow.
- Black is never pure; shadows are coloured.
- Example only: ground #2b1d14, cadmium orange #e07a2a, cerulean #3a7ca5, lemon #f0d35a, violet shadow #4a3560

## 4. Type & subtitles

- Titles: a heavy humanist serif, painted-looking (Playfair Display Black)
- Subtitles: sans, warm white, light drop shadow
- Placement: lower third over the darkest passage; never over a thick light stroke
- Titles can be painted in with a knife stroke by the assembler's wipe transition.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Strokes re-lay themselves in place; the paint 'boils' slightly between frames.
- Camera moves are slow and physical, as if across a real canvas.
- Light may sweep across the ridges to reveal relief.
- Stepping: on twos (ask for stepped motion in the beats; the camera stays smooth).
- Never moves: the canvas weave.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `push_in` | entering the paint; feeling before fact | a face; a window at dusk; a memory |
| `pan` (slow, across the canvas) | a world read left to right | a landscape; a crowd; a street |
| `static` (light sweeps instead of the camera) | relief, texture | a portrait; a still life; a held moment |
| `arc` (slight, as if walking past the easel) | the painting as object | an unveiling; a comparison; a turn |
| `tilt` | height and weight of paint | a tree; a tower; a figure standing |

- Framing: Big shapes, few of them; the subject fills at least a third of frame height.
- Framing: Leave a thick-paint passage in every frame to catch the light.
- Transitions: cut, dissolve, wipe, fade_black; never flash frames, glitches.
- Preferred links: cut, continuous, match_cut.

## 7. Sound palette

- Instruments: cello, upright piano, accordion, brushed drums, a solo voice without words.
- Foley: knife scraping canvas; brush on linen; a jar of turpentine; the subject's own world (rain, a tram, a café).
- Ambience: a studio at night, a window open to the subject's place.
- Silence: the brush stops; one held frame of relief in raking light, music out.
- Voice: intimate, close-miked, a letter being read.
- Default score field: cello and upright piano, slow, warm (56–84 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **Light sweep on relief.** A raking light crosses the ridges and the picture appears. *Build:* static camera, keyframe from a hero frame; beats: 'a warm light sweeps left to right, ridges catch it'. *Fits content like:* a sunrise; a reveal of a face; a machine switched on.
- **Repainted memory.** The same composition re-laid in a different hour or mood. *Build:* jump_cut from the anchor with beats naming the new palette and light. *Fits content like:* before and after; a season; the same room years later.
- **Stroke becomes thing.** One knife stroke turns into a figure or a road. *Build:* keyframe from a frame of a lone stroke; beats describe it gaining form. *Fits content like:* a city founded; a first word; a river's source.
- **Knife wipe.** A thick stroke scrapes the next scene into view. *Build:* assembler wipe transition over a cut; the model never does the wipe. *Fits content like:* chapter breaks; a change of place; a reveal.

## 9. Pitfalls of the medium (what H3 gets wrong)

- Strokes smooth out into a blurry photo. → Say 'thick palette-knife strokes larger than the details' in the beat suffix; texture halftone key is not used, rely on animation description.
- Colour drifts to grey. → Name the complementary pair in the palette and in the beat.
- Faces become uncanny. → Keep faces at cu or wider and describe them as 'a few strokes'.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "animated impasto oil painting, expressionist, emotional",
    "palette": "dark warm ground, thick saturated strokes, complementary orange and blue, coloured shadows",
    "camera": "slow physical moves across a real canvas under raking studio light",
    "lens": "normal to portrait, painted depth",
    "lighting": "raking warm key from one side so every paint ridge has a lit and a shadow side",
    "aspectRatio": "16:9"
  },
  "negative": [
    "faces, skin and sky are built from the same thick knife strokes as the rest"
  ],
  "cinematography": {
    "lens": "normal",
    "dof": "medium",
    "lighting": [
      "rim",
      "practicals"
    ],
    "grade": "vivid",
    "animation": "ghibli",
    "pace": "slow"
  },
  "bySize": {
    "cu": {
      "lens": "portrait"
    },
    "els": {
      "lens": "wide",
      "dof": "deep"
    }
  },
  "loras": [],
  "beatSuffix": "Everything is thick impasto oil paint, palette-knife ridges catching a raking light."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: subject, the complementary pair, the hour of light, structure, opening, ending, camera path.

- Structures: one portrait repainted across a life; a street at four hours of the day; a letter read while the painting it describes is made.
- Openings: a dark canvas and the first stroke; a close-up of a ridge of paint, pulled back; the light switched on in the studio.
- Endings: the painting turned to face the wall; the last stroke left wet; the camera walks past the easel and out.
