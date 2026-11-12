# Mid-century Flat Explainer · 50 年代扁平讲解 — Style Prompt

> Flat shapes, limited palette, a confident narrator: the 1950s instructional cartoon.
> 扁平色块、有限配色、沉稳旁白：50 年代的教学动画。

<!-- generated from style.json by @openhiggsfield/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Cartoon & Anime · 卡通与动画  
**Uses:** How-to and set-up guides · Help centres · Product onboarding · Public information

## 1. Essence, and what it is not

- Flat geometric shapes with paper-print texture; no outlines, overlapping colour fields.
- A four-colour palette plus black and off-white, one accent for the thing being taught.
- Stylised people: simple heads, long limbs, no faces beyond a dot and a line.
- Motion is clean and mechanical; objects slide, rotate and pop on the beat.
- One idea per shot, narrated.

- Not corporate vector motion graphics: there is print texture and misregistration.
- Not rubber hose: no bounce, no gags, colour allowed.
- Not a UI screencast: no interface chrome.

## 2. Materials & rendering

- Screen-print colour fields with slight misregistration and halftone in the shadows.
- Off-white paper ground.
- Shapes cut from paper: hard edges, no gradients.

## 3. Colour logic

- Four colours plus black and off-white; the accent is reserved for the thing being explained.
- Backgrounds are a single flat field; depth by overlap only.
- Never a gradient.
- Example only: paper #f4efe2, teal #2a8c8c, mustard #e2b13c, brick #c8553d, navy #243a5e, ink #1e1b18

## 4. Type & subtitles

- Titles: a geometric sans (Futura-like), bold, on a flat colour block
- Subtitles: the same sans, regular
- Placement: titles as flat colour cards; captions bottom-left on a colour block
- Numbers and labels are assembler captions; the model never draws them.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Things arrive by sliding or popping, on the beat.
- A diagram builds one element per beat.
- The camera rarely moves; the layout does.
- Stepping: on ones.
- Never moves: the paper ground.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `static` | the diagram; the layout does the work | a step; a comparison; a list |
| `truck` (slide to the next panel) | next step | a sequence; a process; before and after |
| `push_in` (on the accent object) | this is the part | a detail; a warning; a result |
| `pull_out` (to the whole system) | how it fits | a summary; a map; a recap |

- Framing: Centred compositions with generous margins.
- Framing: The accent-coloured thing is never cropped.
- Transitions: cut, wipe, fade_white; never dissolves, glitches, flashes.
- Preferred links: cut, jump_cut, insert_return, montage.

## 7. Sound palette

- Instruments: vibraphone, clarinet, upright bass, brushed snare, a cheerful flute.
- Foley: paper slides; a soft pop when a shape appears; a click for a step done; a chime for the result.
- Ambience: none; the narrator's room.
- Silence: the narrator pauses; the shape sits alone one beat.
- Voice: confident, friendly, mid-century announcer; one sentence per shot.
- Default score field: light vibraphone and clarinet, mid-tempo, unobtrusive (96–120 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **Build the diagram.** One element pops in per beat until the system is complete. *Build:* static shot, up to 6 beats each adding one shape; the caption names each in the assembler. *Fits content like:* how a router works; a recipe's ingredients; a team's roles.
- **Slide to the next panel.** The whole layout trucks sideways to the next step. *Build:* continuous link with camera truck; the next shot's beats start where the slide lands. *Fits content like:* set-up steps; a timeline; a before-after.
- **The accent swap.** Only the taught thing has the accent colour; it moves between objects. *Build:* jump_cut with beats 'the brick colour passes from the plug to the socket'. *Fits content like:* which cable goes where; whose turn it is; which option to pick.
- **The simple person.** A long-limbed figure demonstrates with one gesture. *Build:* character element described as 'flat paper-cut figure, dot eyes'; reference mode. *Fits content like:* a user; a customer; a technician.

## 9. Pitfalls of the medium (what H3 gets wrong)

- The model adds gradients and 3D shading. → Say 'flat paper-cut shapes, no gradients, screen-print texture' in the suffix; dof deep.
- Text appears in the frame. → Keep 'no on-screen text' and add labels in the assembler.
- Too many ideas per shot. → One idea per shot; split the diagram across jump cuts.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "1950s mid-century flat instructional cartoon, friendly explainer",
    "palette": "four flat print colours plus black and off-white paper, one accent for the subject",
    "camera": "mostly locked; layout slides to the next panel",
    "lens": "flat graphic, no perspective",
    "lighting": "none; flat fields, halftone shadows",
    "aspectRatio": "16:9"
  },
  "negative": [
    "no gradients",
    "no 3D shading",
    "no realistic faces"
  ],
  "cinematography": {
    "lens": "normal",
    "dof": "deep",
    "lighting": [
      "highkey"
    ],
    "grade": "muted",
    "texture": "halftone",
    "animation": "flat2d",
    "pace": "steady"
  },
  "bySize": {
    "insert": {
      "lens": "macro"
    }
  },
  "loras": [],
  "beatSuffix": "Flat mid-century paper-cut shapes with screen-print texture, no gradients, one accent colour."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: the accent object, the four colours, the number of steps, structure, opening, ending.

- Structures: five steps, one panel each; a wrong way then the right way; a question, three options, one answer.
- Openings: the accent object alone on paper; a figure holding the problem; a title card that slides off to reveal step one.
- Endings: the full system pulled out; the figure gives a thumbs up; the accent object fades to paper.
