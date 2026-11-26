import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./env";

export interface Identity {
  email: string;
}

export class AuthError extends Error {}

const jwksByIssuer = new Map<string, JWTVerifyGetKey>();

/**
 * Normalizes ACCESS_TEAM_DOMAIN ("team.cloudflareaccess.com", optionally
 * with a scheme or trailing slashes) to the issuer URL. Plain string
 * operations rather than regexes, so the work is linear in the input
 * (CodeQL js/polynomial-redos flagged `/\/+$/`).
 */
export function teamIssuer(teamDomain: string): string {
  let host = teamDomain.trim();
  for (const scheme of ["https://", "http://"]) {
    if (host.slice(0, scheme.length).toLowerCase() === scheme) {
      host = host.slice(scheme.length);
      break;
    }
  }
  let end = host.length;
  while (end > 0 && host[end - 1] === "/") end--;
  return `https://${host.slice(0, end)}`;
}

function cookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Verifies the Cloudflare Access JWT on the request and returns the caller.
 * Access already blocks unauthenticated traffic at the edge; this is defense
 * in depth so the Worker never trusts a request Access did not sign.
 */
export async function requireAccess(req: Request, env: Env): Promise<Identity> {
  const { hostname } = new URL(req.url);
  if (env.DEV_BYPASS_ACCESS === "1" && (hostname === "localhost" || hostname === "127.0.0.1")) {
    return { email: "dev@localhost" };
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new AuthError("Cloudflare Access is not configured");
  }

  const token = req.headers.get("cf-access-jwt-assertion") ?? cookie(req, "CF_Authorization");
  if (!token) throw new AuthError("missing Access token");

  const issuer = teamIssuer(env.ACCESS_TEAM_DOMAIN);
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
    }));
  } catch (err) {
    throw new AuthError(`invalid Access token: ${(err as Error).message}`);
  }

  const email = typeof payload.email === "string" && payload.email ? payload.email : null;
  if (email) return { email };

  // Access service tokens (headless agents) carry the token's client ID in
  // `common_name` and no email. Accept only the client IDs explicitly listed
  // in ACCESS_SERVICE_TOKEN_IDS; the identity is logged as "service:<id>".
  const clientId = typeof payload.common_name === "string" ? payload.common_name : "";
  const allowed = (env.ACCESS_SERVICE_TOKEN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (clientId && allowed.includes(clientId)) return { email: `service:${clientId}` };
  throw new AuthError(clientId ? "Access service token is not on the allowlist" : "Access token has no email claim");
}
