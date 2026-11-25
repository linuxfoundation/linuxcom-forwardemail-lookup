import { importPKCS8, SignJWT } from "jose";
import { PublicError, type Env } from "./env";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DIRECTORY = "https://admin.googleapis.com/admin/directory/v1";
const SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
];

export type GoogleResult =
  | { found: false }
  | {
      found: true;
      kind: "user" | "user-alias";
      primaryEmail: string;
      fullName: string | null;
      suspended: boolean;
      archived: boolean;
      aliases: string[];
    }
  | {
      found: true;
      kind: "group" | "group-alias";
      email: string;
      name: string | null;
      description: string | null;
      directMembersCount: number | null;
      aliases: string[];
    };

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

let cachedToken: { cacheKey: string; token: string; expiresAt: number } | null = null;

/** Test hook: forget the cached access token. */
export function resetGoogleTokenCache(): void {
  cachedToken = null;
}

function parseKey(env: Env): { sa: ServiceAccountKey; subject: string } {
  const subject = env.GOOGLE_ADMIN_SUBJECT?.trim();
  if (!env.GOOGLE_SA_KEY_JSON || !subject) {
    throw new PublicError("Google Workspace lookup is not configured");
  }
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(env.GOOGLE_SA_KEY_JSON);
  } catch {
    throw new PublicError("GOOGLE_SA_KEY_JSON is not valid JSON");
  }
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new PublicError("GOOGLE_SA_KEY_JSON is missing client_email or private_key");
  }
  return { sa: key as ServiceAccountKey, subject };
}

async function accessToken(env: Env): Promise<string> {
  const { sa, subject } = parseKey(env);
  const cacheKey = `${sa.client_email}|${subject}`;
  if (cachedToken && cachedToken.cacheKey === cacheKey && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const privateKey = await importPKCS8(sa.private_key, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: SCOPES.join(" ") })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) })
    .setIssuer(sa.client_email)
    .setSubject(subject)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    // The OAuth error code (e.g. "unauthorized_client" when domain-wide
    // delegation is missing) helps with setup and contains no secrets.
    throw new PublicError(
      `Google token exchange failed (HTTP ${res.status}${body.error ? `: ${body.error}` : ""})`,
    );
  }

  const ttl = typeof body.expires_in === "number" ? body.expires_in : 3600;
  cachedToken = {
    cacheKey,
    token: body.access_token,
    // Refresh 5 minutes early.
    expiresAt: Date.now() + Math.max(0, ttl - 300) * 1000,
  };
  return body.access_token;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Google's error envelope says why a call failed (e.g. reason "forbidden"
 * with "Not Authorized to access this resource/api", or SERVICE_DISABLED
 * when the Admin SDK API is off). It holds no secrets, so it is shown as-is.
 */
async function googleErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: {
        message?: unknown;
        status?: unknown;
        errors?: Array<{ reason?: unknown }>;
        details?: Array<{ reason?: unknown }>;
      };
    };
    const e = body.error;
    if (!e) return "";
    const reason = [e.details?.[0]?.reason, e.errors?.[0]?.reason, e.status].find(
      (r): r is string => typeof r === "string" && r.length > 0,
    );
    const message = typeof e.message === "string" ? e.message.slice(0, 300) : "";
    return [reason, message].filter(Boolean).join(" - ");
  } catch {
    return "";
  }
}

async function directoryGet(path: string, token: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${DIRECTORY}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await googleErrorDetail(res);
    throw new PublicError(`Google Directory API returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Looks up `email` as a Workspace user, user alias, group, or group alias.
 * users.get and groups.get both resolve aliases to the owning object.
 */
export async function lookupGoogle(email: string, env: Env): Promise<GoogleResult> {
  const token = await accessToken(env);
  const key = encodeURIComponent(email);
  const target = email.toLowerCase();

  const user = await directoryGet(
    `/users/${key}?projection=basic&viewType=admin_view` +
      "&fields=primaryEmail,name/fullName,suspended,archived,aliases,nonEditableAliases",
    token,
  );
  if (user) {
    const primaryEmail = String(user.primaryEmail ?? "");
    const name = user.name as { fullName?: unknown } | undefined;
    return {
      found: true,
      kind: primaryEmail.toLowerCase() === target ? "user" : "user-alias",
      primaryEmail,
      fullName: typeof name?.fullName === "string" ? name.fullName : null,
      suspended: user.suspended === true,
      archived: user.archived === true,
      aliases: [...strings(user.aliases), ...strings(user.nonEditableAliases)],
    };
  }

  const group = await directoryGet(
    `/groups/${key}?fields=email,name,description,directMembersCount,aliases,nonEditableAliases`,
    token,
  );
  if (group) {
    const groupEmail = String(group.email ?? "");
    const count = Number(group.directMembersCount);
    return {
      found: true,
      kind: groupEmail.toLowerCase() === target ? "group" : "group-alias",
      email: groupEmail,
      name: typeof group.name === "string" ? group.name : null,
      description: typeof group.description === "string" && group.description ? group.description : null,
      directMembersCount: Number.isFinite(count) ? count : null,
      aliases: [...strings(group.aliases), ...strings(group.nonEditableAliases)],
    };
  }

  return { found: false };
}
