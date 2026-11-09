/*
 * A face check's verdict and what it lets through (face-check.ts asks the
 * model). No server imports: the Pictures page shows it too.
 */

export const FACE_KINDS = ["real_photo", "photoreal", "render_3d", "illustration", "no_face"] as const;
export type FaceKind = (typeof FACE_KINDS)[number];
export type FaceVerdict = {
  kind: FaceKind;
  /** a real, recognisable person's likeness (a celebrity, a public figure), however it is drawn */
  likeness: boolean;
  age: "adult" | "minor" | "unclear";
  confidence: number;
  reason: string;
  model: string;
  at: number;
};

const KIND_ZH: Record<FaceKind, string> = { real_photo: "a photograph", photoreal: "photorealistic", render_3d: "a 3D render", illustration: "an illustration", no_face: "no human face" };

/** Whether this verdict lets the picture's face into 18+ work. */
export function faceAllowed(v: FaceVerdict | undefined): boolean {
  if (!v || v.confidence < 0.7 || v.likeness) return false;
  if (v.kind === "no_face") return true;
  return (v.kind === "render_3d" || v.kind === "illustration") && v.age === "adult";
}

const SIM = "模拟: AI-generated, a 3D render, an illustration or no face — the reference of any picture, R18 included";
const REAL = "真实: it may show a real person — not for R18 pictures; every other picture is fine";

/** An upload's or an import's tag, from its face check: 模拟 or 真实 (also when it has none). */
export function faceLabel(v: FaceVerdict | undefined, error?: { why?: string }): { allowed: boolean; label: "模拟" | "真实"; title: string } {
  const allowed = faceAllowed(v);
  if (!v) return { allowed: false, label: "真实", title: `${REAL} (${error?.why ? `the face check did not run: ${error.why}` : "not checked"}; Check again on the Pictures page)` };
  return { allowed, label: allowed ? "模拟" : "真实", title: `${allowed ? SIM : REAL} (${describeVerdict(v)})` };
}

/**
 * Any picture's tag. An upload or an import: its face check. A library picture: 模拟. A drawing or a take's
 * frame: the tag stamped when it was made, from the pictures it came from. Undefined for an older drawing
 * made before tags.
 */
export function pictureTag(meta: Record<string, unknown>, outside: boolean): { sim: boolean; label: "模拟" | "真实"; title: string } | undefined {
  if (meta.reference) return { sim: true, label: "模拟", title: `${SIM} (the reference library)` };
  if (outside) {
    const l = faceLabel(meta.faceCheck as FaceVerdict | undefined, meta.faceCheckError as { why?: string } | undefined);
    return { sim: l.allowed, label: l.label, title: l.title };
  }
  if (meta.realness === "sim") return { sim: true, label: "模拟", title: `${SIM} (drawn from 模拟 pictures only, or from text)` };
  if (meta.realness === "real") return { sim: false, label: "真实", title: `${REAL} (drawn from a 真实 picture)` };
  return undefined;
}

/** The verdict in a few words, for a refusal or the picture's facts. */
export function describeVerdict(v: FaceVerdict | undefined): string {
  if (!v) return "face not checked";
  const parts = [KIND_ZH[v.kind]];
  if (v.kind !== "no_face") parts.push(v.age === "adult" ? "an adult" : v.age === "minor" ? "a minor" : "age unclear");
  if (v.likeness) parts.push("a real person's likeness");
  if (v.confidence < 0.7) parts.push(`unsure (${Math.round(v.confidence * 100)}%)`);
  return `face check: ${parts.join(", ")}`;
}
