// A tiny scheduled Worker: Cloudflare Cron Triggers call `scheduled`, not a
// URL, so this one fetches the studio's sweep endpoint every minute (§4.3).
export default {
  async scheduled(_event, env) {
    const res = await fetch(`${env.STUDIO_PUBLIC_URL}/api/cron/sweep`, {
      method: "POST",
      headers: { "x-cron-secret": env.CRON_SECRET },
    });
    if (!res.ok) throw new Error(`sweep failed: ${res.status} ${await res.text()}`);
  },
};
