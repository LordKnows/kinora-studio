# Glass Product Render · 玻璃质感产品 — Style Prompt

> One fictional object of glass, metal and light in an infinite black studio; every move lands on the beat.
> 一个虚构的玻璃金属物体悬浮在无限黑色影棚里，每一次运镜都落在节拍上。

<!-- generated from style.json by @openhiggsfield/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Materials & 3D · 材质与 3D  
**Uses:** Product launches · Consumer tech · Beauty and fragrance · Audio and wearables

## 1. Essence, and what it is not

- A single hero object floating in black; long light strips behind and beside it.
- Clear glass reads as thin white outlines with rainbow edges; internals show through.
- Brushed metal, frosted shells, light that travels inside channels.
- Slow, precise, beat-locked motion; every cut on a bar line.
- The object is always fictional: no real product silhouette, name or logo.

- Not a white-cyclorama catalogue shot: the ground is black.
- Not a wireframe HUD: material and light are the subject.
- Not a keynote slide: no text, no bullets.

## 2. Materials & rendering

- Glass with dispersion; frosted glass that clears; brushed and polished metal.
- Strip lights reflected as long highlights; a mirror floor with soft caustics.
- Internal emissive channels: data, charge, heat as light.

## 3. Colour logic

- Black ground, white strips, one accent light colour inside the object.
- Rainbow dispersion only at thick glass edges.
- Never a coloured background.
- Example only: black #050506, strip white #f4f4f0, accent #2fd8ff or #ff6a3d, metal #b9bcc2

## 4. Type & subtitles

- Titles: a light geometric sans, wide tracking, white
- Subtitles: the same, small, lower third
- Placement: a claim or a number in negative space after a pull-back; the assembler adds it
- Type only in shots with room for it; never over the object.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Everything slow and precise; a light sweep or a pulse marks each beat.
- Parts float apart and snap back on a downbeat.
- No spatial continuity needed between shots: each is its own stage.
- Stepping: on ones.
- Never moves: the black ground.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `push_in` (a sweep over a dark object) | contour before content | an unknown thing; a before-state |
| `arc` (slow high three-quarter orbit) | the whole object in one move | a mechanism opening; variants |
| `static` (macro, rack focus shell → part inside) | nothing to hide | an ingredient; a sensor |
| `arc` (low orbit under the object) | monument, weight | durability; a flagship |
| `pull_out` (into negative space) | room for type | a claim; a question |
| `tilt` (top-down on the floor) | the effect leaving the object | range; spreading energy |

- Framing: One hero, centred or on a strong diagonal, never cropped in a wide.
- Framing: Cut only on beats.
- Transitions: cut, fade_black; never dissolves, wipes.
- Preferred links: cut, montage, match_cut, loop.

## 7. Sound palette

- Instruments: sub bass, a filtered pad, glass-like mallets, a single clean piano note, a riser.
- Foley: a glass tick on each highlight; a soft magnetic snap for parts closing; a low whoosh for sweeps; a pulse for light travelling.
- Ambience: none; silence is the studio.
- Silence: one bar of nothing before the snap or the reveal.
- Voice: a calm, low voice saying very little, or none.
- Default score field: minimal electronic, sub and mallets, beat-locked (80–110 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **Transparency.** The inside is the hero; rack focus from shell to part within. *Build:* dof rack, camera static, beat names the two subjects. *Fits content like:* a juicer's blades; a watch movement; a capsule's layers.
- **Light that travels inside.** Energy runs as light through channels. *Build:* beats: 'a cyan pulse travels from the base through the channel to the tip'; vfx bloom. *Fits content like:* a battery filling; a router's data threads; a kettle heating.
- **Exploded view and snap.** Parts float apart and snap back on a downbeat. *Build:* two beats in one shot; cut before the snap on the bar line. *Fits content like:* a modular backpack; a pen's refill; a repairable phone.
- **Frost to clear.** A frosted shell clears and the inside appears. *Build:* beat 'the frosted shell turns clear from the top down'. *Fits content like:* a privacy feature; a fridge's contents; a price breakdown.
- **Caustic ring.** An internal pulse becomes a ring on the floor. *Build:* tilt to top-down, loop link for a repeating pulse. *Fits content like:* a speaker's range; a perfume's trail; a charger's field.

## 9. Pitfalls of the medium (what H3 gets wrong)

- The object resembles a real brand's product. → Describe a fictional silhouette in the prop element; negatives 'no logos, no real products'.
- The background gains a gradient or a room. → Say 'infinite black studio, only strip lights' in every beat suffix.
- Glass renders as plastic. → Name 'thick clear glass with rainbow dispersion at the edges, internals visible'.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "high-end product film, glass and metal in a black studio, beat-locked",
    "palette": "black ground, white light strips, one accent light inside the object, rainbow dispersion at edges",
    "camera": "slow orbits, macro rack focus, pull-backs into negative space",
    "lens": "macro to portrait, shallow focus",
    "lighting": "long strip lights behind and beside the object, mirror floor, no fill",
    "aspectRatio": "16:9"
  },
  "negative": [
    "no on-screen text",
    "no logos",
    "no subtitles",
    "no real products",
    "no coloured background",
    "no hands"
  ],
  "cinematography": {
    "lens": "macro",
    "dof": "shallow",
    "lighting": [
      "rim",
      "lowkey"
    ],
    "grade": "muted",
    "texture": "digital",
    "animation": "cgi",
    "pace": "slow"
  },
  "bySize": {
    "els": {
      "lens": "normal",
      "dof": "medium"
    },
    "ls": {
      "lens": "portrait"
    }
  },
  "loras": [],
  "beatSuffix": "A fictional glass-and-metal object floating in an infinite black studio lit by long white strips."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: the fictional object, its internals, the accent light, structure, opening, ending.

- Structures: a line-up of three variants compared by what glows inside; one object through morning, noon and night strips; a material stack, one layer removed per beat.
- Openings: inside first: one internal part, the shell forms around it; caustic first: light on the floor, followed up to the object; silhouettes: several dark outlines, one begins to glow.
- Endings: floor only: the object leaves, its caustic keeps pulsing; cool down: emission fades to bare outlines; held macro: one detail, no pull-back.
