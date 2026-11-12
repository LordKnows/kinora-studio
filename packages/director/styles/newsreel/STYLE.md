# 1920s Newsreel · 1920 年代新闻影片 — Style Prompt

> A cinema newsreel: brisk monochrome actuality, title cards with a date, a brass band and a confident announcer.
> 影院新闻片：明快的黑白实况、带日期的字幕卡、铜管乐队和自信的播音员。

<!-- generated from style.json by @openhiggsfield/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Edit & Documentary · 剪辑与纪实  
**Uses:** History stories · Fads and eras · Anniversaries · Tongue-in-cheek announcements

## 1. Essence, and what it is not

- Monochrome actuality footage: crowds, streets, factories, parades, slightly fast.
- Title cards with a dateline and a headline between items; an announcer over the picture.
- Brisk cutting; every item short; a brass march underneath.
- Print damage, flicker, a vignette; the camera mostly locked on a tripod.
- Cheerful, authoritative, a little absurd.

- Not a silent comedy: there is a voice and music throughout.
- Not a modern documentary: no interviews, no handheld.
- Not sepia nostalgia: silver greys, high contrast.

## 2. Materials & rendering

- 35 mm nitrate look: grain, scratches, flicker, soft halation.
- Period streets, crowds, machines, costume; painted signs allowed but illegible.
- Tripod framing; a few pans.

## 3. Colour logic

- Monochrome silver, high contrast, slight flicker.
- No tinting; the cards are white on black.
- Values: pale skies, dark crowds, bright faces.
- Example only: silver #d6d2c6, mid #85817a, black #171614

## 4. Type & subtitles

- Titles: a condensed Gothic or Art Deco display face, white on black with a border
- Subtitles: not used; the announcer carries the words
- Placement: a dateline card before each item; a headline card between items; by the assembler
- Cards are 3–4 s; never text over the picture.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Slightly fast (undercranked) action; crowds move briskly.
- Cut every 3–6 s inside an item; items 10–20 s each.
- The music drives the pace; the announcer never pauses.
- Stepping: on ones.
- Never moves: the title card.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `static` (tripod wide of the event) | the actuality | a parade; a launch; a crowd |
| `pan` (slow, across a crowd or a line of machines) | scale, numbers | a factory; a stadium; a fleet |
| `static` (medium of a demonstrator) | the thing itself | a gadget; a dance step; a stunt |
| `tilt` (up a new building or machine) | progress | a tower; an airship; a bridge |
| `tracking` (from a car or a train) | the modern age | a motorcade; a railway; a city tour |

- Framing: Wide and medium tripod shots; people look at the camera sometimes.
- Framing: A card before every item.
- Transitions: cut, fade_black; never dissolves, wipes, flashes.
- Preferred links: cut, montage, jump_cut.

## 7. Sound palette

- Instruments: brass band march, snare rolls, a xylophone for comedy items, a fanfare for the opening.
- Foley: crowd murmur; engines; applause; a whistle; all thin and band-limited like optical sound.
- Ambience: optical-track hiss and crackle under everything.
- Silence: none inside items; a beat of hiss on the card between items.
- Voice: a mid-Atlantic announcer, fast, confident, never pausing; band-limited.
- Default score field: brass band march, optical-track thin, continuous (110–130 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **The dateline card.** A card with place and date opens every item. *Build:* assembler title card before the item's first shot; hiss on the card. *Fits content like:* a city; a factory; a resort.
- **The demonstration.** A person shows the thing to the camera. *Build:* ms static shot, reference mode for the demonstrator, one action per beat. *Fits content like:* a gadget; a dance craze; a diet.
- **The crowd pan.** A slow pan proves the numbers. *Build:* pan move, els, pace brisk, vfx none. *Fits content like:* a rally; a beach; an opening day.
- **The stunt.** A brief daring act, cut short. *Build:* a 5 s montage shot, cut on the beat, undercranked. *Fits content like:* a wing walker; a flagpole sitter; a record attempt.

## 9. Pitfalls of the medium (what H3 gets wrong)

- The footage looks modern and clean. → texture 8mm or 16mm, grade mono; 'scratched 1920s newsreel print, slightly fast' in the suffix.
- Lip-synced speech appears. → No dialogue field; the announcer is a narration track added by the assembler.
- Legible modern signs appear. → Negatives 'no readable text'; describe 'painted period signs'.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "1920s cinema newsreel, monochrome actuality, brisk and upbeat",
    "palette": "high-contrast silver monochrome, flicker, pale skies, no tint",
    "camera": "tripod wides and mediums, slow crowd pans, a tracking shot from a car",
    "lens": "normal, deep focus, period glass",
    "lighting": "daylight actuality, arc-lamp interiors",
    "aspectRatio": "16:9"
  },
  "negative": [
    "no colour",
    "no modern clothes or cars",
    "no handheld"
  ],
  "cinematography": {
    "lens": "normal",
    "dof": "deep",
    "lighting": [
      "harshsun"
    ],
    "grade": "mono",
    "texture": "16mm",
    "pace": "brisk"
  },
  "bySize": {
    "els": {
      "lens": "wide"
    }
  },
  "loras": [],
  "beatSuffix": "A flickering 1920s newsreel print, slightly fast crowds, tripod framing."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: the items and their order, the announcer's angle, which item is the stunt, the opening fanfare, ending.

- Structures: three items in rising absurdity; one event covered from three cities; a fad's rise and fall in four cards.
- Openings: the fanfare and the newsreel's own title card; a crowd pan with the announcer already talking; a stunt in progress.
- Endings: the band's last chord on a card; a demonstrator tipping a hat; the print burning out.
