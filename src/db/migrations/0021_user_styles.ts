/* Styles of the users' own: a library style changed, or one written from a blank page on a library style's
   technique. Seen by every project (a project's Look names its style by slug), changed only by whoever made it.
   style_json is the whole preset; changes_json lists what differs from the base, each with its group (safe,
   character, essence) and the reason. The Studio also creates the table on first use, so a deploy works
   before this file has been applied. */
export default String.raw`
CREATE TABLE IF NOT EXISTS user_styles (slug TEXT PRIMARY KEY, user TEXT NOT NULL, based_on TEXT, style_json TEXT NOT NULL, changes_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS user_styles_user ON user_styles (user, updated_at);
`;
