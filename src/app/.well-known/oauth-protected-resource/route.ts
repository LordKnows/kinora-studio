import { NextResponse } from "next/server";

import { protectedResourceMetadata } from "@/oauth/server";

export function GET(): Response {
  return NextResponse.json(protectedResourceMetadata(), { headers: { "Cache-Control": "public, max-age=3600" } });
}
