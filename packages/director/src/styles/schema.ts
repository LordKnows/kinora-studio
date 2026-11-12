import { z } from "zod";
import {
  ANGLE, ANIMATION, CAMERA_MOVES, DOF, GRADE, LENS, LIGHTING, LINK_TYPES,
  LOCAL_TRANSITIONS, PACE, SIZE, TEXTURE, VFX,
} from "../catalog.js";

/**
 * A style preset. The eleven sections follow the STYLE.md convention of
 * lemo-opuscar (invariants only, no story), compiled here into the fields the
 * Studio understands. `style.json` is the source; `STYLE.md` is generated.
 */

const Cinematography = z.object({
  size: z.enum(SIZE).optional(),
  angle: z.enum(ANGLE).optional(),
  lens: z.enum(LENS).optional(),
  dof: z.enum(DOF).optional(),
  lighting: z.array(z.enum(LIGHTING)).max(4).optional(),
  grade: z.enum(GRADE).optional(),
  texture: z.enum(TEXTURE).optional(),
  vfx: z.array(z.enum(VFX)).max(4).optional(),
  animation: z.enum(ANIMATION).optional(),
  pace: z.enum(PACE).optional(),
});

export const CameraGrammarRow = z.object({
  move: z.enum(CAMERA_MOVES),
  /** Optional refinement that lands in `camera.note` when this row is used. */
  note: z.string().max(200).optional(),
  expresses: z.string(),
  serves: z.array(z.string()).min(1),
});

export const NativeMove = z.object({
  name: z.string(),
  what: z.string(),
  /** How to build it with the Studio: which link, which mode, which keys. */
  build: z.string(),
  fits: z.array(z.string()).min(3),
});

export const StyleSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  en: z.string(),
  cn: z.string(),
  category: z.string(),
  category_cn: z.string(),
  line: z.string(),
  line_cn: z.string(),
  uses: z.array(z.string()).min(1),
  /** Where the structure came from; this preset's text is its own. */
  lineage: z.string().optional(),

  // §1
  essence: z.array(z.string()).min(3).max(6),
  not: z.array(z.string()).min(1),
  references: z.array(z.object({ work: z.string(), learn: z.string(), dontLearn: z.string() })).optional(),

  // §2 materials & rendering → Look.camera + per-shot texture / animation
  materials: z.array(z.string()).min(2),

  // §3 colour logic → Look.palette + grade
  colour: z.object({
    rules: z.array(z.string()).min(2),
    examplePalette: z.string().optional(),
  }),

  // §4 type & subtitles → local assembler titles / captions
  type: z.object({
    titleFont: z.string(),
    subtitleFont: z.string(),
    placement: z.string(),
    rules: z.array(z.string()).optional(),
  }),

  // §5 motion quality → pace, vfx, camera speed defaults
  motion: z.object({
    rules: z.array(z.string()).min(2),
    /** 'ones' = smooth; 'twos' = stepped 12 fps look, asked for in the beats. */
    stepping: z.enum(["ones", "twos"]).default("ones"),
    neverMoves: z.array(z.string()).optional(),
  }),

  // §6 camera grammar → allowed camera.move subset + defaults
  camera: z.object({
    grammar: z.array(CameraGrammarRow).min(4),
    framing: z.array(z.string()).min(1),
    /** Transitions this style allows, in local-assembler vocabulary. */
    transitions: z.array(z.enum(LOCAL_TRANSITIONS)).min(1),
    forbiddenTransitions: z.array(z.string()).optional(),
    /** Link types this style leans on. Others are allowed but warned. */
    preferredLinks: z.array(z.enum(LINK_TYPES)).optional(),
  }),

  // §7 sound palette → shot.sound defaults + cue map hints
  sound: z.object({
    instruments: z.array(z.string()).min(1),
    foley: z.array(z.string()).min(1),
    ambience: z.string(),
    silence: z.string(),
    voice: z.string(),
    /** Default `music` field text for shots that want score; 'N/A' suppresses. */
    musicDefault: z.string().default("N/A"),
    bpmRange: z.tuple([z.number(), z.number()]).optional(),
  }),

  // §8 native moves
  nativeMoves: z.array(NativeMove).min(3),

  // §9 pitfalls of the medium (H3-specific: what the model gets wrong)
  pitfalls: z.array(z.object({ problem: z.string(), fix: z.string() })).min(3),

  // §10 engine → the compiled Studio fields
  engine: z.object({
    look: z.object({
      genre: z.string().max(200),
      palette: z.string().max(200),
      camera: z.string().max(200),
      lens: z.string().max(200),
      lighting: z.string().max(200),
      aspectRatio: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).default("16:9"),
    }),
    negative: z.array(z.string().max(80)).max(7),
    cinematography: Cinematography,
    /** Extra per-shot defaults by size, e.g. close-ups get `portrait` lens. */
    bySize: z.partialRecord(z.enum(SIZE), Cinematography).optional(),
    /** The LoRA ids a style wants beyond the speed LoRA (none exist yet in the library). */
    loras: z.array(z.object({ id: z.string(), strength: z.number().min(0).max(2).optional() })).default([]),
    /**
     * Style LoRAs from the Studio's library that may suit this style. Not
     * applied by `compile_look`: none has been rendered with the preset yet.
     * The director offers them, and a probe take with and without tells.
     */
    loraSuggestions: z.array(z.object({
      id: z.string(),
      strength: z.number().min(0).max(2),
      /** Which shots it is for, and what it should add. */
      when: z.string().min(5).max(300),
    })).max(4).default([]),
    /** Words appended to every beat so the medium reads in the prompt. */
    beatSuffix: z.string().max(200).optional(),
    /**
     * Shot-length guide for this style. `action`: shots with characters, dialogue,
     * more than one beat or a brisk/frantic pace. `hold`: static one-beat holds
     * (empty frames, mist, a locked page). Loops render one period and repeat.
     */
    durations: z.object({
      action: z.number().int().min(5).max(15).default(5),
      hold: z.number().int().min(5).max(15).default(10),
      maxAction: z.number().int().min(5).max(15).default(8),
    }).default({ action: 5, hold: 10, maxAction: 8 }),
  }),

  // §11 variation space
  variation: z.object({
    decides: z.array(z.string()).min(1),
    structures: z.array(z.string()).length(3),
    openings: z.array(z.string()).length(3),
    endings: z.array(z.string()).length(3),
  }),
});

export type Style = z.infer<typeof StyleSchema>;
export type StyleInput = z.input<typeof StyleSchema>;
