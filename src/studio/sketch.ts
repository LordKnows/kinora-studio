import type { ProjectView, ShotView } from "./orchestrator";
import type { ScenePalette } from "./schemas";

/*
 * The colour-block storyboard: one 16:9 card per shot drawn from the
 * structured shotlist alone — no GPU, no image model. Subject size from the
 * shot size, its place from the composition (38 % / 62 % guides), entries and
 * exits from the blocking, colours from the scene palette. Seen together it
 * shows the rhythm of sizes and the colour script before a single frame is
 * drawn; the grayscale version shows whether subject and background separate
 * by value alone.
 */

const CELL_W = 384;
const CELL_H = 216;
const GAP = 28;
const COLS = 4;

const SIZE_H: Record<string, number> = { ecu: 1.6, cu: 1.05, mcu: 0.78, ms: 0.6, ots: 0.62, twoshot: 0.55, mls: 0.48, ls: 0.32, els: 0.13, insert: 0.85 };
const HEADROOM: Record<string, number> = { tight: 0.02, normal: 0.08, generous: 0.18 };
const POS_X: Record<string, number> = { off_left: -0.04, left: 0.22, center: 0.5, right: 0.78, off_right: 1.04, foreground: 0.5, background: 0.5 };
const DEFAULT_PALETTE = ["#2b2d33", "#c9b79c", "#8a4b3c"];

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Background and subject colours of a scene; the pair with the most value contrast. */
export function paletteRoles(p?: ScenePalette): { bg: string; subject: string; accent: string; ratio: number } {
  const colors = p?.colors?.length ? p.colors : DEFAULT_PALETTE;
  if (colors.length === 1) return { bg: colors[0]!, subject: luminance(colors[0]!) > 0.4 ? "#1d1d1f" : "#f2f2f2", accent: colors[0]!, ratio: 1 };
  const bg = colors[0]!;
  let subject = colors[1]!;
  for (const c of colors.slice(1)) if (contrastRatio(bg, c) > contrastRatio(bg, subject)) subject = c;
  const accent = colors.find((c) => c !== bg && c !== subject) ?? subject;
  return { bg, subject, accent, ratio: contrastRatio(bg, subject) };
}

/** Scenes whose palette will not separate subject from background in grayscale. */
export function paletteContrastWarnings(view: ProjectView): Array<{ scene: string; message: string }> {
  const out: Array<{ scene: string; message: string }> = [];
  for (const s of view.scenes) {
    if (!s.palette) continue;
    const r = paletteRoles(s.palette);
    if (r.ratio < 2) out.push({ scene: s.slug, message: `palette ${s.palette.colors.join(" ")}: the strongest pair has a contrast of ${r.ratio.toFixed(2)}:1 — in black and white the subject merges with the background; separate them by value, not hue` });
  }
  return out;
}

