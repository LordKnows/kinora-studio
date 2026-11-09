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

/** The verdict in a few words, for a refusal or the picture's facts. */
export function describeVerdict(v: FaceVerdict | undefined): string {
  if (!v) return "face not checked";
  const parts = [KIND_ZH[v.kind]];
  if (v.kind !== "no_face") parts.push(v.age === "adult" ? "an adult" : v.age === "minor" ? "a minor" : "age unclear");
  if (v.likeness) parts.push("a real person's likeness");
  if (v.confidence < 0.7) parts.push(`unsure (${Math.round(v.confidence * 100)}%)`);
  return `face check: ${parts.join(", ")}`;
}
