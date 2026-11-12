import { CINEMA, type CinemaCategory } from "./cinematography";
import { EDIT_GRAMMAR, TIMELINE_ONLY, planDurations } from "./editing";

/* The director's three tiers as text the agent reads: Tier 2 (editing) and
   Tier 3 (cinematography) are generated from the catalogs; Tier 1 is the
   plan `start_film` returns. */

export function editingGuide(grammar = EDIT_GRAMMAR, timelineOnly = TIMELINE_ONLY): string {
  const rows = grammar.map((g) => `| \`${g.type}\` | ${g.label} | ${g.workflow} | anchor ${g.defaultAnchor} | ${g.when} |`).join("\n");
  const how = grammar.map((g) => `- **${g.label}** (\`${g.type}\`): ${g.how}`).join("\n");
  return `# Editing grammar (Tier 2)

Every shot carries \`link: { type, anchor?, anchorShotId? }\`. The type names the mechanism; the Studio resolves the anchor shot's **last frame** from its selected take and hands H3 the right workflow and images. Nothing here needs the model to "remember" earlier shots: the frame does the remembering.

| type | label | H3 workflow | default anchor | when |
|---|---|---|---|---|
${rows}

## How each one is built

${how}

## Rules

- A linked shot can only render after its anchor has a finished take; order the renders accordingly (or render the anchor first, then the linked shots).
- \`continuous\` and \`bridge\` are the only ways to exceed 15 s of unbroken action: chain 5–15 s shots.
- \`reverse\` for dialogue: A (cut), B (cut or match), A (reverse, anchor -2), B (reverse, anchor -2)… keep the 180° line and eyelines.
- \`insert_return\` after an \`insert\`-size cutaway resumes the main action from its own last frame.
- \`match_cut\` is a reference, not a first frame: the new scene may be anywhere; describe it fully in the beats.
- Do not describe what the anchor frame already shows; describe what happens next.
- When a shot is linked, its \`mode\` is implied by the link; set it to \`keyframe\` for first-frame links and \`reference\` for match cuts to keep the editor honest.
- \`loop\` is for periodic motion: render one period (5–15 s) that ends on its first frame, then put the clip on the timeline with \`repeat: N\`. One render instead of N; the beats must describe exactly one cycle (no drift in light, props or position).

## Only in the timeline

${timelineOnly.map((t) => `- ${t}`).join("\n")}
`;
}

export function cinematographyGuide(categories: CinemaCategory[] = CINEMA): string {
  const sections = categories.map((c) => {
    const rows = c.terms.map((t) => `| \`${t.key}\` | ${t.label} | ${t.use} |`).join("\n");
    return `## ${c.label} (\`${c.key}\`${c.multi ? ", up to 4" : ""})\n\n| key | term | use it for |\n|---|---|---|\n${rows}`;
  });
  return `# Cinematography vocabulary (Tier 3)

Set \`cinematography\` on a shot with keys from these tables; the Studio renders them as the prose H3 responds to. Pick what the moment needs, not everything: a shot size, an angle, a lens, one or two lighting terms, and a grade are plenty. The project Look sets the house style; cinematography is the per-shot refinement.

Refinement checklist per shot:
1. Size and angle say whose shot it is and how we feel about them.
2. Lens and depth of field decide what the eye can and cannot read.
3. Lighting is the mood; name the sources (practicals, neon, golden hour), not adjectives.
4. Grade and texture are the house style; change them only for flashbacks, dreams or inserted media.
5. VFX only when the beat needs it (slow motion for impact, fog for depth); H3 does the physics itself.
6. Animation style belongs to the whole film; set it on every shot (or none).
7. Camera move stays one per shot (the \`camera\` field); \`pace\` tunes its energy.

${sections.join("\n\n")}
`;
}

/** What `start_film` hands back: the three tiers with the arithmetic done. */
export function filmPlan(args: { brief: string; totalSeconds: number; shots?: number }) {
  const plan = planDurations(args.totalSeconds, args.shots);
  return {
    plan,
    tiers: {
      tier1: "Brief: the user's words plus the target running time, aspect ratio and style. Save it as the project brief; write the Look (genre, palette, camera, lens, lighting, LoRAs) from it.",
      tier2: `Shotlist: first split the brief into 3–6 narrative sequences with a share of the ${plan.totalSeconds} s each; then cut every sequence into 5–15 s shots (the arithmetic skeleton: ${plan.shots} shots, durations ${plan.durations.join(", ")} — reshape it per sequence: 5 s for a shot that carries an action, at most 8 s; 10 s for a held one-beat frame). Open each sequence with a reference-mode (R2VA) shot that carries the character references, then pass identity by frame with continuous / reverse / insert_return / bridge. For each shot choose the link type from the editing grammar and the mode it implies; write intent and beats as start → action → end. Render order: all R2VA shots of a batch first (one base model), then the I2VA / FL2VA shots that anchor to them.`,
      tier3: "Refine every shot with cinematography keys (size, angle, lens, dof, lighting, grade, texture, vfx, animation, pace), one camera move with amplitude and speed, verbatim dialogue with delivery, and sound as events. Then save_shotlist and ask for approval.",
    },
    checklist: [
      "Durations are integers 5–15 and sum to the target.",
      "Linked shots come after their anchor; the anchor must finish rendering first.",
      "At most 3 cuts inside a shot; more → split.",
      "Every character / location / prop referenced by id exists (create_element first).",
      "Speed LoRA in the Look; steps follow its hint.",
      "needs_confirm before any spend; gpu_status before a batch.",
    ],
  };
}
