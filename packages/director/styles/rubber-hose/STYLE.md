# 1930s Rubber Hose Cartoon · 1930 年代橡皮管卡通 — Style Prompt

> Black-and-white cartoon on film: noodle limbs, pie-cut eyes, everything bounces to the beat.
> 黑白胶片卡通：面条四肢、派切眼睛，万物随节拍弹跳。

<!-- generated from style.json by @kinora/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Cartoon & Anime · 卡通与动画  
**Uses:** Food and drink · Retro brands · Kids · Musical gags

## 1. Essence, and what it is not

- Monochrome ink on film: greys, a soft halo on whites, dust and a wobble in the gate.
- Characters are tubes and circles: no elbows, no knees, white gloves, pie-cut pupils.
- Everything is alive and bounces on the beat; objects have faces.
- Gags are mechanical and readable at thumbnail size.
- The music is a jazz band and every action is a note.

- Not a modern flat vector cartoon: there is film grain and ink texture.
- Not a horror pastiche: cheerful, not sinister.
- Not sepia: silver greys.

## 2. Materials & rendering

- Ink line of even width, warm black on cream cel; grey washes for tone.
- Film grain, light flicker, a slight weave; dust specks.
- Backgrounds in soft pencil and wash.

## 3. Colour logic

- Greys only; white is a halo, black is ink.
- Tone separates figure from ground: dark figures on light sets.
- No colour, ever.
- Example only: cream #e9e2cf, light grey #b5ae9d, mid grey #6e685c, ink #1a1714

## 4. Type & subtitles

- Titles: a bouncy hand-lettered display face
- Subtitles: a rounded sans, cream on dark
- Placement: title cards on their own; subtitles bottom centre
- A title card is a static shot with no picture, done by the assembler.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Bounce on every beat; squash and stretch on every landing.
- Limbs swing like rope; bodies tilt with the music.
- Hold a pose one beat before a gag.
- Stepping: on twos (ask for stepped motion in the beats; the camera stays smooth).
- Never moves: the film gate, the title card.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period. A default from cost, not a measured limit.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `static` (locked full shot) | the stage; the gag plays whole | a routine; a chase in one frame; a dance |
| `truck` (side scroll with a looping background) | a chase that goes nowhere | a pursuit; a parade; a walk to work |
| `push_in` (quick, on a reaction) | the take | a surprise; a decision; a punchline |
| `pan` (whip to the next gag) | meanwhile | a second character; the cause; the band |
| `zoom` (iris in or out) | beginning or end | the opening; the ending; a wink |

- Framing: Full shots; a gag reads whole.
- Framing: Faces big enough for the pie-cut eyes to read.
- Transitions: cut, iris, fade_black; never dissolves, wipes, flashes.
- Preferred links: cut, continuous, insert_return, loop.

## 7. Sound palette

- Instruments: muted trumpet, clarinet, banjo, tuba, piano, washboard.
- Foley: slide whistle; boing; pop; a bicycle horn; xylophone steps; a cowbell.
- Ambience: the band in the room; no realistic beds.
- Silence: the band stops; a held pose; one tiny sound (a drip, a tick).
- Voice: scat and nonsense syllables more than words; short lines.
- Default score field: hot jazz band, swing, every action a note (120–160 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **Everything dances.** Objects and buildings bounce in time. *Build:* loop link: one bar of bounce as FL2VA, repeat on the timeline. *Fits content like:* a kitchen; a factory; a city block.
- **The stretch.** A limb or neck stretches across the frame to reach a thing. *Build:* single beat 'the arm stretches like rubber across the room to…', camera static. *Fits content like:* grabbing a cookie; reaching a switch; a handshake across a street.
- **Iris on the wink.** An iris closes on the hero's wink. *Build:* assembler iris transition after a cu shot ending on a wink. *Fits content like:* endings; a secret; a brand sign-off.
- **Object with a face.** The product itself joins the dance. *Build:* prop element described with eyes and gloves; reference mode. *Fits content like:* a coffee cup; a bottle; a phone.

## 9. Pitfalls of the medium (what H3 gets wrong)

- The model adds colour or modern shading. → grade mono, texture 8mm or 16mm; say 'black and white 1930s ink cartoon' in the suffix.
- Limbs get elbows and realistic hands. → Describe 'rubber-hose tube limbs, no joints, white gloves' in character elements.
- Gags are too fast to read. → One gag per shot; hold a beat before and after.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "1930s black-and-white rubber-hose cartoon short, musical gag comedy",
    "palette": "silver greys and warm ink on cream, film grain, no colour",
    "camera": "locked full shots, side scrolls, quick push-ins on reactions, iris in and out",
    "lens": "normal, flat cartoon depth",
    "lighting": "flat; tone separates figure and ground",
    "aspectRatio": "16:9"
  },
  "negative": [
    "limbs bend in smooth curves like hoses; hands are white four-finger gloves",
    "flat ink-and-paint drawings with one even line weight"
  ],
  "cinematography": {
    "lens": "normal",
    "dof": "deep",
    "lighting": [
      "highkey"
    ],
    "grade": "mono",
    "texture": "16mm",
    "animation": "flat2d",
    "pace": "brisk"
  },
  "bySize": {
    "cu": {
      "pace": "steady"
    }
  },
  "loras": [],
  "beatSuffix": "Black-and-white 1930s rubber-hose cartoon, tube limbs and pie-cut eyes, everything bouncing to the beat."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: the gag chain, who has a face, the band's tempo, structure, opening, ending.

- Structures: one chase around one room; a product's day told as a dance; three attempts, the third works.
- Openings: an iris opens on the band; the title card bounces; a sleeping object wakes to the beat.
- Endings: iris on a wink; the band collapses; the object takes a bow.
