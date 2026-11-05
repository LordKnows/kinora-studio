# Watercolour Journal · 水彩手账 — Style Prompt

> A field journal that paints itself: translucent washes, dry-brush edges, hand-written notes beside what is painted.
> 一本自己画自己的手账：透明晕染、干笔飞白，画旁有手写注记。

<!-- generated from style.json by @openhiggsfield/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Hand-drawn & Painting · 手绘与绘画  
**Uses:** Nature and travel · Science explainers · Food and craft · Gentle brand stories

## 1. Essence, and what it is not

- One sheet of warm cotton paper under everything; light is unpainted paper.
- Translucent washes that darken where they overlap; granulation and blooms at the edges.
- A quiet annotation layer: pencil notes and leader lines beside the subject.
- Things paint themselves in, structure before detail.
- Tone: calm, curious, precise.

- Not ink wash: colour, not ink tones.
- Not a children's crayon book: no outlines, no cute faces.
- Not a photo with a watercolour filter: the paper must show through everywhere.

## 2. Materials & rendering

- Cold-press paper texture visible in every wash.
- Wet-into-wet skies and water; dry brush for grass, bark, stone.
- Pencil underdrawing allowed to show; no black ink outlines.

## 3. Colour logic

- Three to five hues per scene plus a warm near-black for notes.
- Darker means more layers, never a darker pigment on top.
- One accent (a vermilion, a rain blue) for one recurring thing.
- Example only: paper #f3ead8, sage #8ea860, straw #d9c27a, rain blue #3f7fa8, accent #c8442a

## 4. Type & subtitles

- Titles: an elegant serif (Cormorant Garamond)
- Subtitles: serif italic, warm ink at 80 percent
- Placement: centred bottom on paper, no box; notes in a handwriting face beside the subject
- Hold notes long enough to read: letters ÷ 15 + 1.5 s.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Painting-in is the main motion; finished things only sway.
- Mist and washes drift slowly; nothing jitters.
- A page turn or a mist wash is the chapter break.
- Stepping: on ones.
- Never moves: the paper grain.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `truck` (long lateral dolly over a continuous painted world) | a gradient, a journey | a transect; a route; a timeline |
| `tilt` | scale, measurement | a tall tree; a building; a depth |
| `static` | study, attention | a specimen plate; a recipe; a diagram |
| `push_in` | the observer leaning in | a seed; an insect; a hand-written note |
| `pull_out` (to a painted map or diagram) | the whole re-framed | where it all happened; a system |

- Framing: Generous paper margins; one hero subject per view with its note.
- Framing: Labels never cover the subject.
- Transitions: cut, dissolve, fade_white, wipe; never hard video cuts between unrelated pictures, dissolves between unrelated pictures.
- Preferred links: continuous, bridge, jump_cut, cut.

## 7. Sound palette

- Instruments: felt piano, fingerpicked guitar, woodwinds, glockenspiel, kalimba, soft pads.
- Foley: paper brush rustle for each painting-in; pencil scratch for notes; page flips; nature beds of the subject.
- Ambience: the room where the journal is kept, plus the place being painted.
- Silence: the brush lifted: music out, only paper and room; it frames one painted moment.
- Voice: warm, unhurried documentary read, one line per idea.
- Default score field: gentle felt piano and fingerpicked guitar (60–96 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **Painting-in as reveal.** A new thing appears stroke by stroke as it enters. *Build:* keyframe from a hero frame of the sketch; beats describe washes arriving in order (sky, ground, subject, note). *Fits content like:* the stages of a building; the ingredients of a dish; the organs of a body.
- **Palette as data.** Sky, ground and background blend by a measured value. *Build:* continuous chain with camera truck; each shot's beats name the colour shift and the value it stands for. *Fits content like:* pollution along a river; temperature by altitude; noise across a city.
- **Mist erase.** The world washes back to paper. *Build:* bridge to an end frame of blank paper; next shot a cut. *Fits content like:* forgetting; a dream ending; a site demolished.
- **Specimen and note.** One hero object with a hand-written label. *Build:* static insert shot; the note is added by the local assembler as a caption, not by the model. *Fits content like:* a tool kit; a wine region's grapes; parts of a bicycle.

## 9. Pitfalls of the medium (what H3 gets wrong)

- The model paints opaque, gouache-like colour. → Say 'translucent wash, paper showing through' in the beat suffix.
- Hand-written text comes out as gibberish. → Never ask the model for notes; add them in the assembler as captions.
- Motion turns into a slideshow of stills. → Give each beat a visible painting-in or a drift; keep camera moves slow but present.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "animated watercolour field journal, lyrical nature documentary",
    "palette": "translucent washes on warm cotton paper, three to five hues, one small accent",
    "camera": "slow lateral dollies over a painted world, locked specimen plates",
    "lens": "normal, deep painted focus",
    "lighting": "soft daylight read as unpainted paper; no cast shadows harder than a wash",
    "aspectRatio": "16:9"
  },
  "negative": [
    "no on-screen text",
    "no logos",
    "no subtitles",
    "no black outlines",
    "no opaque paint",
    "no photoreal textures"
  ],
  "cinematography": {
    "lens": "normal",
    "dof": "deep",
    "lighting": [
      "overcast"
    ],
    "grade": "pastel",
    "animation": "watercolor",
    "pace": "slow"
  },
  "bySize": {
    "insert": {
      "lens": "macro",
      "dof": "shallow"
    },
    "els": {
      "lens": "wide"
    }
  },
  "loras": [],
  "beatSuffix": "Everything is translucent watercolour on textured paper, washes bleeding at the edges."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: subject, the gradient or list the film walks, palette within the rules, what is measured, opening, ending, camera path.

- Structures: a journal over one year, one page per month; anatomy of one object dissected into labelled parts; a recipe painted top to bottom on one tall sheet.
- Openings: a finished painting watched being painted backwards; a close-up of wet pigment spreading; a hand-written question on blank paper.
- Endings: the page left unfinished; a close-up of one detail as the rest fades to paper; the sheet dries and is filed into a stack.
