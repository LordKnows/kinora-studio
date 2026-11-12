import { scriptSections } from "./script-text";

/* Which lines of the script are on screen: each shot names the script lines
   it shows (spec.scriptLines, quoted from the script), and every sentence of
   the scenes is matched against those quotes. A sentence is covered when a
   quote is part of it (a clause) or it is part of a quote (a quote over two
   sentences covers both). Matching ignores spacing and punctuation, so a
   quote copied with a different comma still counts. Coverage is kept clause
   by clause (，；, ; : end one), so a shot that quotes half a sentence leaves
   the other half open. The preamble before the first scene heading (title,
   cast) is not something to shoot. */

export type CoverageShot = { id: string; slate: string; scriptLines?: string[] };
/** A sentence, and its clauses each with the shots that show them; `shots` is all of them. */
export type ScriptLine = { text: string; section: number; shots: string[]; parts: Array<{ text: string; shots: string[] }>; open: boolean };
export type Coverage = {
  /** every sentence of the scenes, in order, with the shots that show it */
  lines: ScriptLine[];
  /** quotes the current script does not have */
  stale: Array<{ shotId: string; slate: string; quote: string }>;
  /** whether any shot names its lines at all (the lint asks for coverage only then) */
  inUse: boolean;
};

/** What of a line no shot shows: its open clauses, run together. */
export const openText = (l: ScriptLine) => l.parts.filter((p) => p.shots.length === 0).map((p) => p.text).join("").trim();

export const normalize = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

/** A section's sentences: they end at 。！？!? or a full stop, and at a line break. */
export function lineSentences(body: string): string[] {
  const out: string[] = [];
  for (const para of body.split(/\n+/)) {
    for (const p of para.match(/[^。！？!?.]+[。！？!?.]*["”」』）)]*\s*/g) ?? []) {
      const t = p.trim();
      if (normalize(t).length >= 2) out.push(t);
    }
  }
  return out;
}

export function coverage(text: string, shots: CoverageShot[]): Coverage {
  const { preamble, sections } = scriptSections(text);
  const units = sections.length
    ? sections.flatMap((s, i) => lineSentences(s.body).map((t) => ({ text: t, section: i })))
    : lineSentences(preamble).map((t) => ({ text: t, section: 0 }));
  const whole = normalize(text);
  const quotes = shots.flatMap((s) => (s.scriptLines ?? []).map((q) => ({ shot: s, quote: q, key: normalize(q) }))).filter((q) => q.key.length >= 2);
  const lines = units.map((u) => {
    const sentenceKey = normalize(u.text);
    const parts = clauses(u.text).map((text) => {
      const key = normalize(text);
      /* a clause is shown by a quote that holds it, or by a quote it holds (part of it)… */
      const by = quotes.filter((q) => q.key.includes(key) || key.includes(q.key)).map((q) => q.shot.id);
      return { text, shots: [...new Set(by)] };
    });
    /* …and a quote that sits inside the sentence but across clauses shows the clauses it touches */
    for (const q of quotes) {
      if (!sentenceKey.includes(q.key)) continue;
      const at = sentenceKey.indexOf(q.key);
      const end = at + q.key.length;
      let pos = 0;
      for (const part of parts) {
        const len = normalize(part.text).length;
        if (pos < end && pos + len > at && !part.shots.includes(q.shot.id)) part.shots.push(q.shot.id);
        pos += len;
      }
    }
    const shots = [...new Set(parts.flatMap((x) => x.shots))];
    return { ...u, shots, parts, open: parts.some((x) => x.shots.length === 0) };
  });
  const stale = quotes.filter((q) => !whole.includes(q.key)).map((q) => ({ shotId: q.shot.id, slate: q.shot.slate, quote: q.quote }));
  return { lines, stale, inUse: quotes.length > 0 };
}

/** A sentence's clauses: they end at ，；, ; : (with their mark); a fragment too short to stand alone joins the one before. */
export function clauses(sentence: string): string[] {
  const out: string[] = [];
  for (const p of sentence.match(/[^，；,;：:]+[，；,;：:]*\s*/g) ?? [sentence]) {
    if (out.length && normalize(p).length < 2) out[out.length - 1] += p;
    else out.push(p);
  }
  return out.length ? out : [sentence];
}
