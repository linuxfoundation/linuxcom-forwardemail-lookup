import { exportJWK, exportPKCS8, generateKeyPair, SignJWT, type JWK } from "jose";
import { vi } from "vitest";
import type { Env } from "../src/env";

export const TEAM = "testteam.cloudflareaccess.com";
export const AUD = "test-aud-tag";

type Handler = (req: Request) => Response | Promise<Response>;

/** Routes stubbed global fetch calls by URL prefix; unmatched calls fail the test. */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: Request[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input instanceof URL ? input.toString() : input, init);
    calls.push(req);
    const match = Object.keys(routes)
      .filter((prefix) => req.url.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (!match) throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
    return routes[match]!(req);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

export const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface Keys {
  accessJwks: { keys: JWK[] };
  signAccess: (claims: Record<string, unknown>, opts?: { aud?: string; iss?: string }) => Promise<string>;
  signWithOtherKey: (claims: Record<string, unknown>) => Promise<string>;
  saKeyJson: string;
}

export async function makeKeys(): Promise<Keys> {
  const access = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256", { extractable: true });
  const sa = await generateKeyPair("RS256", { extractable: true });

  const jwk = { ...(await exportJWK(access.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

  const sign = (key: CryptoKey, claims: Record<string, unknown>, aud = AUD, iss = `https://${TEAM}`) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);

  return {
    accessJwks: { keys: [jwk] },
    signAccess: (claims, opts) => sign(access.privateKey, claims, opts?.aud, opts?.iss),
    signWithOtherKey: (claims) => sign(other.privateKey, claims),
    saKeyJson: JSON.stringify({
      type: "service_account",
      client_email: "lookup@test-project.iam.gserviceaccount.com",
      private_key_id: "sa-key-1",
      private_key: await exportPKCS8(sa.privateKey),
    }),
  };
}

export function makeEnv(keys: Keys, overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    FE_DOMAIN: "linux.com",
    GOOGLE_LOOKUP_DOMAIN: "linux.com",
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    GOOGLE_ADMIN_SUBJECT: "readonly-admin@example.org",
    FORWARDEMAIL_API_TOKEN: "fe-test-token",
    GOOGLE_SA_KEY_JSON: keys.saKeyJson,
    ...overrides,
  };
}
