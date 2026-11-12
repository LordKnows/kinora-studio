/* The sound design table, one row a scene: ambience bed, the main foley, the
   state of the music. Written with the shotlist, read by the compiler (a
   shot with no ambience of its own takes the scene's) and checked against the
   timeline at export. The Studio also adds the column on first use, so a
   deploy works before this file has been applied on D1; a second ALTER
   answers "duplicate column". */
export default String.raw`
ALTER TABLE scenes ADD COLUMN sound_json TEXT;
`;
