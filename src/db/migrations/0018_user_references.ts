/* 我的: pictures a user uploaded into the Canvas reference library — a portrait, a costume or a pose — seen in
   every project of theirs. A portrait keeps its face check (meta.faceCheck: 模拟 / 真实); a pose says what its
   picture is (picture: photo / mannequin / depth). The Studio also creates the table on first use, so a deploy
   works before this file has been applied. */
export default String.raw`
CREATE TABLE IF NOT EXISTS user_references (id TEXT PRIMARY KEY, user TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]', url TEXT NOT NULL, key TEXT NOT NULL, width INTEGER, height INTEGER, picture TEXT, meta_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS user_references_user ON user_references (user, created_at);
`;
