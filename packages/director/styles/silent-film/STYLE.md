# 1920s Silent Film · 1920 年代默片 — Style Prompt

> A one-reel silent comedy: locked wide shots, intertitles, a piano in the pit and a flickering print.
> 一卷默片喜剧：固定的全景、字幕卡、乐池里的钢琴和闪烁的胶片。

<!-- generated from style.json by @kinora/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Cinema & Eras · 电影与时代  
**Uses:** Comedy · Retro brands · Silent storytelling · Anniversaries

## 1. Essence, and what it is not

- A 4:3 silver print: flicker, weave, scratches, burnt edges, slightly undercranked motion.
- Nobody speaks; beats are told by action in wide shots and by intertitle cards.
- The camera is heavy: most shots locked, the occasional tracking shot on a cart.
- The only sound is a cinema instrument and the projector.
- Gags are mechanical chains the audience sees whole.

- Not noir: no hard mood shadows, no voice-over.
- Not a sepia filter on modern footage: the acting, framing and speed are period.
- Not a Chaplin impression: no borrowed costume, walk or moustache.

## 2. Materials & rendering

- Orthochromatic look: pale skies, dark reds, soft halation on whites.
- Print damage: scratches, dust, flicker, gate weave, a vignette.
- Period sets and costume; painted backdrops allowed.

## 3. Colour logic

- Monochrome silver; tinting per section (amber day, blue night, rose romance) is allowed, one tint per section.
- Values carry everything: dark clothes against pale walls, pale faces in dark rooms.
- At most one hand-coloured element, or none.
- Example only: silver #d9d4c7, mid #8b877c, black #1b1a17; tints amber #c89a4a, blue #4a6a8a

## 4. Type & subtitles

- Titles: an Art Nouveau or engraved serif, white on black card with a decorative border
- Subtitles: not used; intertitles replace subtitles
- Placement: intertitle cards between shots, 3–5 s each, by the assembler
- Intertitles are full-frame cards; never burn text over the picture.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Slightly fast (undercranked) action; performers act with the whole body.
- Big, readable gestures; a held look to camera is allowed.
- Chaos rises with speed and print damage together.
- Stepping: on ones.
- Never moves: the curtain frame, the intertitle card.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period. A default from cost, not a measured limit.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `static` (locked extreme wide) | cause and effect seen whole; the wait is the joke | a mechanical gag; a crowd; an elaborate process |
| `static` (locked full shot) | the premise in one frame | a character's routine; a confrontation |
| `tracking` (on a cart, foreground passing) | pursuit, momentum | a chase; a race; a delivery against the clock |
| `push_in` (slow, motivated) | tenderness, realisation | a kneel; a letter read; a decision |
| `zoom` (iris in or out) | attention on one thing; a beginning or end | an object; a face; a memory |

- Framing: Wide and medium shots; keep close-ups inside an iris.
- Framing: Performers face the camera as on a stage.
- Transitions: cut, iris, fade_black; never dissolves within a scene, whip pans, flashes.
- Preferred links: cut, continuous, insert_return, jump_cut.

## 7. Sound palette

- Instruments: upright piano, reed organ, a violin for romance.
- Foley: none: the piano plays every event (a chromatic creep, a cluster for a crash, a glissando for a fall).
- Ambience: the projector: lamp click, motor purr, film flapping.
- Silence: the piano stops; only the projector; it frames a held moment.
- Voice: none; intertitles carry the words.
- Default score field: upright piano, photoplay idiom, mickey-mousing every event (100–150 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **The chain in one take.** A triggers B, B leaves, the audience waits, B returns and hits C. *Build:* a 15 s static els shot, beats for each link; continuous link for a second take if longer. *Fits content like:* a supply chain gone wrong; how a rumour spreads; a Rube Goldberg invention.
- **The intertitle twist.** A card reframes the next shot in a few words. *Build:* assembler intertitle between two shots; the second shot is a cut. *Fits content like:* 'Meanwhile, in the lab…'; 'The machine had other ideas.'; a statistic as a punchline.
- **Iris on the look.** An iris stops halfway so a character can glance at the audience. *Build:* assembler iris transition over a cu shot ending on a look to camera. *Fits content like:* a product winking; a cat that knows; a secret.
- **Undercranked chaos.** Speed and print damage rise together. *Build:* pace frantic, vfx speedramp, texture 8mm on the climax shot. *Fits content like:* rush hour; a kitchen at dinner service; a stock crash.

## 9. Pitfalls of the medium (what H3 gets wrong)

- The model renders clean modern monochrome. → texture 8mm, vfx none; say 'scratched flickering 1920s nitrate print, slightly fast motion' in the suffix.
- Characters speak and lip-sync. → No dialogue field; describe 'exaggerated silent acting, mouths closed or mouthing'.
- Close-ups look modern. → Keep ms or wider; iris added in the assembler.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "1920s silent one-reel comedy, slapstick, tender",
    "palette": "monochrome silver nitrate print with halation, amber or blue tint per section",
    "camera": "locked wide and full shots, a cart tracking shot, iris in and out",
    "lens": "normal, deep focus, period glass",
    "lighting": "flat daylight or arc-lamp stage light, pale skies",
    "aspectRatio": "16:9"
  },
  "negative": [
    "everyone wears 1920s clothes and hair: bowler hats, bobbed hair, high collars",
    "actors mime and gesture; the soundtrack is a solo pit piano"
  ],
  "cinematography": {
    "lens": "normal",
    "dof": "deep",
    "lighting": [
      "highkey"
    ],
    "grade": "mono",
    "texture": "8mm",
    "pace": "brisk"
  },
  "bySize": {
    "cu": {
      "pace": "slow"
    },
    "els": {
      "lens": "wide"
    }
  },
  "loras": [],
  "beatSuffix": "A flickering 1920s silent-film print, exaggerated silent acting, slightly fast motion."
}
```

Style LoRAs that may suit it (not applied by default; none has been rendered with this preset, so try one probe take with and without):

- `lora_fal_realism_people` at 0.6: full and medium shots of the performers, so faces and hands read as photographed people under the print damage. Lower than its card's 0.8 because it stacks on the turbo LoRA.

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: the gag chain, the tint per section, which shot gets the tracking cart, the intertitle lines, opening, ending.

- Structures: one chase through one building; a courtship in three failed gifts; a machine demonstrated, then revolting.
- Openings: the curtain opens on a title card; an iris opens on the hero asleep; a locked wide of an empty street before the crowd.
- Endings: iris on a kiss or a wink; the chain completes a second time, correctly; the film burns in the gate.
