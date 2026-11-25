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
  /**
   * Google refused to describe the address although the directory is
   * otherwise readable: a Google account outside this Workspace (an
   * unmanaged personal or conflicting account) uses it. Such an account does
   * not receive this domain's mail.
   */
  | { found: false; outsideTenant: true }
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

type DirectoryResponse =
  | { status: "ok"; body: Record<string, unknown> }
  | { status: "missing" }
  | { status: "forbidden"; error: PublicError };

const directoryError = (status: number, detail: string) =>
  new PublicError(`Google Directory API returned HTTP ${status}${detail ? `: ${detail}` : ""}`);

/** GET a Directory resource. 404 and 403 are returned; other failures throw. */
async function directoryGet(path: string, token: string): Promise<DirectoryResponse> {
  const res = await fetch(`${DIRECTORY}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (res.status === 404) return { status: "missing" };
  if (res.status === 403) {
    return { status: "forbidden", error: directoryError(403, await googleErrorDetail(res)) };
  }
  if (!res.ok) throw directoryError(res.status, await googleErrorDetail(res));
  return { status: "ok", body: (await res.json()) as Record<string, unknown> };
}

/**
 * True when the delegated admin can read its own user record. A setup
 * problem (missing role, wrong subject, scopes) makes every Directory call
 * 403, including this one; an address owned outside the tenant does not.
 */
async function directoryReadable(env: Env, token: string): Promise<boolean> {
  const subject = encodeURIComponent(env.GOOGLE_ADMIN_SUBJECT?.trim() ?? "");
  const res = await directoryGet(`/users/${subject}?fields=primaryEmail`, token);
  return res.status === "ok";
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
  if (user.status === "ok") {
    const u = user.body;
    const primaryEmail = String(u.primaryEmail ?? "");
    const name = u.name as { fullName?: unknown } | undefined;
    return {
      found: true,
      kind: primaryEmail.toLowerCase() === target ? "user" : "user-alias",
      primaryEmail,
      fullName: typeof name?.fullName === "string" ? name.fullName : null,
      suspended: u.suspended === true,
      archived: u.archived === true,
      aliases: [...strings(u.aliases), ...strings(u.nonEditableAliases)],
    };
  }

  const group = await directoryGet(
    `/groups/${key}?fields=email,name,description,directMembersCount,aliases,nonEditableAliases`,
    token,
  );
  if (group.status === "ok") {
    const g = group.body;
    const groupEmail = String(g.email ?? "");
    const count = Number(g.directMembersCount);
    return {
      found: true,
      kind: groupEmail.toLowerCase() === target ? "group" : "group-alias",
      email: groupEmail,
      name: typeof g.name === "string" ? g.name : null,
      description: typeof g.description === "string" && g.description ? g.description : null,
      directMembersCount: Number.isFinite(count) ? count : null,
      aliases: [...strings(g.aliases), ...strings(g.nonEditableAliases)],
    };
  }

  // Neither a user nor a group here. A 403 (rather than 404) for the user
  // means Google knows the address but it belongs to another customer, unless
  // the directory is not readable at all, which is a setup error.
  if (user.status === "forbidden") {
    if (await directoryReadable(env, token)) return { found: false, outsideTenant: true };
    throw user.error;
  }

  return { found: false };
}
