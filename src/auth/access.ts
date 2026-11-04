import { createRemoteJWKSet, jwtVerify } from "jose";

import { config } from "@/studio/config";
import { StudioError } from "@/studio/errors";
import { getOAuthToken } from "@/studio/repo";
import type { Actor } from "@/studio/types";

import { sha256Hex } from "./hmac";

/* §7.1 — who is calling. Web requests arrive through Cloudflare Access and
   carry its JWT; agents arrive with an OAuth bearer token (or the static
   token, for clients such as Claude Code that can send headers). */

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function authenticateWeb(request: Request): Promise<Actor | null> {
  if (config.authMode() === "dev") return { user: config.devUser(), via: "web" };
  const { teamDomain, aud } = config.access();
  const token = request.headers.get("cf-access-jwt-assertion") ?? cookie(request, "CF_Authorization");
  if (!token) return null;
  jwks ??= createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${teamDomain}`, audience: aud });
    const email = typeof payload.email === "string" ? payload.email : typeof payload.sub === "string" ? payload.sub : null;
    return email ? { user: email, via: "web" } : null;
  } catch {
    return null;
  }
}

export async function authenticateBearer(request: Request): Promise<Actor | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const token = match[1]!.trim();
  const fixed = config.mcpStaticToken();
  if (fixed && token === fixed) return { user: "mcp-static", via: "mcp" };
  const row = await getOAuthToken(await sha256Hex(token));
  if (!row || row.kind !== "access" || row.expiresAt < Date.now()) return null;
  return { user: row.user, via: "mcp" };
}

export type Allow = "web" | "mcp";

/** Resolve the caller or throw 401; `allow` is the permission column of §7.2. */
export async function requireActor(request: Request, allow: Allow[] = ["web", "mcp"]): Promise<Actor> {
  const web = allow.includes("web") ? await authenticateWeb(request) : null;
  if (web) return web;
  const bearer = await authenticateBearer(request);
  if (bearer) {
    if (!allow.includes("mcp")) throw new StudioError("forbidden", "this endpoint is only available in the web studio");
    return bearer;
  }
  throw new StudioError("unauthorized", "sign in required");
}

function cookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
