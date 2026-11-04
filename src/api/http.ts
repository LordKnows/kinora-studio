import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";

import { requireActor, type Allow } from "@/auth/access";
import { StudioError } from "@/studio/errors";
import type { Actor } from "@/studio/types";

/* Route handler plumbing: one error model, one auth call, one body parser. */

export type Params = Record<string, string>;
export type Ctx = { params: Promise<Params> };

type Handler = (req: Request, args: { params: Params; actor: Actor }) => Promise<Response | unknown>;

export function route(allow: Allow[] | "public", handler: Handler) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      const params = await ctx.params;
      const actor = allow === "public" ? { user: "anonymous", via: "web" as const } : await requireActor(req, allow);
      const result = await handler(req, { params, actor });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (caught) {
      return errorResponse(caught);
    }
  };
}

export function errorResponse(caught: unknown): Response {
  if (caught instanceof StudioError) return NextResponse.json(caught.toJSON(), { status: caught.status });
  if (caught instanceof ZodError) {
    return NextResponse.json({ error: { code: "validation", message: "invalid input", details: caught.issues } }, { status: 400 });
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  console.error("[api] unhandled", caught);
  return NextResponse.json({ error: { code: "backend_error", message } }, { status: 500 });
}

export async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown = {};
  const text = await req.text();
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new StudioError("validation", "body must be JSON");
    }
  }
  return schema.parse(raw);
}

export const noStore = { headers: { "Cache-Control": "no-store" } };
