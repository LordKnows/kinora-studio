import { config } from "./config";
import type { Take } from "./types";

/* Cost is GPU-seconds × price. The seconds-per-output-second figure is a
   placeholder until P0 measures it; every estimate carries its inputs so the
   UI can show where the number came from. */

export type Estimate = { usd: number; gpuSeconds: number; perOutputSecond: number; usdPerGpuSecond: number; steps: number; source: "measured" | "placeholder" };

/** Measured figures (from GPU stats) beat the placeholder constants. */
export type Measured = { secondsPerOutputSecond?: number; usdPerHr?: number };

export function estimateTake(durationS: number, steps = 8, n = 1, measured?: Measured): Estimate {
  const rp = safeRunpod();
  const perOutputSecond = measured?.secondsPerOutputSecond ?? rp.secondsPerOutputSecond;
  const usdPerGpuSecond = measured?.usdPerHr !== undefined ? measured.usdPerHr / 3600 : rp.gpuUsdPerSecond;
  const stepFactor = steps / 8;
  const gpuSeconds = durationS * perOutputSecond * stepFactor * n;
  return {
    usd: round(gpuSeconds * usdPerGpuSecond), gpuSeconds, perOutputSecond, usdPerGpuSecond, steps,
    source: measured?.secondsPerOutputSecond !== undefined ? "measured" : "placeholder",
  };
}

export function podTakeUsd(executionMs: number, usdPerHr: number): number {
  return round((executionMs / 3_600_000) * usdPerHr);
}

export function actualTakeUsd(executionMs: number): number {
  return round((executionMs / 1000) * safeRunpod().gpuUsdPerSecond);
}

/** Money already promised to takes still in flight; counted against the cap
    so parallel requests cannot each pass the check alone. */
export function reservedUsd(activeTakes: Take[]): number {
  let total = 0;
  for (const take of activeTakes) {
    const seconds = typeof take.input.seconds === "number" ? take.input.seconds : 8;
    const steps = typeof take.input.steps === "number" ? take.input.steps : 8;
    total += estimateTake(seconds, steps).usd;
  }
  return round(total);
}

export function estimateExport(totalSeconds: number, upscale: boolean): number {
  /* CPU assembly is cents; upscaling goes back through the GPU worker. */
  const cpu = 0.01 + totalSeconds * 0.0005;
  const gpu = upscale ? totalSeconds * safeRunpod().secondsPerOutputSecond * 0.5 * safeRunpod().gpuUsdPerSecond : 0;
  return round(cpu + gpu);
}

function safeRunpod() {
  try {
    return config.runpod();
  } catch {
    return { gpuUsdPerSecond: 0.0012, secondsPerOutputSecond: 12, coldStartSeconds: 90, executionTimeoutMs: 900000 };
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Open-H3-Regenerate-2K: three refine steps plus decode. Measured on an RTX
    PRO 5000: ~150 GPU-seconds for 5 s at 2K (dense attention, sparse is ~4×
    faster); 4K runs two passes. REGEN_SECONDS_PER_OUTPUT_SECOND overrides. */
export function estimateUpscale(durationS: number, resolution: "1080p" | "2k" | "4k", measured?: Measured): Estimate {
  const rp = safeRunpod();
  const base = Number(process.env.REGEN_SECONDS_PER_OUTPUT_SECOND ?? "30");
  const factor = resolution === "4k" ? 2.2 : resolution === "1080p" ? 0.6 : 1;
  const perOutputSecond = base * factor;
  const usdPerGpuSecond = measured?.usdPerHr !== undefined ? measured.usdPerHr / 3600 : rp.gpuUsdPerSecond;
  const gpuSeconds = durationS * perOutputSecond;
  return { usd: round(gpuSeconds * usdPerGpuSecond), gpuSeconds, perOutputSecond, usdPerGpuSecond, steps: 3, source: measured?.usdPerHr !== undefined ? "measured" : "placeholder" };
}
