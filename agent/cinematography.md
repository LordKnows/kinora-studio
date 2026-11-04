# Cinematography vocabulary (Tier 3)

Set `cinematography` on a shot with keys from these tables; the Studio renders them as the prose H3 responds to. Pick what the moment needs, not everything: a shot size, an angle, a lens, one or two lighting terms, and a grade are plenty. The project Look sets the house style; cinematography is the per-shot refinement.

Refinement checklist per shot:
1. Size and angle say whose shot it is and how we feel about them.
2. Lens and depth of field decide what the eye can and cannot read.
3. Lighting is the mood; name the sources (practicals, neon, golden hour), not adjectives.
4. Grade and texture are the house style; change them only for flashbacks, dreams or inserted media.
5. VFX only when the beat needs it (slow motion for impact, fog for depth); H3 does the physics itself.
6. Animation style belongs to the whole film; set it on every shot (or none).
7. Camera move stays one per shot (the `camera` field); `pace` tunes its energy.

## Shot size (`size`)

| key | term | use it for |
|---|---|---|
| `ecu` | Extreme close-up | an eye, a hand, an object that carries the moment |
| `cu` | Close-up | emotion, reaction, dialogue beats |
| `mcu` | Medium close-up | conversation, the default for dialogue |
| `ms` | Medium shot | action with hands, two people talking |
| `mls` | Medium long shot | movement, body language, groups |
| `ls` | Long shot | establishing a character in a place |
| `els` | Extreme long shot | establishing shots, scale, isolation |
| `twoshot` | Two-shot | relationship, confrontation |
| `ots` | Over-the-shoulder | shot / reverse-shot dialogue |
| `insert` | Insert | cutaway details that explain the action |

## Camera angle (`angle`)

| key | term | use it for |
|---|---|---|
| `eye` | Eye level | neutral, documentary feel |
| `low` | Low angle | power, menace, heroism |
| `high` | High angle | vulnerability, overview |
| `overhead` | Overhead / top-down | geometry, choreography, tables and maps |
| `dutch` | Dutch angle | unease, disorientation, villainy |
| `worm` | Worm's eye | monumental scale |
| `pov` | Point of view | immersion, what the character sees |
| `profile` | Profile | graphic, iconic compositions |

## Lens (`lens`)

| key | term | use it for |
|---|---|---|
| `ultrawide` | Ultra-wide (14–18mm) | architecture, cramped interiors, kinetic action |
| `wide` | Wide (24–28mm) | establishing, movement through space |
| `normal` | Normal (35–50mm) | the honest default |
| `portrait` | Portrait (85mm) | close-ups, beauty |
| `tele` | Telephoto (135–200mm) | voyeuristic distance, stacked traffic and crowds |
| `macro` | Macro | textures, insects, mechanisms |
| `anamorphic` | Anamorphic | cinematic scope look |
| `fisheye` | Fisheye | skate, music video, dreams |

## Depth of field (`dof`)

| key | term | use it for |
|---|---|---|
| `shallow` | Shallow | isolate a face or object |
| `medium` | Medium | keep two planes readable |
| `deep` | Deep focus | staging in depth, Welles / Kubrick framing |
| `rack` | Rack focus | redirect attention mid-shot (name the two subjects in the beat) |
| `tiltshift` | Tilt-shift | cities as toys, whimsy |

## Lighting (`lighting`, up to 4)

| key | term | use it for |
|---|---|---|
| `threepoint` | Three-point | clean, commercial, interviews |
| `rembrandt` | Rembrandt | dramatic portraits |
| `split` | Split | duality, moral conflict |
| `butterfly` | Butterfly | glamour, beauty |
| `highkey` | High-key | comedy, optimism, product |
| `lowkey` | Low-key | noir, thriller, horror |
| `chiaroscuro` | Chiaroscuro | baroque drama |
| `silhouette` | Silhouette | mystery, iconic reveals |
| `rim` | Rim / backlight | depth, hair light, heroic edges |
| `practicals` | Practicals | naturalism, night interiors |
| `neon` | Neon | cyberpunk, nightlife |
| `golden` | Golden hour | romance, nostalgia |
| `blue` | Blue hour | melancholy, transitions |
| `overcast` | Overcast | realism, grief, Nordic looks |
| `harshsun` | Harsh noon sun | desert, exhaustion, westerns |
| `moonlight` | Moonlight | night exteriors, dreams |
| `firelight` | Firelight | campfires, intimacy, ritual |
| `volumetric` | Volumetric / god rays | cathedrals, forests, reveals |
| `underlight` | Under-lighting | horror, campfire stories |
| `stage` | Stage / spotlight | performance, confession |

