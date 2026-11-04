/* Tier 3 of the director: a vocabulary the agent picks keys from and the
   compiler turns into the natural-language phrasing H3 responds to. Keys are
   validated by the shot schema, so an unknown term never reaches the model.
   `use` tells the agent when a term earns its place. */

export type CinemaTerm = { key: string; label: string; phrase: string; use: string };
export type CinemaCategory = { key: CinemaCategoryKey; label: string; multi: boolean; terms: CinemaTerm[] };
export type CinemaCategoryKey = "size" | "angle" | "lens" | "dof" | "lighting" | "grade" | "texture" | "vfx" | "animation" | "pace";

const t = (key: string, label: string, phrase: string, use: string): CinemaTerm => ({ key, label, phrase, use });

export const CINEMA: CinemaCategory[] = [
  {
    key: "size", label: "Shot size", multi: false, terms: [
      t("ecu", "Extreme close-up", "extreme close-up, a single detail fills the frame", "an eye, a hand, an object that carries the moment"),
      t("cu", "Close-up", "close-up on the face", "emotion, reaction, dialogue beats"),
      t("mcu", "Medium close-up", "medium close-up, head and shoulders", "conversation, the default for dialogue"),
      t("ms", "Medium shot", "medium shot from the waist up", "action with hands, two people talking"),
      t("mls", "Medium long shot", "medium long shot, knees up", "movement, body language, groups"),
      t("ls", "Long shot", "long shot, the full figure in the setting", "establishing a character in a place"),
      t("els", "Extreme long shot", "extreme long shot, the figure small in a vast setting", "establishing shots, scale, isolation"),
      t("twoshot", "Two-shot", "two-shot with both characters in frame", "relationship, confrontation"),
      t("ots", "Over-the-shoulder", "over-the-shoulder shot", "shot / reverse-shot dialogue"),
      t("insert", "Insert", "insert shot of the object", "cutaway details that explain the action"),
    ],
  },
  {
    key: "angle", label: "Camera angle", multi: false, terms: [
      t("eye", "Eye level", "at eye level", "neutral, documentary feel"),
      t("low", "Low angle", "from a low angle looking up", "power, menace, heroism"),
      t("high", "High angle", "from a high angle looking down", "vulnerability, overview"),
      t("overhead", "Overhead / top-down", "straight overhead top-down view", "geometry, choreography, tables and maps"),
      t("dutch", "Dutch angle", "tilted Dutch angle", "unease, disorientation, villainy"),
      t("worm", "Worm's eye", "worm's-eye view from the ground", "monumental scale"),
      t("pov", "Point of view", "first-person point of view", "immersion, what the character sees"),
      t("profile", "Profile", "in strict profile", "graphic, iconic compositions"),
    ],
  },
  {
    key: "lens", label: "Lens", multi: false, terms: [
      t("ultrawide", "Ultra-wide (14–18mm)", "ultra-wide lens with pronounced perspective stretch", "architecture, cramped interiors, kinetic action"),
      t("wide", "Wide (24–28mm)", "wide-angle lens", "establishing, movement through space"),
      t("normal", "Normal (35–50mm)", "35mm lens, natural perspective", "the honest default"),
      t("portrait", "Portrait (85mm)", "85mm portrait lens, compressed and flattering", "close-ups, beauty"),
      t("tele", "Telephoto (135–200mm)", "long telephoto lens, compressed layers", "voyeuristic distance, stacked traffic and crowds"),
      t("macro", "Macro", "macro lens on minute detail", "textures, insects, mechanisms"),
      t("anamorphic", "Anamorphic", "anamorphic lens with oval bokeh and horizontal flares", "cinematic scope look"),
      t("fisheye", "Fisheye", "fisheye lens with barrel distortion", "skate, music video, dreams"),
    ],
  },
  {
    key: "dof", label: "Depth of field", multi: false, terms: [
      t("shallow", "Shallow", "very shallow depth of field, the background melts away", "isolate a face or object"),
      t("medium", "Medium", "moderate depth of field", "keep two planes readable"),
      t("deep", "Deep focus", "deep focus, everything sharp from foreground to horizon", "staging in depth, Welles / Kubrick framing"),
      t("rack", "Rack focus", "rack focus pulling from foreground to background", "redirect attention mid-shot (name the two subjects in the beat)"),
      t("tiltshift", "Tilt-shift", "tilt-shift miniature effect", "cities as toys, whimsy"),
    ],
  },
  {
    key: "lighting", label: "Lighting", multi: true, terms: [
      t("threepoint", "Three-point", "classic three-point lighting", "clean, commercial, interviews"),
      t("rembrandt", "Rembrandt", "Rembrandt lighting with the triangle of light on the cheek", "dramatic portraits"),
      t("split", "Split", "split lighting, half the face in shadow", "duality, moral conflict"),
      t("butterfly", "Butterfly", "butterfly lighting from above the lens", "glamour, beauty"),
      t("highkey", "High-key", "bright high-key lighting with soft shadows", "comedy, optimism, product"),
      t("lowkey", "Low-key", "low-key lighting with deep shadows", "noir, thriller, horror"),
      t("chiaroscuro", "Chiaroscuro", "chiaroscuro, hard light carving shapes out of darkness", "baroque drama"),
      t("silhouette", "Silhouette", "backlit silhouette against a bright background", "mystery, iconic reveals"),
      t("rim", "Rim / backlight", "strong rim light separating the subject from the background", "depth, hair light, heroic edges"),
      t("practicals", "Practicals", "lit by practical sources in frame: lamps, screens, signs", "naturalism, night interiors"),
      t("neon", "Neon", "mixed neon light, magenta and cyan spill", "cyberpunk, nightlife"),
      t("golden", "Golden hour", "warm golden-hour sunlight, long shadows", "romance, nostalgia"),
      t("blue", "Blue hour", "cool blue-hour twilight", "melancholy, transitions"),
      t("overcast", "Overcast", "soft overcast daylight, no hard shadows", "realism, grief, Nordic looks"),
      t("harshsun", "Harsh noon sun", "harsh direct noon sun with crushed shadows", "desert, exhaustion, westerns"),
      t("moonlight", "Moonlight", "cold moonlight with a soft blue key", "night exteriors, dreams"),
      t("firelight", "Firelight", "flickering warm firelight", "campfires, intimacy, ritual"),
      t("volumetric", "Volumetric / god rays", "volumetric light rays through haze", "cathedrals, forests, reveals"),
      t("underlight", "Under-lighting", "light from below the face", "horror, campfire stories"),
      t("stage", "Stage / spotlight", "a single hard spotlight on a dark stage", "performance, confession"),
    ],
  },
  {
    key: "grade", label: "Colour grade", multi: false, terms: [
      t("tealorange", "Teal and orange", "teal and orange colour grade", "blockbuster action"),
      t("bleach", "Bleach bypass", "bleach-bypass look, desaturated with hard contrast", "war, grit"),
      t("mono", "Black and white", "black and white", "timelessness, graphic contrast"),
      t("pastel", "Pastel", "soft pastel palette", "Wes Anderson whimsy, daydreams"),
      t("kodachrome", "Kodachrome", "Kodachrome colours, saturated reds and deep blues", "1960s–70s memory"),
      t("crossprocess", "Cross-process", "cross-processed colours with cyan shadows and yellow highlights", "indie, lo-fi"),
      t("muted", "Muted", "muted, low-saturation palette", "drama, realism"),
      t("vivid", "Vivid", "vivid, saturated colours", "commercials, animation, pop"),
      t("sepia", "Sepia", "sepia-toned", "period, memory"),
      t("cyberpunk", "Cyberpunk", "cyberpunk palette of magenta, cyan and black", "future noir"),
    ],
  },
  {
    key: "texture", label: "Texture / stock", multi: false, terms: [
      t("35mm", "35mm film", "shot on 35mm film with fine grain", "cinema default"),
      t("16mm", "16mm film", "16mm film with visible grain and gate weave", "documentary, indie, memory"),
      t("8mm", "Super 8", "Super 8 home-movie look with heavy grain and flicker", "home movies, flashbacks"),
      t("digital", "Clean digital", "clean, sharp digital capture", "modern, commercial"),
      t("vhs", "VHS", "VHS tape look with tracking noise and chroma bleed", "1980s–90s, found footage"),
      t("cctv", "CCTV", "security-camera footage with timestamp and low frame rate", "surveillance, thriller"),
      t("polaroid", "Polaroid", "instant-film look with soft contrast and a warm cast", "intimacy, nostalgia"),
      t("halftone", "Halftone print", "halftone print texture", "comic book, pop art"),
    ],
  },
  {
    key: "vfx", label: "VFX / technique", multi: true, terms: [
      t("slowmo", "Slow motion", "in slow motion", "impact, beauty, violence"),
      t("speedramp", "Speed ramp", "speed ramp from slow motion to real time", "action beats, music video"),
      t("timelapse", "Time-lapse", "time-lapse", "skies, cities, passage of time"),
      t("hyperlapse", "Hyperlapse", "hyperlapse moving through the space", "travel, transitions"),
      t("longexposure", "Long exposure", "long-exposure light trails", "night traffic, stars"),
      t("doubleexp", "Double exposure", "double exposure blending two images", "memory, inner life"),
      t("lensflare", "Lens flare", "anamorphic lens flares", "sci-fi, sun, headlights"),
      t("fog", "Fog / haze", "thick atmospheric fog", "mystery, depth, softening"),
      t("particles", "Particles", "drifting particles catching the light: dust, embers, snow", "texture in the air"),
      t("rain", "Rain", "heavy rain on the lens and surfaces", "noir, drama"),
      t("glitch", "Glitch", "digital glitch and datamosh artifacts", "tech horror, music video"),
      t("bloom", "Bloom", "soft bloom around highlights", "dream, romance"),
      t("mirror", "Reflections", "composition built on reflections in glass or water", "duality, noir"),
      t("splitscreen", "Split screen", "split screen showing two actions at once", "phone calls, parallel action"),
      t("freeze", "Freeze frame", "ends on a freeze frame", "punchlines, title moments"),
      t("explosion", "Pyro / explosion", "practical explosion with debris and fireball", "action"),
      t("magic", "Magic / energy", "glowing magical energy effects", "fantasy"),
      t("holo", "Holograms / UI", "floating holographic interfaces", "sci-fi"),
    ],
  },
  {
    key: "animation", label: "Animation / illustration style", multi: false, terms: [
      t("anime", "Anime (cel-shaded)", "cel-shaded anime style with clean line art and flat colours", "shonen, slice of life"),
      t("ghibli", "Painterly anime", "painterly hand-drawn animation with lush backgrounds", "wonder, nature, nostalgia"),
      t("cgi", "3D CGI feature", "3D CGI animation with soft subsurface skin and round forms", "family animation"),
      t("claymation", "Claymation", "stop-motion claymation with fingerprints in the clay", "handmade charm"),
      t("stopmotion", "Stop-motion puppets", "stop-motion puppet animation", "gothic, craft"),
      t("flat2d", "Flat 2D", "flat 2D vector animation with bold shapes", "explainers, motion graphics"),
      t("watercolor", "Watercolour", "animated watercolour with bleeding edges", "lyrical, children's books"),
      t("pixel", "Pixel art", "pixel-art animation", "retro games"),
      t("inkwash", "Ink wash", "sumi-e ink-wash animation", "martial arts, poetry"),
      t("comic", "Comic / manga panels", "comic-book style with halftone and bold outlines", "action, pop"),
      t("rotoscope", "Rotoscope", "rotoscoped animation over live action", "psychedelic, memory"),
      t("lowpoly", "Low-poly 3D", "low-poly 3D with flat shading", "indie games, abstraction"),
    ],
  },
  {
    key: "pace", label: "Pace / energy", multi: false, terms: [
      t("still", "Still", "a quiet, still composition with minimal movement", "contemplation, dread"),
      t("slow", "Slow", "slow, deliberate pacing", "drama, romance"),
      t("steady", "Steady", "steady, natural pacing", "default"),
      t("brisk", "Brisk", "brisk, energetic movement", "comedy, montage"),
      t("frantic", "Frantic", "frantic, chaotic energy", "action, panic"),
    ],
  },
];

