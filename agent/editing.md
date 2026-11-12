# Editing grammar (Tier 2)

Every shot carries `link: { type, anchor?, anchorShotId? }`. The type names the mechanism; the Studio resolves the anchor shot's **last frame** from its selected take and hands H3 the right workflow and images. Nothing here needs the model to "remember" earlier shots: the frame does the remembering.

| type | label | H3 workflow | default anchor | when |
|---|---|---|---|---|
| `cut` | Hard cut | T2VA / I2VA (own hero frame) / R2VA | anchor -1 | new angle, new place, new idea; the default |
| `continuous` | Continuous (long take) | I2VA, or FL2VA when the shot has an end frame | anchor -1 | one unbroken camera move or action longer than 15 s |
| `bridge` | Bridge (first → last frame) | FL2VA (end frame required) | anchor -1 | a transition between two looks or places that should be one move: a push into a window that becomes the next room |
| `insert_return` | Insert, then return | I2VA | anchor -2 | after a cutaway (an insert, a reaction), come back to the main action where it left off |
| `reverse` | Shot / reverse shot | I2VA | anchor -2 | dialogue: A, B, A, B |
| `match_cut` | Match cut | R2VA | anchor -1 | a new place or time that rhymes with the previous image: a spinning wheel to a spinning galaxy, a closing door to a closing eye |
| `jump_cut` | Jump cut | I2VA | anchor -1 | same setup, time has passed: waiting, a montage of attempts |
| `montage` | Montage beat | T2VA / I2VA / R2VA, 5 s | anchor -1 | a run of short shots carrying one idea (training, a journey, a day passing) |
| `loop` | Loop (periodic motion) | FL2VA (hero frame as both first and last frame) | anchor -1 | periodic motion that should run much longer than one shot: a turning wheel, a dancer spinning, rain on a window, a character pacing |

## How each one is built

- **Hard cut** (`cut`): The shot stands on its own: text, its own hero frame, or element references.
- **Continuous (long take)** (`continuous`): First frame = the previous shot's last frame, so the pieces join invisibly. Keep the camera move and light consistent with the previous shot.
- **Bridge (first → last frame)** (`bridge`): First frame = previous last frame, last frame = this shot's chosen end frame; the model invents the journey between.
- **Insert, then return** (`insert_return`): First frame = the last frame of the shot before the insert (anchor offset -2), so the main action resumes seamlessly.
- **Shot / reverse shot** (`reverse`): Each return to a speaker starts from that speaker's own last frame (anchor -2 for A/B/A; set the anchor explicitly for longer patterns). Use over-the-shoulder sizes and keep screen direction (the 180° line).
- **Match cut** (`match_cut`): The previous last frame goes in as reference image 1 (composition and motion), the new scene is described in text; the LOOK keeps the match readable.
- **Jump cut** (`jump_cut`): First frame = previous last frame; the beats say what changed (light, props, posture). Written as 'time has passed' so the model moves on instead of continuing.
- **Montage beat** (`montage`): Keep each at the minimum length, one strong image per shot, consistent grade and pace; let the timeline cut on rhythm.
- **Loop (periodic motion)** (`loop`): Render one period T (5–15 s) as FL2VA with the hero frame as first AND last frame so it closes on itself, then set `repeat` on the timeline clip (N × T) instead of rendering N shots. The beats describe exactly one period; nothing may be left in a different state at the end.

## Rules

- A linked shot can only render after its anchor has a finished take; order the renders accordingly (or render the anchor first, then the linked shots).
- `continuous` and `bridge` are the only ways to exceed 15 s of unbroken action: chain 5–15 s shots.
- `reverse` for dialogue: A (cut), B (cut or match), A (reverse, anchor -2), B (reverse, anchor -2)… keep the 180° line and eyelines.
- `insert_return` after an `insert`-size cutaway resumes the main action from its own last frame.
- `match_cut` is a reference, not a first frame: the new scene may be anywhere; describe it fully in the beats.
- Do not describe what the anchor frame already shows; describe what happens next.
- When a shot is linked, its `mode` is implied by the link; set it to `keyframe` for first-frame links and `reference` for match cuts to keep the editor honest.
- `loop` is for periodic motion: render one period (5–15 s) that ends on its first frame, then put the clip on the timeline with `repeat: N`. One render instead of N; the beats must describe exactly one cycle (no drift in light, props or position).

## Only in the timeline

- Transitions are drawn by the assembler, never asked of the model: set `transition` on the clip that comes in — `dissolve`, `fade_black` (through black), `fade_white` (through white; a flash at 0.2 s), `iris`, `wipe` — with `transitionS` 0.2–1.
- J-cut / L-cut: `audioLeadS` lets a clip's sound start before its picture, `audioTrailS` lets it run on after. The sound comes from the take outside the clip's in and out points, so leave that much there (a J-cut of 0.5 s needs `inS` ≥ 0.5); the export says when the take had less. Use sound as a transition at least twice in a film.
- Fades: `fadeInS` / `fadeOutS` on the timeline fade the whole film, picture and sound, from and to black.
- Titles: H3 draws only text a prompt quotes, and the Studio quotes none. `titles` on the timeline puts text in the film — `card` covers the picture (an intertitle, a main title; give it room with `freezeS` on the clip before), `overlay` sits on the picture, `caption` is small at the bottom. A card holds 3 s or more.
- Freeze: `freezeS` on a clip holds its last frame, in silence.
- Narration: `narration` lays audio assets (off-screen and inner lines from `speak`, a recording) at their times; the music ducks under them.
- Silence: `silences` takes the whole mix out for a stretch. Put one before the turn and one before the peak.
- Subtitles: written by the export from the on-screen lines (at their `startS` / `endS` when given) and from narration lines made with `speak`, each as long as its audio. Burn them in with `export_project` `burnInSubtitles`.
- Loudness: the export lands on -14 LUFS unless `loudnessLufs` says otherwise (`null` leaves the mix alone). After an export, `get_export` lists what the assembler measured on the file: loudness, black picture and missing sound the timeline does not explain.
