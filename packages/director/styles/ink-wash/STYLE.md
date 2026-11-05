# Chinese Ink Wash · 中国水墨 — Style Prompt

> Black ink in five tones on warm rice paper, one vermilion seal, most of the frame left empty.
> 五色墨在宣纸上生长，唯一的朱红是印章，画面大半留白。
> References (grammar only): Song-dynasty landscape handscrolls (learn: the far-to-near value order and how emptiness reads as water or air; don't: any specific composition or inscription); 1960s Shanghai ink-animation shorts (learn: how a figure moves while staying a brushstroke; don't: their characters, melodies or stories).

<!-- generated from style.json by @openhiggsfield/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Hand-drawn & Painting · 手绘与绘画  
**Uses:** Wuxia and legends · Cultural brands · Poetry and tea · Calligraphy and craft

## 1. Essence, and what it is not

- Ink only, from pale cool grey to warm full black, on warm fibrous paper that stays visible everywhere.
- Forms are loaded brushstrokes whose dark edge is the contour; wet washes bleed, dry strokes leave flying white.
- Sixty to eighty percent of every frame is empty paper: water, sky, mist, silence.
- Things are painted into existence rather than cut to; motion is slow, weighted and unhurried.
- One vermilion accent, used like a seal: at most one small object or mark per film.

- Not watercolour: no colour washes, no hue beyond ink and the single vermilion.
- Not vector art with a brush texture: no flat fills, no closed outlines.
- Not a calligraphy title sequence: characters stay on the paper, type never carries the story.

## 2. Materials & rendering

- Rice paper ground: warm, fibrous, slightly uneven; it is the white and never pure white.
- Loaded strokes: a dark wet edge, a lighter body, paper showing through at speed.
- Wet-into-wet washes for mist and water; dry brush for rock, bark and hair.
- No photoreal detail: a face is three strokes, a tree is a trunk and five clumps.

## 3. Colour logic

- Five ink tones carry everything: far is pale and soft, near is dark and textured.
- One vermilion (seal red) for one recurring object or mark; never a red wash, never red light.
- When a frame gets busy, remove ink rather than add tone.
- Example only: paper #efe6d3, pale ink #b8b2a6, mid ink #6f6a62, full ink #221f1c, vermilion #b02e22

## 4. Type & subtitles

- Titles: a brush-written display face or Noto Serif SC heavy
- Subtitles: Noto Serif SC regular, warm near-black
- Placement: lower third on bare paper, no box; a vertical colophon column is allowed top-right for titles
- Subtitles sit on paper, never over ink masses.
- Numbers as digits on screen, spelled out in narration.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Slow, weighted moves; a stroke lands and settles, nothing bounces.
- Mist and water drift continuously; figures move in a few deliberate strokes.
- Transitions grow inside the frame (an ink bloom, mist) instead of cutting.
- Stepping: on ones.
- Never moves: the paper grain, the seal once stamped.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `static` | the page is the stage; things are painted in | a thing forming; a line being read; a decision held |
| `pan` (right to left, handscroll speed) | time and distance as one painting | a journey; a history; a process |
| `tilt` (hanging-scroll: bottom to top) | height, stages stacked | seasons; a climb; generations |
| `tracking` (lateral, lead room, slow far parallax) | motion through a world | travel; a pursuit; a commute |
| `push_in` (into an ink bloom or mist) | passing between states | memory; a dream; a season turning |
| `pull_out` (until the mark joins the whole) | the part was inside something larger | a summing-up; irony of scale; an ending |

- Framing: A tiny figure in a wide field of paper reads as solitude; keep the subject at least a third of frame height for emotion beats.
- Framing: Dark foreground masses may pass along the frame bottom; never crowd the top.
- Transitions: cut, dissolve, fade_white; never wipes, whip pans, flash frames.
- Preferred links: cut, continuous, match_cut, bridge.

## 7. Sound palette

- Instruments: guqin, xiao (low bamboo flute), big drum for mass, frame drum for steps, a small gong for a seal.
- Foley: ink drop (a short tink and a wet thud); brush air (breathy, bristle grain); steps on water; paper crackle.
- Ambience: near-silent room, distant water or wind, no city.
- Silence: literal: the whole bed out, one sound at most inside it, placed where the story holds its breath.
- Voice: calm, few lines, like colophons that do not explain the picture.
- Default score field: sparse guqin, pentatonic, unmetred plucks (48–72 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **One stroke is everything.** A single stroke becomes the subject. *Build:* keyframe mode from a hero frame of blank paper; beats: 'one dark stroke is drawn, it becomes…'; camera static. *Fits content like:* a product born from one line; a city from a single street; a day from one bird.
- **Ink bloom transition.** The next scene grows inside a spreading drop. *Build:* bridge link: anchor last frame → end frame of the new scene; beats describe the drop spreading and the scene appearing inside it. *Fits content like:* memories; seasons; one era giving way to the next.
- **The handscroll.** One long painting panned right to left, seen whole at last. *Build:* continuous chain of 10–15 s shots, camera pan slow, then a pull_out shot. *Fits content like:* a history; a supply chain from field to hand; a day in a street.
- **Emptiness is matter.** Removing ink reveals what was there. *Build:* jump_cut from the anchor with beats 'the mist thins and reveals…'. *Fits content like:* a door opening in a wall; a crowd parting; an absence.
- **Flying white.** One fast dry stroke across the frame, strongest out of a silence. *Build:* a 5 s montage shot, pace frantic, camera static, preceded by a still shot with no music. *Fits content like:* a sprint finish; a decision; a comet.

## 9. Pitfalls of the medium (what H3 gets wrong)

- The model adds colour to skies and water. → Keep 'ink only' in every beat suffix and 'no colour except one vermilion' in negatives.
- Faces turn photoreal and lose the brush. → Size cu at most, never ecu on a face; describe faces as 'a few strokes'.
- Empty paper fills with detail. → Say 'most of the frame is bare paper' in the beat; prefer els/ls sizes.
- Static shots drift. → camera.move static on every held page; H3 is told to lock off.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "Chinese ink-wash animation, sumi-e, contemplative wuxia poem",
    "palette": "black ink in five tones on warm rice paper, one vermilion seal red, no other colour",
    "camera": "painted handscroll, slow pans and tilts, locked pages",
    "lens": "normal, deep focus, painted flatness",
    "lighting": "no cast light; value carries depth, pale far and dark near",
    "aspectRatio": "16:9"
  },
  "negative": [
    "no on-screen text",
    "no logos",
    "no subtitles",
    "no colour except one vermilion",
    "no photoreal faces",
    "no outlines"
  ],
  "cinematography": {
    "lens": "normal",
    "dof": "deep",
    "lighting": [
      "overcast"
    ],
    "grade": "mono",
    "texture": "halftone",
    "animation": "inkwash",
    "pace": "slow"
  },
  "bySize": {
    "cu": {
      "lens": "portrait",
      "dof": "medium"
    },
    "els": {
      "lens": "wide",
      "pace": "still"
    }
  },
  "loras": [],
  "beatSuffix": "Everything is brushed ink on rice paper; most of the frame stays empty paper."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: subject, structure, what is painted first, where the one vermilion goes, opening, ending, camera path, where the silence falls.

- Structures: a journal kept over one year, one page per season painted over the last; anatomy of one object, each part a stroke close-up; a pursuit across one long scroll that ends where it began.
- Openings: a finished painting we then watch undone to its first stroke; a close-up of wet ink spreading, pulled back to show what it became; a single seal stamped on blank paper.
- Endings: the page left unfinished, brush lifted; a pull back until the figure is a dot in mist; the seal stamped a second time, now with meaning.