export const CINEMA_KEYS: Record<CinemaCategoryKey, string[]> = Object.fromEntries(CINEMA.map((c) => [c.key, c.terms.map((x) => x.key)])) as Record<CinemaCategoryKey, string[]>;

export function cinemaTerm(category: CinemaCategoryKey, key: string): CinemaTerm | undefined {
  return CINEMA.find((c) => c.key === category)?.terms.find((x) => x.key === key);
}

export type CinematographySpec = Partial<{
  size: string; angle: string; lens: string; dof: string; lighting: string[]; grade: string; texture: string; vfx: string[]; animation: string; pace: string;
}>;

/** The CINEMATOGRAPHY block: every chosen key rendered as H3-friendly prose. */
export function renderCinematography(spec: CinematographySpec | undefined): { block?: string; lookLine?: string } {
  if (!spec) return {};
  const lines: string[] = [];
  const phrase = (cat: CinemaCategoryKey, key?: string) => (key ? cinemaTerm(cat, key)?.phrase : undefined);
  const framing = [phrase("size", spec.size), phrase("angle", spec.angle)].filter(Boolean);
  if (framing.length) lines.push(`Framing: ${framing.join(", ")}.`);
  const optics = [phrase("lens", spec.lens), phrase("dof", spec.dof)].filter(Boolean);
  if (optics.length) lines.push(`Lens: ${optics.join(", ")}.`);
  const light = (spec.lighting ?? []).map((k) => phrase("lighting", k)).filter(Boolean);
  if (light.length) lines.push(`Lighting: ${light.join("; ")}.`);
  const finish = [phrase("grade", spec.grade), phrase("texture", spec.texture)].filter(Boolean);
  if (finish.length) lines.push(`Image: ${finish.join(", ")}.`);
  const fx = (spec.vfx ?? []).map((k) => phrase("vfx", k)).filter(Boolean);
  if (fx.length) lines.push(`Technique: ${fx.join("; ")}.`);
  const pace = phrase("pace", spec.pace);
  if (pace) lines.push(`Pace: ${pace}.`);
  const anim = phrase("animation", spec.animation);
  return { block: lines.length ? `CINEMATOGRAPHY\n${lines.join("\n")}` : undefined, lookLine: anim ? `Rendered as ${anim}` : undefined };
}
