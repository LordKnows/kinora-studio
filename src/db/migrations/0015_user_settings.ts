/* Per-user preferences, keyed by the signed-in email (Cloudflare Access) or
   the user an OAuth token was issued to. First use: whether this user has
   confirmed being an adult and shows 18+ references on the Canvas page.
   The Studio also creates the table on first use, so a deploy works before
   this file has been applied. */
export default String.raw`
CREATE TABLE IF NOT EXISTS user_settings (user TEXT PRIMARY KEY, settings_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
`;