function esc(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cell(sh: ShotView, label: string, palette: ScenePalette | undefined, names: Map<string, string>): string {
  const { bg, subject, accent } = paletteRoles(palette);
  const c = sh.spec.cinematography ?? {};
  const size = (c.size as string | undefined) ?? "ms";
  const hRatio = SIZE_H[size] ?? 0.6;
  const h = CELL_H * hRatio;
  const w = Math.min(CELL_W * 0.5, h * (size === "insert" ? 0.9 : 0.42));
  const xs = sh.spec.composition?.subjectX === "left" ? 0.38 : sh.spec.composition?.subjectX === "right" ? 0.62 : 0.5;
  const top = CELL_H * (HEADROOM[sh.spec.composition?.headroom ?? "normal"] ?? 0.08);
  const cx = CELL_W * xs;
  const headR = Math.min(w * 0.42, h * 0.16);
  const parts: string[] = [];
  parts.push(`<rect width="${CELL_W}" height="${CELL_H}" fill="${bg}"/>`);
  /* the 38 % / 62 % guides */
  for (const g of [0.38, 0.62]) parts.push(`<line x1="${CELL_W * g}" y1="0" x2="${CELL_W * g}" y2="${CELL_H}" stroke="#ffffff" stroke-opacity=".28" stroke-dasharray="4 4"/>`);
  /* the subject: head and body as blocks */
  if (size === "insert") {
    parts.push(`<rect x="${cx - w / 2}" y="${CELL_H * 0.2}" width="${w}" height="${CELL_H * 0.6}" rx="10" fill="${accent}"/>`);
  } else {
    parts.push(`<rect x="${cx - w / 2}" y="${top + headR * 1.6}" width="${w}" height="${Math.max(0, h - headR * 1.6)}" rx="${w * 0.18}" fill="${subject}"/>`);
    parts.push(`<circle cx="${cx}" cy="${top + headR}" r="${headR}" fill="${subject}"/>`);
    parts.push(`<line x1="${cx - headR}" y1="${top + headR * 0.9}" x2="${cx + headR}" y2="${top + headR * 0.9}" stroke="${bg}" stroke-width="2"/>`);
  }
  if (size === "twoshot" || size === "ots") {
    const ox = xs <= 0.5 ? CELL_W * 0.75 : CELL_W * 0.25;
    parts.push(`<rect x="${ox - w * 0.45}" y="${top + headR * 1.8}" width="${w * 0.9}" height="${h * 0.95}" rx="${w * 0.16}" fill="${subject}" fill-opacity=".7"/>`);
    parts.push(`<circle cx="${ox}" cy="${top + headR * 1.1}" r="${headR * 0.95}" fill="${subject}" fill-opacity=".7"/>`);
  }
  /* blocking arrows */
  (sh.spec.blocking ?? []).slice(0, 3).forEach((b, k) => {
    if (!b.from && !b.to) return;
    const y = CELL_H * (0.86 - k * 0.1);
    const x1 = CELL_W * (POS_X[b.from ?? b.to ?? "center"] ?? 0.5);
    const x2 = CELL_W * (POS_X[b.to ?? b.from ?? "center"] ?? 0.5);
    parts.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#ffd166" stroke-width="3" marker-end="url(#arrow)"/>`);
    parts.push(`<text x="${Math.min(x1, x2) + 4}" y="${y - 5}" font-size="10" fill="#ffd166">${esc(names.get(b.who) ?? b.who)}</text>`);
  });
  /* what moves */
  const motion = sh.spec.motion?.length ? sh.spec.motion.join(" · ") : "motion?";
  const dead = sh.spec.camera.move === "static" && (!sh.spec.motion || sh.spec.motion.filter((m) => m !== "camera").length === 0);
  parts.push(`<rect x="0" y="0" width="${CELL_W}" height="20" fill="#000" fill-opacity=".55"/>`);
  parts.push(`<text x="6" y="14" font-size="11" fill="#fff">${esc(label)} · ${esc(size)}${c.angle ? ` · ${esc(String(c.angle))}` : ""} · ${esc(sh.spec.camera.move.replace("_", " "))} · ${sh.spec.durationS}s</text>`);
  parts.push(`<text x="${CELL_W - 6}" y="${CELL_H - 6}" font-size="10" text-anchor="end" fill="${dead ? "#ff6b6b" : "#ffffff"}" fill-opacity=".85">${esc(dead ? "dead frame" : motion)}</text>`);
  return parts.join("");
}

/** The whole board as one SVG; `gray` renders it in black and white. */
export function sketchBoardSvg(view: ProjectView, opts: { gray?: boolean } = {}): string {
  const names = new Map(view.elements.map((e) => [e.id, e.name]));
  const flat = view.scenes.flatMap((s) => s.shots.map((sh) => ({ scene: s, sh })));
  const rows = Math.max(1, Math.ceil(flat.length / COLS));
  const W = COLS * CELL_W + (COLS + 1) * GAP;
  const H = rows * (CELL_H + GAP + 18) + GAP + 30;
  const cells = flat.map(({ scene, sh }, i) => {
    const x = GAP + (i % COLS) * (CELL_W + GAP);
    const y = GAP + 30 + Math.floor(i / COLS) * (CELL_H + GAP + 18);
    const link = sh.spec.link?.type ?? sh.spec.linkToPrev;
    const linkBadge = i > 0 && link && link !== "cut" ? `<text x="${x - GAP / 2}" y="${y + CELL_H / 2}" font-size="10" text-anchor="middle" fill="#9aa0a6" transform="rotate(-90 ${x - GAP / 2} ${y + CELL_H / 2})">${esc(link)}</text>` : "";
    const intent = sh.spec.intent.length > 64 ? `${sh.spec.intent.slice(0, 63)}…` : sh.spec.intent;
    return `${linkBadge}<g transform="translate(${x} ${y})"><clipPath id="c${i}"><rect width="${CELL_W}" height="${CELL_H}" rx="6"/></clipPath><g clip-path="url(#c${i})">${cell(sh, `${scene.slug} #${sh.index + 1}`, scene.palette, names)}</g><text x="0" y="${CELL_H + 14}" font-size="11" fill="#c8ccd0">${esc(intent)}</text></g>`;
  });
  const title = `${view.project.name} — colour-block storyboard${opts.gray ? " (grayscale value check)" : ""}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif">`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#ffd166"/></marker>`,
    `<filter id="gray"><feColorMatrix type="saturate" values="0"/></filter></defs>`,
    `<rect width="${W}" height="${H}" fill="#141518"/>`,
    `<text x="${GAP}" y="${GAP + 4}" font-size="15" fill="#e8eaed">${esc(title)}</text>`,
    `<g${opts.gray ? ' filter="url(#gray)"' : ""}>${cells.join("")}</g>`,
    `</svg>`,
  ].join("");
}
