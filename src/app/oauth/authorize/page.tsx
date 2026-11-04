import { headers } from "next/headers";

import { authenticateWeb } from "@/auth/access";
import { parseAuthorize } from "@/oauth/server";
import { StudioError } from "@/studio/errors";

import "@/openhiggsfield/openhiggsfield.css";
import "@/studio-ui/studio.css";

/* The OAuth consent page: the only place an agent's connector gets a token,
   and it needs a signed-in web user. Behind Cloudflare Access in production. */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const h = await headers();
  const actor = await authenticateWeb(new Request("http://local/oauth/authorize", { headers: h }));
  const url = new URL("http://local/oauth/authorize");
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") url.searchParams.set(k, v);
  let params: Awaited<ReturnType<typeof parseAuthorize>> | null = null;
  let problem: string | null = null;
  try {
    params = await parseAuthorize(url);
  } catch (caught) {
    problem = caught instanceof StudioError ? caught.message : "invalid authorization request";
  }
  return (
    <main className="ohf" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <form method="post" action="/api/oauth/authorize" className="ohf-consent">
        <h1 className="ohf-consent-title">Connect to Cinema Studio</h1>
        {problem ? (
          <p className="ohf-consent-problem">{problem}</p>
        ) : !actor ? (
          <p className="ohf-consent-problem">Sign in to the studio first, then retry the connection from your chat client.</p>
        ) : (
          <>
            <p className="ohf-consent-copy">
              <strong>{params!.clientName}</strong> wants to act as the director on your projects: write scripts, build shotlists, and request renders. Every paid action still asks for confirmation.
            </p>
            <p className="ohf-consent-meta">Signed in as {actor.user}</p>
            {Object.entries(sp).map(([k, v]) => (typeof v === "string" ? <input key={k} type="hidden" name={k} value={v} /> : null))}
            <div className="ohf-consent-actions">
              <button type="submit" name="decision" value="deny" className="ohf-btn ohf-btn--quiet">Cancel</button>
              <button type="submit" name="decision" value="allow" className="ohf-btn ohf-btn--primary">Allow</button>
            </div>
          </>
        )}
      </form>
    </main>
  );
}
