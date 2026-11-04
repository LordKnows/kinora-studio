import { getModel, parseSettings } from "@/generation/catalog";
import type { GenerationPlane } from "@/generation/catalog/types";
import { createPlatformClient } from "@/generation/platform";
import { toPlatform } from "@/generation/to-platform";

import { StudioError } from "../errors";
import type { BackendStatus, GenerationBackend } from "./types";

/* Stills for hero frames and element sheets come from the existing image
   catalog (Soul 2 by default), through the platform client the playground
   already uses. Only the server's own key is used here. */

export type ImageRequest = { prompt: string; aspectRatio: string; n: number; modelId?: string };

const SOUL_ASPECTS = new Set(["9:16", "16:9", "4:3", "3:4", "1:1", "2:3", "3:2"]);

export function imagePlane(req: ImageRequest): GenerationPlane {
  const modelId = req.modelId ?? "soul-2";
  const model = getModel(modelId);
  const raw: Record<string, unknown> = {};
  if (model.settings.aspectRatio) raw.aspectRatio = SOUL_ASPECTS.has(req.aspectRatio) ? req.aspectRatio : "16:9";
  if (model.settings.batchSize) raw.batchSize = req.n >= 4 ? "4" : "1";
  if (model.settings.resolution) raw.resolution = model.settings.resolution.type === "enum" ? model.settings.resolution.values[model.settings.resolution.values.length - 1] : undefined;
  return { model: modelId, prompt: { text: req.prompt }, media: {}, settings: parseSettings(model, raw) };
}

export class HiggsfieldImageBackend implements GenerationBackend {
  private readonly client: ReturnType<typeof createPlatformClient>;

  constructor(opts: { apiKey: string; baseUrl: string; fetch?: typeof fetch }) {
    this.client = createPlatformClient(opts);
  }

  async submit(input: Record<string, unknown>): Promise<{ requestId: string }> {
    const plane = imagePlane(input as ImageRequest);
    const { path, body } = toPlatform(plane);
    try {
      const queued = await this.client.submit(path, body);
      return { requestId: queued.requestId };
    } catch (caught) {
      throw new StudioError("backend_error", caught instanceof Error ? caught.message : String(caught));
    }
  }

  async status(requestId: string): Promise<BackendStatus> {
    const status = await this.client.status(requestId);
    switch (status.status) {
      case "completed":
        return { state: "completed", output: { images: status.images ?? [] } };
      case "failed":
      case "nsfw":
        return { state: "failed", error: typeof status.error === "string" ? status.error : status.status };
      case "canceled":
        return { state: "canceled" };
      case "queued":
        return { state: "queued" };
      default:
        return { state: "running" };
    }
  }

  async cancel(): Promise<void> {
    /* The platform exposes a cancel URL per request; the playground never used it and neither do we. */
  }
}
