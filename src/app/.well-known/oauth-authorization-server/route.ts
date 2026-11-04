import { NextResponse } from "next/server";

import { authorizationServerMetadata } from "@/oauth/server";

export function GET(): Response {
  return NextResponse.json(authorizationServerMetadata(), { headers: { "Cache-Control": "public, max-age=3600" } });
}
