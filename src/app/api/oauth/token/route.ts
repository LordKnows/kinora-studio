import { NextResponse } from "next/server";

import { OAuthError, exchangeToken } from "@/oauth/server";

export async function POST(req: Request): Promise<Response> {
  try {
    const type = req.headers.get("content-type") ?? "";
    const form = type.includes("application/json")
      ? new URLSearchParams(Object.entries((await req.json()) as Record<string, string>))
      : new URLSearchParams(await req.text());
    return NextResponse.json(await exchangeToken(form), { headers: { "Cache-Control": "no-store" } });
  } catch (caught) {
    if (caught instanceof OAuthError) return NextResponse.json(caught.toJSON(), { status: 400 });
    return NextResponse.json({ error: "server_error", error_description: caught instanceof Error ? caught.message : String(caught) }, { status: 500 });
  }
}
