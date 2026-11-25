import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./env";

export interface Identity {
  email: string;
}

export class AuthError extends Error {}

const jwksByIssuer = new Map<string, JWTVerifyGetKey>();

function teamIssuer(teamDomain: string): string {
  const host = teamDomain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}`;
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

  const email = typeof payload.email === "string" ? payload.email : null;
  if (!email) throw new AuthError("Access token has no email claim");
  return { email };
}
