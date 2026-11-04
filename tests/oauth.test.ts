import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { authenticateBearer } from "@/auth/access";
import { exchangeToken, issueCode, parseAuthorize, pkceChallenge, registerClient } from "@/oauth/server";

async function memoryDb(): Promise<Db> {
  const { default: Database } = await import("better-sqlite3");
  const sqlite = new Database(":memory:");
  const db: Db = {
    async all<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).all(...(params as never[])) as T[]; },
    async get<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).get(...(params as never[])) as T | undefined; },
    async run(sql: string, params: unknown[] = []) { return { changes: Number(sqlite.prepare(sql).run(...(params as never[])).changes) }; },
    async exec(sql: string) { sqlite.exec(sql); },
  };
  await migrate(db);
  return db;
}

beforeAll(async () => {
  setDb(await memoryDb());
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  process.env.AUTH_MODE = "dev";
});

describe("oauth 2.1 for MCP connectors", () => {
  it("registers a client, issues a code and exchanges it with PKCE", async () => {
    const reg = await registerClient({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    expect(reg.client_id).toMatch(/^cli_/);

    const verifier = "a".repeat(48);
    const challenge = await pkceChallenge(verifier);
    const url = new URL(`https://studio.example/oauth/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`);
    const params = await parseAuthorize(url);
    expect(params.clientName).toBe("Claude");

    const redirect = new URL(await issueCode(params, "you@example.com"));
    expect(redirect.origin + redirect.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(redirect.searchParams.get("state")).toBe("xyz");
    const code = redirect.searchParams.get("code")!;

    await expect(exchangeToken(new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "wrong", client_id: reg.client_id }))).rejects.toMatchObject({ code: "invalid_grant" });
    /* the code is single use: the failed attempt consumed it */
    await expect(exchangeToken(new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id }))).rejects.toMatchObject({ code: "invalid_grant" });

    const redirect2 = new URL(await issueCode(params, "you@example.com"));
    const tokens = await exchangeToken(new URLSearchParams({ grant_type: "authorization_code", code: redirect2.searchParams.get("code")!, code_verifier: verifier, client_id: reg.client_id }));
    expect(tokens.token_type).toBe("Bearer");

    const actor = await authenticateBearer(new Request("https://studio.example/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } }));
    expect(actor).toEqual({ user: "you@example.com", via: "mcp" });

    const refreshed = await exchangeToken(new URLSearchParams({ grant_type: "refresh_token", refresh_token: String(tokens.refresh_token) }));
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    await expect(exchangeToken(new URLSearchParams({ grant_type: "refresh_token", refresh_token: String(tokens.refresh_token) }))).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects unregistered redirect uris and non-https ones", async () => {
    await expect(registerClient({ redirect_uris: ["http://evil.example/cb"] })).rejects.toMatchObject({ code: "validation" });
    const reg = await registerClient({ client_name: "Grok", redirect_uris: ["https://grok.com/cb"] });
    const url = new URL(`https://studio.example/oauth/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent("https://other.example/cb")}&code_challenge=abc`);
    await expect(parseAuthorize(url)).rejects.toMatchObject({ code: "validation" });
  });

  it("static token authenticates as the mcp actor", async () => {
    process.env.MCP_STATIC_TOKEN = "fixed-token";
    const actor = await authenticateBearer(new Request("https://studio.example/mcp", { headers: { authorization: "Bearer fixed-token" } }));
    expect(actor?.via).toBe("mcp");
    expect(await authenticateBearer(new Request("https://studio.example/mcp", { headers: { authorization: "Bearer nope" } }))).toBeNull();
  });
});
