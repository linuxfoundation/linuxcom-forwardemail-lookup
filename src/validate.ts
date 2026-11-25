// Conservative local-part rule: letters, digits and . _ + - only; must start
// and end with a letter or digit; no consecutive dots; at most 64 chars.
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

/**
 * Normalizes user input to a bare local part ("Foo@Linux.com " -> "foo").
 * Returns null when the input is not an acceptable address on `domain`.
 */
export function normalizeLocalPart(input: string, domain: string): string | null {
  let s = input.trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at !== -1) {
    if (s.slice(at + 1) !== domain.toLowerCase()) return null;
    s = s.slice(0, at);
  }
  if (!LOCAL_PART.test(s) || s.includes("..")) return null;
  return s;
}
