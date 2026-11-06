/* Delegated approvals: the user may let the director pass the script and/or
   shotlist checkpoint. Granted on the web only. */
export default String.raw`
ALTER TABLE projects ADD COLUMN delegation_json TEXT;
`;
