/* Reading a screenplay's text for the Script page: its sections (one per
   scene heading, with the time range a heading states, if any), and what
   changed between two versions, sentence by sentence. Nothing here links a
   sentence to a shot: the data has no such link, so the page pairs sections
   with scenes by order and says so. */

export type ScriptSection = { heading: string; body: string; fromS?: number; toS?: number };

const RANGE = /(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})/;
const HEADING = /^(#{1,4}\s+|(?:INT|EXT|INT\/EXT|I\/E)[.\s]|序列|第[一二三四五六七八九十百\d]+[场幕章节]|场景|scene\s+\d|sequence\s+\d)/i;

export function scriptSections(text: string): { preamble: string; sections: ScriptSection[] } {
  const lines = text.split(/\r?\n/);
  const sections: ScriptSection[] = [];
  const pre: string[] = [];
  let cur: ScriptSection | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const isHeading = line.length > 0 && line.length <= 80 && (HEADING.test(line) || (RANGE.test(line) && line.length <= 60));
    if (isHeading) {
      const m = RANGE.exec(line);
      cur = { heading: line.replace(/^#{1,4}\s+/, ""), body: "", ...(m ? { fromS: Number(m[1]) * 60 + Number(m[2]), toS: Number(m[3]) * 60 + Number(m[4]) } : {}) };
      sections.push(cur);
    } else if (cur) {
      cur.body += (cur.body ? "\n" : "") + raw;
    } else {
      pre.push(raw);
    }
  }
  for (const s of sections) s.body = s.body.trim();
  return { preamble: pre.join("\n").trim(), sections };
}

/** Sentences (and CJK clauses), keeping their closing punctuation; line breaks end one too. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    /* CJK clauses end at ，；too, so one changed clause does not strike the whole sentence */
    const parts = para.match(/[^。！？!?.，；]+[。！？!?.，；]*["”」』）)]*\s*/g) ?? [];
    for (const p of parts) if (p.trim()) out.push(p.trim());
    out.push("\n");
  }
  while (out[out.length - 1] === "\n") out.pop();
  return out;
}

export type DiffPart = { kind: "same" | "added" | "removed"; text: string };

/** What changed from `before` to `after`, sentence by sentence (longest common subsequence). */
export function diffSentences(before: string, after: string): DiffPart[] {
  const a = sentences(before);
  const b = sentences(after);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind && text !== "\n" && last.text !== "\n") last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("same", a[i]!); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { push("removed", a[i]!); i++; }
    else { push("added", b[j]!); j++; }
  }
  while (i < n) push("removed", a[i++]!);
  while (j < m) push("added", b[j++]!);
  return out;
}
