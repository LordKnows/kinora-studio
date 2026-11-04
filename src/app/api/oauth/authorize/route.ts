import { NextResponse } from "next/server";

import { requireActor } from "@/auth/access";
import { errorResponse } from "@/api/http";
import { issueCode, parseAuthorize } from "@/oauth/server";

/* The consent form posts here. Only a signed-in web user can approve. */
export async function POST(req: Request): Promise<Response> {
  try {
    const actor = await requireActor(req, ["web"]);
    const form = await req.formData();
    const url = new URL(req.url);
    for (const key of ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "response_type"]) {
      const v = form.get(key);
      if (typeof v === "string" && v) url.searchParams.set(key, v);
    }
    if (form.get("decision") !== "allow") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "/");
      back.searchParams.set("error", "access_denied");
      return NextResponse.redirect(back.toString(), 303);
    }
    const params = await parseAuthorize(url);
    return NextResponse.redirect(await issueCode(params, actor.user), 303);
  } catch (caught) {
    return errorResponse(caught);
  }
}
