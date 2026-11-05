import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Line } from "./srt.js";

/**
 * Narration adapter. The Studio's H3 dialogue is unverified, so narration is a
 * separate track mixed by the local assembler. Engines:
 *  - `edge-tts` (Microsoft neural voices, online; `pip install edge-tts`) for Chinese and English
 *  - `say` (macOS) as a fallback for quick previews
 * Returns one WAV/MP3 per line and the measured durations (via ffprobe).
 */
export interface TtsOptions {
  engine?: "edge-tts" | "say";
  voice?: string;
  rate?: string;
  outDir: string;
}

export interface TtsResult { id: string; file: string; durationS: number }

function run(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: 127, out, err: String(e) }));
    p.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

export async function probeDurationS(file: string): Promise<number> {
  const r = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const d = parseFloat(r.out.trim());
  if (!Number.isFinite(d)) throw new Error(`ffprobe failed on ${file}: ${r.err}`);
  return d;
}

export async function synthesize(lines: Line[], o: TtsOptions): Promise<TtsResult[]> {
  mkdirSync(o.outDir, { recursive: true });
  const engine = o.engine ?? "edge-tts";
  const results: TtsResult[] = [];
  for (const l of lines) {
    const zh = /[一-鿿]/.test(l.text);
    if (engine === "edge-tts") {
      const file = join(o.outDir, `${l.id}.mp3`);
      const voice = o.voice ?? (zh ? "zh-CN-XiaoxiaoNeural" : "en-US-AriaNeural");
      const args = ["--voice", voice, "--text", l.text, "--write-media", file];
      if (o.rate) args.push("--rate", o.rate);
      const r = await run("edge-tts", args);
      if (r.code !== 0 || !existsSync(file)) throw new Error(`edge-tts failed for ${l.id} (install: pip install edge-tts; needs network): ${r.err.slice(0, 300)}`);
      results.push({ id: l.id, file, durationS: await probeDurationS(file) });
    } else {
      const aiff = join(o.outDir, `${l.id}.aiff`);
      const args = ["-o", aiff, l.text];
      if (o.voice) args.unshift("-v", o.voice);
      const r = await run("say", args);
      if (r.code !== 0) throw new Error(`say failed for ${l.id}: ${r.err.slice(0, 300)}`);
      results.push({ id: l.id, file: aiff, durationS: await probeDurationS(aiff) });
    }
  }
  return results;
}
