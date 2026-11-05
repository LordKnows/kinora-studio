import { requireActor } from "@/auth/access";
import { errorResponse } from "@/api/http";
import * as orch from "@/studio/orchestrator";
import * as repo from "@/studio/repo";

/* SSE: a status snapshot of every take and export whenever it changes.
   Polls the database rather than an in-process emitter so it behaves the same
   across Workers isolates; the poll slows to 15 s when nothing is in flight. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireActor(req, ["web"]);
    const { id } = await ctx.params;
    await repo.getProject(id);
    const encoder = new TextEncoder();
    /* One Worker invocation carries one stream; its CPU budget is per
       invocation, so the stream is ended every couple of minutes and the
       browser's EventSource reconnects into a fresh one. */
    const openedAt = Date.now();
    const MAX_STREAM_MS = 120_000;
    let last = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const stop = () => {
      closed = true;
      if (timer) clearTimeout(timer);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const tick = async () => {
          if (closed) return;
          let busy = false;
          try {
            let [takes, exports] = await Promise.all([repo.listProjectTakes(id), repo.listExports(id)]);
            /* Ask the pod about the takes in flight so their progress (stage, step, ETA) rides along. */
            const inFlight = takes.filter((t) => ((t.status === "queued" || t.status === "running") && t.requestId) || (t.upscale && (t.upscale.status === "queued" || t.upscale.status === "running"))).slice(0, 4);
            if (inFlight.length) {
              await Promise.all(inFlight.map((t) => orch.refreshTake(t.id).catch(() => undefined)));
              takes = await repo.listProjectTakes(id);
            }
            busy = takes.some((t) => t.status === "queued" || t.status === "running" || (t.upscale && (t.upscale.status === "queued" || t.upscale.status === "running"))) || exports.some((x) => x.status === "queued" || x.status === "running");
            const snapshot = JSON.stringify({
              takes: takes.map((t) => ({ id: t.id, shotId: t.shotId, status: t.status, resultUrl: t.resultUrl, thumbUrls: t.thumbUrls, costUsd: t.costUsd, progress: t.progress, upscale: t.upscale ? { status: t.upscale.status, url: t.upscale.url, progress: t.upscale.progress } : undefined })),
              exports: exports.map((x) => ({ id: x.id, status: x.status, resultUrl: x.resultUrl })),
            });
            if (snapshot !== last) {
              last = snapshot;
              controller.enqueue(encoder.encode(`event: snapshot\ndata: ${snapshot}\n\n`));
            } else {
              controller.enqueue(encoder.encode(`: ping\n\n`));
            }
          } catch {
            stop();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            return;
          }
          if (Date.now() - openedAt > MAX_STREAM_MS) {
            stop();
            try {
              controller.enqueue(encoder.encode("retry: 1000\n: rotate\n\n"));
              controller.close();
            } catch {
              /* already closed */
            }
            return;
          }
          timer = setTimeout(() => void tick(), busy ? 3000 : 15000);
        };
        void tick();
      },
      cancel() {
        stop();
      },
    });
    req.signal.addEventListener("abort", stop);
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
  } catch (caught) {
    return errorResponse(caught);
  }
}
