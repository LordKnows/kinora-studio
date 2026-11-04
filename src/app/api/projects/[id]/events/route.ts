import { requireActor } from "@/auth/access";
import { errorResponse } from "@/api/http";
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
            const [takes, exports] = await Promise.all([repo.listProjectTakes(id), repo.listExports(id)]);
            busy = takes.some((t) => t.status === "queued" || t.status === "running") || exports.some((x) => x.status === "queued" || x.status === "running");
            const snapshot = JSON.stringify({
              takes: takes.map((t) => ({ id: t.id, shotId: t.shotId, status: t.status, resultUrl: t.resultUrl, thumbUrls: t.thumbUrls, costUsd: t.costUsd })),
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
