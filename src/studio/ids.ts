const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Short, sortable-enough ids with a type prefix: prj_, sht_, tke_ … */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}
