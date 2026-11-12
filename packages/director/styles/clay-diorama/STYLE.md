# Clay Diorama · 黏土微缩景观 — Style Prompt

> A tabletop world of clay, felt and painted wood, filmed in stop-motion with fingerprints left in.
> 黏土、毛毡和彩绘木头搭成的桌面世界，定格拍摄，指纹留在上面。

<!-- generated from style.json by @openhiggsfield/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Materials & 3D · 材质与 3D  
**Uses:** Web and app heroes · Ambient loops · Seasons and nature · Handmade brands

## 1. Essence, and what it is not

- Everything is handmade: clay with fingerprints, felt with fibres, painted wood with brush marks.
- A single diorama on a table, seen from above at an angle; the edge of the base is allowed in frame.
- Stop-motion stepping; things squash, stretch and wobble.
- Bold, chalky, matte colours; no gloss.
- One world, one take, the seasons or hours turn inside it.

- Not CGI claymation: real-material imperfections are the point.
- Not a brick toy: no studs, no plastic gloss.
- Not a miniature photo: the materials are obviously craft.

## 2. Materials & rendering

- Modelling clay with fingerprints and tool marks; felt and wool; painted balsa.
- A tabletop base with a visible edge; a cardboard sky.
- Soft studio light with one warm key; matte surfaces.

## 3. Colour logic

- Chalky pastels with one or two saturated accents; nothing glossy.
- The base is a single colour felt or painted wood.
- The season or hour changes the key colour, not the materials.
- Example only: felt green #7fa86a, clay terracotta #c97b5a, sky card #cfe3ef, accent coral #f0735a, wood #d8b98a

## 4. Type & subtitles

- Titles: a soft rounded display face, as if cut from felt
- Subtitles: a rounded sans, cream
- Placement: titles in the cardboard sky; captions bottom
- Words are assembler captions; the model never letters.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Stop-motion at 12 fps; objects wobble slightly when they stop.
- One continuous diorama; changes happen in place, not by cutting away.
- The camera moves slowly on an arc around the table.
- Stepping: on twos (ask for stepped motion in the beats; the camera stays smooth).
- Never moves: the table edge, the cardboard sky.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `arc` (slow orbit around the diorama) | the world as object | a season cycle; a day; a tour |
| `static` (high oblique, the diorama changing inside) | time as the actor | seasons; a build; a crowd arriving |
| `push_in` (into one corner of the set) | a small drama | a character; a house; a shop |
| `pull_out` (to show the table edge) | it is a model | an ending; a reveal; a chapter |
| `pedestal` (down to clay-figure height) | entering the world | an opening; a meeting; a street |

- Framing: High oblique with the base edge in wides; eye level for figures.
- Framing: The accent colour is always in frame.
- Transitions: cut, fade_black; never dissolves, wipes, flashes.
- Preferred links: continuous, loop, jump_cut, cut.

## 7. Sound palette

- Instruments: kalimba, marimba, ukulele, a soft synth pad, a shaker.
- Foley: clay squelch; felt rustle; a wooden tap; tiny footsteps; a paper bird.
- Ambience: a craft room; a window; birds.
- Silence: the diorama holds; one wobble settles; the next season starts alone.
- Voice: soft, amused, or none for ambient loops.
- Default score field: kalimba and marimba, looping, gentle (80–110 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **Seasons in place.** The same diorama turns through seasons without cutting. *Build:* continuous chain of 10–15 s shots, static camera, beats name the season's colour change. *Fits content like:* a farm; a river bend; a town square.
- **Ambient loop.** A periodic motion that runs forever. *Build:* loop link, FL2VA, repeat on the timeline. *Fits content like:* a windmill; a ferry; a bakery queue.
- **Squash and spring.** A clay thing squats and springs back to mark a change. *Build:* one beat: 'the big tree squats and springs back; the leaves turn'. *Fits content like:* a turn of season; a new day; a transition.
- **Table-edge reveal.** Pull out until the base edge shows. *Build:* pull_out, strong amplitude, els, last shot. *Fits content like:* endings; a maker's reveal; a behind-the-scenes.

## 9. Pitfalls of the medium (what H3 gets wrong)

- Materials render as smooth CGI. → animation claymation; 'fingerprints in the clay, felt fibres' in the suffix.
- Motion is smooth and real-time. → Say 'stop-motion, stepped' in beats; pace steady.
- The diorama becomes a full landscape. → Keep 'tabletop with the base edge visible' in wides.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "stop-motion clay and felt diorama, handmade, ambient and warm",
    "palette": "chalky matte pastels, one or two saturated accents, felt green base, card sky",
    "camera": "slow orbits around a tabletop, high oblique holds, push-ins to corners",
    "lens": "normal to macro, moderate depth",
    "lighting": "soft studio light with one warm key, matte surfaces",
    "aspectRatio": "16:9"
  },
  "negative": [
    "no hands",
    "no glossy plastic"
  ],
  "cinematography": {
    "lens": "normal",
    "dof": "medium",
    "lighting": [
      "highkey",
      "golden"
    ],
    "grade": "pastel",
    "texture": "digital",
    "animation": "claymation",
    "pace": "steady"
  },
  "bySize": {
    "cu": {
      "lens": "macro",
      "dof": "shallow"
    }
  },
  "loras": [],
  "beatSuffix": "A handmade clay and felt diorama on a tabletop, stop-motion, fingerprints and fibres visible."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: the world, what turns inside it, the accent, structure, opening, ending.

- Structures: four seasons in one take; a day from first light to lamps; a town built in three stages.
- Openings: a bare felt base, the first clay tree pressed on; mid-season with one figure moving; the maker's lamp switching on.
- Endings: the base edge revealed; the loop continues as the music fades; winter and the lamp off.
