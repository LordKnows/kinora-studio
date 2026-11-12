/* Private projects. A project belongs to the user who created it (owner: the
   Cloudflare Access email, the same one an OAuth token carries) and is
   'shared' (every signed-in user sees it, as before) or 'private' (only its
   owner, on the web and through the director's connector). Rows from before
   have no owner and stay shared. The Studio also adds these columns on first
   use, so a deploy works before this file has been applied on D1; a second
   ALTER answers "duplicate column". One statement a line: D1's exec splits
   on newlines. */
export default String.raw`
ALTER TABLE projects ADD COLUMN owner TEXT;
ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';
CREATE INDEX IF NOT EXISTS projects_visibility ON projects(visibility, owner);
`;
