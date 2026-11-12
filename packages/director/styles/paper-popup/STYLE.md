# Paper Pop-up Book · 纸艺立体书 — Style Prompt

> A pop-up book opening page by page: layered card, fold lines, paper cities rising under a lamp.
> 一页页打开的立体书：层叠卡纸、折痕、台灯下升起的纸城。

<!-- generated from style.json by @stave/director; edit the JSON. Structure after lemo-opuscar STYLE.md (CC BY 4.0); text written for the H3 pipeline. -->

**Category:** Materials & 3D · 材质与 3D  
**Uses:** Children's stories · Brand origin stories · Game and fantasy trailers · Places and travel

## 1. Essence, and what it is not

- Everything is cut card: layered flat shapes with visible edges, fold lines and tabs.
- Scenes rise as a page opens and fold flat as it closes.
- A real desk lamp lights the book; paper casts soft shadows on paper.
- Characters are paper puppets on tabs, moving in slides and flips.
- Warm, tactile, handmade.

- Not flat 2D: the layers have real depth and shadow.
- Not origami: cut and glued card, not folded sculpture.
- Not CGI paper: edges are fibrous, glue is visible.

## 2. Materials & rendering

- Coloured card with visible fibre at the cut edge; printed textures on the card.
- Fold lines, tabs, a central gutter; a book on a wooden desk.
- Lamp light from one side; soft paper shadows.

## 3. Colour logic

- Each page has its own card palette of four or five colours.
- The book's ground is cream card; the desk is dark wood.
- One accent character or object in a colour no other card uses.
- Example only: cream #f1e8d2, forest #3a6b4a, sky #a8cbe5, terracotta #c4663f, night #2c3350

## 4. Type & subtitles

- Titles: a storybook serif, printed on the page
- Subtitles: a serif, cream on dark card
- Placement: titles on the book's cover or a page corner; captions bottom
- Words are assembler captions; the page's printed text must be illegible decoration or absent.
- Reading time: hold every caption ≥ max(1.8 s, speech + 0.6 s); CJK characters ÷ 4.5 + Latin letters ÷ 15 + 1.5 s.

## 5. Motion quality

- Pages open and close at a reader's pace; the scene rises with the page.
- Puppets slide along slots and flip; nothing walks naturally.
- The camera is the reader's eye: slow, close, over the gutter.
- Stepping: on ones.
- Never moves: the desk, the lamp.
- Shot length: action shots (characters, dialogue, more than one beat, brisk or frantic) 5 s, at most 8 s, chained with `continuous` for longer action; static one-beat holds 10 s; periodic motion as a `loop` of one period. A default from cost, not a measured limit.

## 6. Camera grammar

A vocabulary, not a route. Opening and ending come from the topic.

| Move | What it expresses | Can serve |
|---|---|---|
| `tilt` (over the gutter as the page opens) | a world rising | a new place; a chapter; a morning |
| `push_in` (into one layer of the page) | entering the story | a house; a forest path; a window |
| `truck` (along the layers for parallax) | depth of the set | a journey; a parade; a river |
| `static` (the page held while puppets move) | the scene plays | a meeting; a gag; a conversation |
| `pull_out` (to the whole open book on the desk) | it was a book | an ending; a reveal; a chapter break |

- Framing: Low over the page so layers stack; the gutter line visible in wides.
- Framing: Puppets at least a third of frame height on emotional beats.
- Transitions: cut, fade_black, wipe; never dissolves, flashes.
- Preferred links: continuous, bridge, cut, insert_return.

## 7. Sound palette

- Instruments: music box, celesta, nylon guitar, clarinet, a soft string quartet.
- Foley: the page turning; card popping up; a puppet sliding in a slot; paper rustle; the book closing.
- Ambience: a quiet room at night, a lamp hum, rain outside.
- Silence: the page half-open; everything holds; the next fold lands alone.
- Voice: a bedtime storyteller, close and warm.
- Default score field: music box and celesta, gentle, storybook (66–100 BPM).
- Mix: duck music under voice and key foley; loudness −14 LUFS at export.

## 8. Native moves

A menu: use the ones your story needs.

- **The page opens.** A whole scene rises from flat card. *Build:* bridge link: anchor last frame (closed page) → end frame (open scene); tilt move. *Fits content like:* a city founded; a morning; a new chapter.
- **Layer parallax.** Card layers slide against each other as the eye moves. *Build:* truck move, moderate amplitude, beats name the layers. *Fits content like:* a journey; a forest; a harbour.
- **The flip puppet.** A character flips to show another state. *Build:* jump_cut with 'the paper puppet flips to its other side: now…'. *Fits content like:* a mood change; a disguise; before and after.
- **Close the book.** The scene folds flat and the cover closes. *Build:* pull_out to the desk; last shot; assembler fade to black. *Fits content like:* endings; a secret kept; goodnight.

## 9. Pitfalls of the medium (what H3 gets wrong)

- Paper looks like CGI plastic. → Say 'cut card with fibrous edges, visible glue tabs, lamp light' in the suffix.
- Characters move naturally. → Describe 'paper puppets sliding on tabs, flipping'.
- The book disappears into a full 3D world. → Keep 'the gutter and the desk visible' in wides; return with a pull_out.

## 10. Engine (compiled Studio fields)

```json
{
  "look": {
    "genre": "paper pop-up storybook film, handmade, warm bedtime tone",
    "palette": "coloured card, cream pages, dark wooden desk, one accent puppet colour",
    "camera": "the reader's eye low over the page, tilts as pages open, slow trucks for parallax",
    "lens": "macro to normal, shallow focus on card layers",
    "lighting": "a single warm desk lamp from one side, soft paper shadows",
    "aspectRatio": "16:9"
  },
  "negative": [
    "pages turn and tabs pull by themselves; only book, desk and lamp are in frame"
  ],
  "cinematography": {
    "lens": "macro",
    "dof": "shallow",
    "lighting": [
      "practicals",
      "rim"
    ],
    "grade": "pastel",
    "texture": "digital",
    "animation": "stopmotion",
    "pace": "slow"
  },
  "bySize": {
    "els": {
      "lens": "normal",
      "dof": "medium"
    }
  },
  "loras": [],
  "beatSuffix": "A paper pop-up book of layered cut card under a desk lamp, fold lines and tabs visible."
}
```

Apply with `compile_look` (→ `start_film` / `update_look`) and `apply_style` (→ `save_shotlist`).

## 11. Variation space

You decide: the pages and their order, the accent puppet, the card palette per page, opening, ending, where the book closes.

- Structures: five pages, five places, one traveller; one page opened three times, each time changed; a story told from the back of the book forward.
- Openings: the closed book on the desk, the lamp switched on; a page already open, the puppet asleep; a hand-free pull of the first tab.
- Endings: the book closes; the last page left open and the lamp off; the pull-out to a shelf of books.
