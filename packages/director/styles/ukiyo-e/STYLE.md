# Ukiyo-e Woodblock · 浮世绘 — Style Prompt

> A woodblock print in motion: flat colour fields, keyblock lines, Prussian-blue water and a gradient sky.
> 会动的浮世绘版画：平涂色块、墨线轮廓、普鲁士蓝的水和渐变的天。

<!-- generated from style.json by @openhiggsfield/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** East Asian Traditions · 东方传统  
**Uses:** Travel and places · Japanese culture · Poetry and seasons · Craft brands

## 1. Essence, and what it is not

- Flat, unmodelled colour fields separated by a thin dark keyblock line.
- Bokashi gradients in the sky and water; registration slightly imperfect at the edges.
- Steep, stacked perspective: near things large and low, far things small and high, no vanishing point.
- Patterns (waves, rain, textile) drawn as repeating marks, not textures.
- Stillness with one moving thing: a wave, a traveller, rain.

- Not anime: no cel shading, no large eyes.
- Not a photo with a print filter: no photographic depth of field.
- Not Chinese ink wash: colour is flat and full, not tonal.

## 2. Materials & rendering

- Washi paper ground with mulberry fibre; ink sits in it slightly.
- Keyblock line, uniform width, warm black.
- Colour blocks with bokashi gradients at horizon and water; small registration misfit allowed.

## 3. Colour logic

- Five to seven flat colours per print; Prussian blue for water and distance.
- The sky is a gradient band, the ground a flat field; mid-tones are rare.
- One accent (a red lantern, an orange gate) placed once.
- Example only: washi #efe4cf, Prussian blue #1f3f6e, indigo #2c2c4a, vermilion #c5402b, ochre #d1a24a, pine #3f6b4f

## 4. Type & subtitles

- Titles: a vertical cartouche; Noto Serif JP bold
- Subtitles: Noto Serif JP regular, warm black
- Placement: a vertical cartouche top-left or right for titles; subtitles bottom on the paper
- Titles may sit inside a rectangular cartouche added by the assembler.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Most of the frame holds still; one element moves in a repeating pattern.
- Motion is stepped and graphic, like a flip of printed sheets.
- Rain and waves loop; people walk in two or three poses.
- Stepping: on twos (ask for stepped motion in the beats; the camera stays smooth).
- Never moves: the keyblock line weight, the paper.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `static` | the print as object; one thing moves inside it | a wave; rain on a bridge; a traveller passing |
| `pan` (across a series of stations) | a road, stage by stage | a pilgrimage; a route; a timeline |
| `tilt` | the vertical print, sky to foreground | a mountain; a waterfall; a tower |
| `pull_out` (from a detail to the full sheet) | the detail belongs to a whole | a reveal; an ending; a map |
| `truck` (slow, parallax between stacked planes) | travel through flat layers | a boat on water; a procession; a train |

- Framing: Stacked planes: foreground large and cropped, middle ground, a far mountain small and high.
- Framing: Leave a cartouche-sized rectangle clear for titles.
- Transitions: cut, wipe, fade_white; never dissolves, zooms.
- Preferred links: cut, loop, jump_cut, match_cut.

## 7. Sound palette

- Instruments: shamisen, shakuhachi, koto, taiko, a wooden clapper.
- Foley: rain on straw hats; sandals on a wooden bridge; oars; wind in pines; a paper door.
- Ambience: the place of the print: shore, rain, a market, a mountain road.
- Silence: the clapper strikes once and everything stops; one held print.
- Voice: measured, like a travel diary read aloud.
- Default score field: shamisen and shakuhachi, sparse, pentatonic (60–90 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **The loop print.** One thing repeats forever inside a still print: a wave, rain, a flag. *Build:* loop link, FL2VA with the hero frame as first and last frame, repeat on the timeline. *Fits content like:* a shore; a rainy bridge; a mill wheel.
- **Stations of a road.** A series of prints, one per place, same sky band. *Build:* montage shots, 5 s each, static camera, consistent grade, cut on the beat. *Fits content like:* a pilgrimage; a delivery route; a company's cities.
- **Registration shift.** The colour blocks slide off the keyblock and back. *Build:* assembler effect over a cut, or a beat 'the colours slip a little and settle'. *Fits content like:* an earthquake; a memory; a mistake corrected.
- **Cartouche title.** The title appears inside a printed rectangle. *Build:* assembler title with a flat colour box; the model never draws text. *Fits content like:* chapter names; place names; dates.

## 9. Pitfalls of the medium (what H3 gets wrong)

- The model renders depth of field and soft shading. → Say 'flat colour fields, no shading, thin dark outline' in the beat suffix; dof deep.
- Faces drift to anime. → Keep figures small or in profile; describe faces as 'a few printed lines'.
- Perspective becomes photographic. → Describe stacked planes: 'the far mountain sits high and small'.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "animated ukiyo-e woodblock print, Edo-period travel series",
    "palette": "flat printed colour fields, Prussian blue water, bokashi gradient sky, one vermilion accent",
    "camera": "static prints with one moving element, slow pans across stations",
    "lens": "flat graphic perspective, stacked planes, no vanishing point",
    "lighting": "no cast light; colour fields carry the hour",
    "aspectRatio": "16:9"
  },
  "negative": [
    "no shading or gradients on figures",
    "no photographic depth of field"
  ],
  "cinematography": {
    "lens": "normal",
    "dof": "deep",
    "lighting": [
      "overcast"
    ],
    "grade": "muted",
    "texture": "halftone",
    "animation": "comic",
    "pace": "still"
  },
  "bySize": {
    "els": {
      "lens": "wide"
    },
    "insert": {
      "lens": "macro"
    }
  },
  "loras": [],
  "beatSuffix": "Everything is a flat woodblock print with thin dark outlines and bokashi gradients on washi paper."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: the place or road, the one moving element, the accent, structure, opening, ending.

- Structures: stations along one road; one view in four seasons; one print whose single moving thing changes meaning three times.
- Openings: a blank washi sheet, the keyblock printed first; a wave mid-break; a cartouche with the title before any picture.
- Endings: the full sheet pulled out to show the series on a wall; the moving thing stops; the print lifted off the block.
