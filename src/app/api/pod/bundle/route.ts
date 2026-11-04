import { config } from "@/studio/config";
import { POD_BUNDLE_BASE64 } from "@/pod/bundle";

/* The job-server bundle a fresh pod fetches at boot (see gpu.ts bootstrap
   command). Protected by the shared worker token, carried as a query string
   because the fetch runs from a shell one-liner. Access bypass: /api/pod/*. */
export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  let expected: string;
  try {
    expected = config.runpodPod().workerToken;
  } catch {
    return new Response("pod mode is not configured", { status: 500 });
  }
  if (!token || token !== expected) return new Response("unauthorized", { status: 401 });
  const bytes = Uint8Array.from(atob(POD_BUNDLE_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { "Content-Type": "application/gzip", "Content-Disposition": "attachment; filename=bundle.tgz", "Cache-Control": "no-store" } });
}
