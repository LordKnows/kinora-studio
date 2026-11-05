/** Subtitle and narration helpers: reading time, SRT, and line placement on a cue grid. */

export interface Line {
  id: string;
  text: string;
  /** Start second; filled by `placeLines` when missing. */
  t0?: number;
  /** End second. */
  t1?: number;
  language?: string;
  /** Measured speech duration from TTS, if known. */
  speechS?: number;
}

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/g;

/** Reading time rule: CJK ÷ 4.5 + other non-space ÷ 15 + 1.5 s, never under 1.8 s. */
export function readingTimeS(text: string, _language = "en"): number {
  const cjk = (text.match(CJK) ?? []).length;
  const other = text.replace(CJK, "").replace(/\s+/g, "").length;
  return Math.max(1.8, cjk / 4.5 + other / 15 + 1.5);
}

/** Minimum hold for a subtitle: at least 1.8 s and speech + 0.6 s. */
export function minHoldS(line: Line): number {
  const read = readingTimeS(line.text, line.language);
  const speech = line.speechS != null ? line.speechS + 0.6 : 0;
  return Math.max(1.8, read, speech);
}

export interface SubtitleIssue { id: string; message: string }

export function checkLines(lines: Line[]): SubtitleIssue[] {
  const out: SubtitleIssue[] = [];
  const sorted = [...lines].filter((l) => l.t0 != null && l.t1 != null).sort((a, b) => a.t0! - b.t0!);
  for (const l of sorted) {
    const hold = l.t1! - l.t0!;
    const need = minHoldS(l);
    if (hold + 1e-6 < need) out.push({ id: l.id, message: `held ${hold.toFixed(2)}s, needs ${need.toFixed(2)}s` });
    if (l.text.length > 84) out.push({ id: l.id, message: "over two balanced lines; split it" });
  }
  for (let i = 1; i < sorted.length; i++) if (sorted[i].t0! < sorted[i - 1].t1!) out.push({ id: sorted[i].id, message: `overlaps ${sorted[i - 1].id}` });
  return out;
}

/** Lay lines out in order from `startS`, each held for its minimum, with a gap. */
export function placeLines(lines: Line[], startS = 0, gapS = 0.3): Line[] {
  let t = startS;
  return lines.map((l) => {
    const t0 = l.t0 ?? t;
    const t1 = l.t1 ?? t0 + minHoldS(l);
    t = t1 + gapS;
    return { ...l, t0, t1 };
  });
}

function ts(s: number): string {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000), mm = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(mm).padStart(3, "0")}`;
}

export function toSrt(lines: Line[]): string {
  const placed = lines.filter((l) => l.t0 != null && l.t1 != null).sort((a, b) => a.t0! - b.t0!);
  return placed.map((l, i) => `${i + 1}\n${ts(l.t0!)} --> ${ts(l.t1!)}\n${l.text}\n`).join("\n") + (placed.length ? "\n" : "");
}

/** Numbers: digits on screen, words in speech. Returns the TTS text for a subtitle line (English only; CJK TTS reads digits fine). */
export function spellNumbersForSpeech(text: string): string {
  const ones = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const say = (n: number): string => {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? "-" + ones[n % 10] : "");
    if (n < 1000) return ones[Math.floor(n / 100)] + " hundred" + (n % 100 ? " and " + say(n % 100) : "");
    if (n < 1000000) return say(Math.floor(n / 1000)) + " thousand" + (n % 1000 ? " " + say(n % 1000) : "");
    return String(n);
  };
  return text.replace(/\b\d{1,6}\b/g, (m) => say(Number(m)));
}
