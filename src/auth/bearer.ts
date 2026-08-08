// Bearer-token extraction from an Authorization header. Pure parsing — no verification; pair
// with makeVerifyToken (see auth/jwks) to turn the extracted token into a Principal.

/** Returns the token from an "Authorization: Bearer <token>" header — scheme match is
 * case-insensitive and surrounding whitespace is trimmed — or null if the header is missing,
 * empty, or uses a different scheme. */
export function bearerFromHeader(authorization?: string | null): string | null {
  if (!authorization) return null;
  const m = /^(\S+)\s+(\S.*)$/.exec(authorization.trim());
  if (!m) return null;
  if (m[1]!.toLowerCase() !== "bearer") return null;
  return m[2]!.trim();
}
