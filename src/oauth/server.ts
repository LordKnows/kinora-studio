import { randomToken, sha256Hex } from "@/auth/hmac";
import { config } from "@/studio/config";
import { StudioError } from "@/studio/errors";
import * as repo from "@/studio/repo";

/* A deliberately small OAuth 2.1 authorization server: dynamic client
   registration, authorization code + PKCE (S256), bearer access tokens and
   refresh tokens, all stored in the studio database. Enough for Claude's and
   Grok's custom connectors; the consent page sits behind Cloudflare Access. */

const CODE_TTL_MS = 10 * 60_000;
const ACCESS_TTL_MS = 30 * 24 * 60 * 60_000;
const REFRESH_TTL_MS = 180 * 24 * 60 * 60_000;

export function authorizationServerMetadata() {
  const base = config.publicUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["studio"],
  };
}

export function protectedResourceMetadata() {
  const base = config.publicUrl();
  return { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["studio"], bearer_methods_supported: ["header"] };
}

export async function registerClient(body: unknown) {
  const b = (body ?? {}) as { client_name?: unknown; redirect_uris?: unknown };
  const redirectUris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (redirectUris.length === 0) throw new StudioError("validation", "redirect_uris required");
  for (const uri of redirectUris) {
    const url = new URL(uri);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new StudioError("validation", `redirect_uri must be https: ${uri}`);
  }
  const client = await repo.createOAuthClient({ clientName: typeof b.client_name === "string" ? b.client_name : "MCP client", redirectUris });
  return {
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

export type AuthorizeParams = { clientId: string; redirectUri: string; codeChallenge: string; state: string; scope: string };

export async function parseAuthorize(url: URL): Promise<AuthorizeParams & { clientName: string }> {
  const q = url.searchParams;
  const clientId = q.get("client_id") ?? "";
  const client = await repo.getOAuthClient(clientId);
  if (!client) throw new StudioError("validation", "unknown client_id");
  const redirectUri = q.get("redirect_uri") ?? client.redirectUris[0] ?? "";
  if (!client.redirectUris.includes(redirectUri)) throw new StudioError("validation", "redirect_uri not registered for this client");
  if ((q.get("response_type") ?? "code") !== "code") throw new StudioError("validation", "response_type must be code");
  if ((q.get("code_challenge_method") ?? "S256") !== "S256") throw new StudioError("validation", "only S256 PKCE is supported");
  const codeChallenge = q.get("code_challenge") ?? "";
  if (!codeChallenge) throw new StudioError("validation", "code_challenge required");
  return { clientId, clientName: client.clientName, redirectUri, codeChallenge, state: q.get("state") ?? "", scope: q.get("scope") ?? "studio" };
}

export async function issueCode(params: AuthorizeParams, user: string): Promise<string> {
  const code = randomToken(24);
  await repo.saveOAuthCode({ code, clientId: params.clientId, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge, scope: params.scope, user, expiresAt: Date.now() + CODE_TTL_MS });
  const url = new URL(params.redirectUri);
  url.searchParams.set("code", code);
  if (params.state) url.searchParams.set("state", params.state);
  return url.toString();
}

export async function exchangeToken(form: URLSearchParams): Promise<Record<string, unknown>> {
  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const row = await repo.consumeOAuthCode(code);
    if (!row) throw oauthError("invalid_grant", "unknown or used code");
    if (row.expiresAt < Date.now()) throw oauthError("invalid_grant", "code expired");
    const clientId = form.get("client_id") ?? row.clientId;
    if (clientId !== row.clientId) throw oauthError("invalid_grant", "client mismatch");
    const redirect = form.get("redirect_uri");
    if (redirect && redirect !== row.redirectUri) throw oauthError("invalid_grant", "redirect_uri mismatch");
    if (!verifier || (await pkceChallenge(verifier)) !== row.codeChallenge) throw oauthError("invalid_grant", "PKCE verification failed");
    return mintTokens(row.clientId, row.user, row.scope);
  }
  if (grant === "refresh_token") {
    const refresh = form.get("refresh_token") ?? "";
    const hash = await sha256Hex(refresh);
    const row = await repo.getOAuthToken(hash);
    if (!row || row.kind !== "refresh" || row.expiresAt < Date.now()) throw oauthError("invalid_grant", "refresh token invalid");
    await repo.deleteOAuthToken(hash);
    return mintTokens(row.clientId, row.user, row.scope);
  }
  throw oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
}

async function mintTokens(clientId: string, user: string, scope: string) {
  const access = randomToken(32);
  const refresh = randomToken(32);
  await repo.saveOAuthToken({ tokenHash: await sha256Hex(access), kind: "access", clientId, user, scope, expiresAt: Date.now() + ACCESS_TTL_MS });
  await repo.saveOAuthToken({ tokenHash: await sha256Hex(refresh), kind: "refresh", clientId, user, scope, expiresAt: Date.now() + REFRESH_TTL_MS });
  return { access_token: access, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope };
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export class OAuthError extends Error {
  constructor(readonly code: string, description: string) {
    super(description);
  }
  toJSON() {
    return { error: this.code, error_description: this.message };
  }
}

function oauthError(code: string, description: string): OAuthError {
  return new OAuthError(code, description);
}
