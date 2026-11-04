import { NextResponse } from "next/server";

import { errorResponse } from "@/api/http";
import { registerClient } from "@/oauth/server";

export async function POST(req: Request): Promise<Response> {
  try {
    return NextResponse.json(await registerClient(await req.json()), { status: 201 });
  } catch (caught) {
    return errorResponse(caught);
  }
}
