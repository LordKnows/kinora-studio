import { config } from "./config";
import type { Take } from "./types";

/* Cost is GPU-seconds × price. The seconds-per-output-second figure is a
   placeholder until P0 measures it; every estimate carries its inputs so the
   UI can show where the number came from. */

export type Estimate = { usd: number; gpuSeconds: number; perOutputSecond: number; usdPerGpuSecond: number; steps: number };

export function estimateTake(durationS: number, steps = 8, n = 1): Estimate {
  const rp = safeRunpod();
  const stepFactor = steps / 8;
  const gpuSeconds = durationS * rp.secondsPerOutputSecond * stepFactor * n;
  return { usd: round(gpuSeconds * rp.gpuUsdPerSecond), gpuSeconds, perOutputSecond: rp.secondsPerOutputSecond, usdPerGpuSecond: rp.gpuUsdPerSecond, steps };
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