## Colour grade (`grade`)

| key | term | use it for |
|---|---|---|
| `tealorange` | Teal and orange | blockbuster action |
| `bleach` | Bleach bypass | war, grit |
| `mono` | Black and white | timelessness, graphic contrast |
| `pastel` | Pastel | Wes Anderson whimsy, daydreams |
| `kodachrome` | Kodachrome | 1960s–70s memory |
| `crossprocess` | Cross-process | indie, lo-fi |
| `muted` | Muted | drama, realism |
| `vivid` | Vivid | commercials, animation, pop |
| `sepia` | Sepia | period, memory |
| `cyberpunk` | Cyberpunk | future noir |

## Texture / stock (`texture`)

| key | term | use it for |
|---|---|---|
| `35mm` | 35mm film | cinema default |
| `16mm` | 16mm film | documentary, indie, memory |
| `8mm` | Super 8 | home movies, flashbacks |
| `digital` | Clean digital | modern, commercial |
| `vhs` | VHS | 1980s–90s, found footage |
| `cctv` | CCTV | surveillance, thriller |
| `polaroid` | Polaroid | intimacy, nostalgia |
| `halftone` | Halftone print | comic book, pop art |

## VFX / technique (`vfx`, up to 4)

| key | term | use it for |
|---|---|---|
| `slowmo` | Slow motion | impact, beauty, violence |
| `speedramp` | Speed ramp | action beats, music video |
| `timelapse` | Time-lapse | skies, cities, passage of time |
| `hyperlapse` | Hyperlapse | travel, transitions |
| `longexposure` | Long exposure | night traffic, stars |
| `doubleexp` | Double exposure | memory, inner life |
| `lensflare` | Lens flare | sci-fi, sun, headlights |
| `fog` | Fog / haze | mystery, depth, softening |
| `particles` | Particles | texture in the air |
| `rain` | Rain | noir, drama |
| `glitch` | Glitch | tech horror, music video |
| `bloom` | Bloom | dream, romance |
| `mirror` | Reflections | duality, noir |
| `splitscreen` | Split screen | phone calls, parallel action |
| `freeze` | Freeze frame | punchlines, title moments |
| `explosion` | Pyro / explosion | action |
| `magic` | Magic / energy | fantasy |
| `holo` | Holograms / UI | sci-fi |

## Animation / illustration style (`animation`)

| key | term | use it for |
|---|---|---|
| `anime` | Anime (cel-shaded) | shonen, slice of life |
| `ghibli` | Painterly anime | wonder, nature, nostalgia |
| `cgi` | 3D CGI feature | family animation |
| `claymation` | Claymation | handmade charm |
| `stopmotion` | Stop-motion puppets | gothic, craft |
| `flat2d` | Flat 2D | explainers, motion graphics |
| `watercolor` | Watercolour | lyrical, children's books |
| `pixel` | Pixel art | retro games |
| `inkwash` | Ink wash | martial arts, poetry |
| `comic` | Comic / manga panels | action, pop |
| `rotoscope` | Rotoscope | psychedelic, memory |
| `lowpoly` | Low-poly 3D | indie games, abstraction |

## Pace / energy (`pace`)

| key | term | use it for |
|---|---|---|
| `still` | Still | contemplation, dread |
| `slow` | Slow | drama, romance |
| `steady` | Steady | default |
| `brisk` | Brisk | comedy, montage |
| `frantic` | Frantic | action, panic |
