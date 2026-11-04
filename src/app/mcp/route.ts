import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NextResponse } from "next/server";

import { authenticateBearer } from "@/auth/access";
import { createStudioServer } from "@/mcp/server";
import { config } from "@/studio/config";

/* Stateless Streamable HTTP: a fresh server + transport per request, which is
   what a Worker wants. Unauthenticated calls get the 401 that tells MCP
   clients where the OAuth metadata lives. */

async function handle(req: Request): Promise<Response> {
  const actor = await authenticateBearer(req);
  if (!actor) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${config.publicUrl()}/.well-known/oauth-protected-resource"` } },
    );
  }
  const server = createStudioServer(actor);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void transport.close().catch(() => undefined);
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
