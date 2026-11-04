import { requireActor } from "@/auth/access";
import { errorResponse } from "@/api/http";
import * as repo from "@/studio/repo";

/* SSE: a status snapshot of every take, job and export whenever it changes.
   Polls the database rather than an in-process emitter so it behaves the same
   across Workers isolates. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireActor(req, ["web"]);
    const { id } = await ctx.params;
    await repo.getProject(id);
    const encoder = new TextEncoder();
    let last = "";
    let timer: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const tick = async () => {
          try {
            const [takes, exports] = await Promise.all([repo.listProjectTakes(id), repo.listExports(id)]);
            const snapshot = JSON.stringify({
              takes: takes.map((t) => ({ id: t.id, shotId: t.shotId, status: t.status, resultUrl: t.resultUrl, thumbUrls: t.thumbUrls, costUsd: t.costUsd })),
              exports: exports.map((e) => ({ id: e.id, status: e.status, resultUrl: e.resultUrl })),
            });
            if (snapshot !== last) {
              last = snapshot;
              controller.enqueue(encoder.encode(`event: snapshot\ndata: ${snapshot}\n\n`));
            } else {
              controller.enqueue(encoder.encode(`: ping\n\n`));
            }
          } catch {
            controller.close();
            if (timer) clearInterval(timer);
          }
        };
        void tick();
        timer = setInterval(() => void tick(), 3000);
      },
      cancel() {
        if (timer) clearInterval(timer);
      },
    });
    req.signal.addEventListener("abort", () => {
      if (timer) clearInterval(timer);
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
  } catch (caught) {
    return errorResponse(caught);
  }
}
