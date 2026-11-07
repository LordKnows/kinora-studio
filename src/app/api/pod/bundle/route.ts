import { config } from "@/studio/config";
import { POD_BUNDLE_BASE64 } from "@/pod/bundle";

/* The job-server bundle a fresh pod fetches at boot (see gpu.ts bootstrap
   command). Protected by the shared worker token, carried as a query string
   because the fetch runs from a shell one-liner. Painters use it too, with PAINTER_TOKEN. Access bypass: /api/pod/*. */
export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  let expected = "";
  try {
    expected = config.runpodPod().workerToken;
  } catch {
    if (!config.painterToken()) return new Response("neither STUDIO_WORKER_TOKEN nor PAINTER_TOKEN is set", { status: 500 });
  }
  /* painters (workers/painter) bootstrap from the same bundle with their own token */
  const painter = config.painterToken();
  if (!token || (token !== expected && token !== painter)) return new Response("unauthorized", { status: 401 });
  const bytes = Uint8Array.from(atob(POD_BUNDLE_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { "Content-Type": "application/gzip", "Content-Disposition": "attachment; filename=bundle.tgz", "Cache-Control": "no-store" } });
}
