import { importPKCS8, SignJWT } from "jose";
import { PublicError, type Env } from "./env";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DIRECTORY = "https://admin.googleapis.com/admin/directory/v1";
const CLOUD_IDENTITY = "https://cloudidentity.googleapis.com/v1";

const DIRECTORY_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
];
// Requested in a separate token: if it is not (yet) authorized in
// domain-wide delegation, only the unmanaged-account check is skipped.
const CLOUD_IDENTITY_SCOPES = ["https://www.googleapis.com/auth/cloud-identity.userinvitations.readonly"];

/**
 * How an address Google refused to describe is held outside this Workspace:
 * - "unmanaged": a personal Google account on one of our verified domains
 *   (Cloud Identity says it can be invited to Workspace);
 * - "other": not invitable, e.g. owned by another organization;
 * - "unknown": the Cloud Identity check is unavailable (see the trace).
 */
export type OutsideTenantKind = "unmanaged" | "other" | "unknown";

export type GoogleResult =
  | { found: false }
  /**
   * Google returned 403 for the address although the directory is otherwise
   * readable: a Google account outside this Workspace uses it. Such an
   * account does not receive this domain's mail.
   */
  | { found: false; outsideTenant: true; accountType: OutsideTenantKind }
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

/** One Google API call made during a lookup, for logs and the "Why?" view. */
export interface TraceStep {
  step: string;
  /** HTTP status, or "failed" when the request itself threw. */
  status: number | "failed";
  ms: number;
  /** Google's error envelope (`error` object) or a short note. No secrets. */
  error?: unknown;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Test hook: forget cached access tokens. */
export function resetGoogleTokenCache(): void {
  tokenCache.clear();
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

async function accessToken(env: Env, scopes: string[], label: string, trace: TraceStep[]): Promise<string> {
  const { sa, subject } = parseKey(env);
  const scope = scopes.join(" ");
  const cacheKey = `${sa.client_email}|${subject}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const privateKey = await importPKCS8(sa.private_key, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) })
    .setIssuer(sa.client_email)
    .setSubject(subject)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const started = Date.now();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    // The OAuth error (e.g. "unauthorized_client" when a scope is missing
    // from domain-wide delegation) helps with setup and contains no secrets.
    trace.push({
      step: `${label}.token`,
      status: res.status,
      ms: Date.now() - started,
      error: { error: body.error, error_description: body.error_description },
    });
    throw new PublicError(
      `Google token exchange failed (HTTP ${res.status}${body.error ? `: ${body.error}` : ""})`,
    );
  }

  const ttl = typeof body.expires_in === "number" ? body.expires_in : 3600;
  // Refresh 5 minutes early.
  tokenCache.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + Math.max(0, ttl - 300) * 1000 });
  return body.access_token;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

interface GoogleError {
  /** e.g. "forbidden - Not Authorized to access this resource/api" */
  summary: string;
  /** The `error` object from Google's response, or a body excerpt. */
  raw: unknown;
}

/**
 * Google's error envelope says what failed (e.g. reason "forbidden", or
 * SERVICE_DISABLED when an API is off). It holds no secrets.
 */
async function readGoogleError(res: Response): Promise<GoogleError> {
  const text = await res.text().catch(() => "");
  try {
    const e = (JSON.parse(text) as { error?: Record<string, unknown> }).error;
    if (!e || typeof e !== "object") return { summary: "", raw: text.slice(0, 500) || undefined };
    const details = e.details as Array<{ reason?: unknown }> | undefined;
    const errors = e.errors as Array<{ reason?: unknown }> | undefined;
    const reason = [details?.[0]?.reason, errors?.[0]?.reason, e.status].find(
      (r): r is string => typeof r === "string" && r.length > 0,
    );
    const message = typeof e.message === "string" ? e.message.slice(0, 300) : "";
    return { summary: [reason, message].filter(Boolean).join(" - "), raw: e };
  } catch {
    return { summary: "", raw: text.slice(0, 500) || undefined };
  }
}

type ApiResponse =
  | { status: "ok"; body: Record<string, unknown> }
  | { status: "missing" }
  | { status: "forbidden"; error: PublicError };

const apiError = (api: string, status: number, summary: string) =>
  new PublicError(`${api} returned HTTP ${status}${summary ? `: ${summary}` : ""}`);

/** Traced GET. 404 and 403 are returned; other failures throw. */
async function apiGet(step: string, api: string, url: string, token: string, trace: TraceStep[]): Promise<ApiResponse> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  } catch (err) {
    trace.push({ step, status: "failed", ms: Date.now() - started, error: (err as Error).message });
    throw err;
  }
  if (res.ok) {
    trace.push({ step, status: res.status, ms: Date.now() - started });
    return { status: "ok", body: (await res.json()) as Record<string, unknown> };
  }
  const e = await readGoogleError(res);
  trace.push({ step, status: res.status, ms: Date.now() - started, error: e.raw });
  if (res.status === 404) return { status: "missing" };
  if (res.status === 403) return { status: "forbidden", error: apiError(api, 403, e.summary) };
  throw apiError(api, res.status, e.summary);
}

const directoryGet = (step: string, path: string, token: string, trace: TraceStep[]) =>
  apiGet(step, "Google Directory API", `${DIRECTORY}${path}`, token, trace);

/**
 * Reads the delegated admin's own record. A setup problem (missing role,
 * wrong subject, scopes) makes every Directory call 403, including this one;
 * an address held outside the tenant does not. Returns the customer ID, or
 * null when the directory is not readable.
 */
async function selfCheck(env: Env, token: string, trace: TraceStep[]): Promise<string | null> {
  const subject = encodeURIComponent(env.GOOGLE_ADMIN_SUBJECT?.trim() ?? "");
  const res = await directoryGet("self-check", `/users/${subject}?fields=primaryEmail,customerId`, token, trace);
  if (res.status !== "ok") return null;
  return typeof res.body.customerId === "string" ? res.body.customerId : "";
}

/**
 * Asks Cloud Identity whether `email` is an unmanaged personal account that
 * could be invited to Workspace. Returns null when the check is unavailable
 * (scope not delegated, API disabled, ...); the reason is in the trace.
 */
async function isInvitableUser(
  email: string,
  customerId: string,
  env: Env,
  trace: TraceStep[],
): Promise<boolean | null> {
  if (!customerId) {
    trace.push({ step: "cloudidentity.isInvitableUser", status: "failed", ms: 0, error: "customer ID unavailable" });
    return null;
  }
  try {
    const token = await accessToken(env, CLOUD_IDENTITY_SCOPES, "cloudidentity", trace);
    const url =
      `${CLOUD_IDENTITY}/customers/${encodeURIComponent(customerId)}` +
      `/userinvitations/${encodeURIComponent(email)}:isInvitableUser`;
    const res = await apiGet("cloudidentity.isInvitableUser", "Cloud Identity API", url, token, trace);
    return res.status === "ok" ? res.body.isInvitableUser === true : null;
  } catch {
    return null;
  }
}

/**
 * Looks up `email` as a Workspace user, user alias, group, or group alias.
 * users.get and groups.get both resolve aliases to the owning object. Every
 * Google call is recorded in `trace`.
 */
export async function lookupGoogle(email: string, env: Env, trace: TraceStep[] = []): Promise<GoogleResult> {
  const token = await accessToken(env, DIRECTORY_SCOPES, "directory", trace);
  const key = encodeURIComponent(email);
  const target = email.toLowerCase();

  const user = await directoryGet(
    "users.get",
    `/users/${key}?projection=basic&viewType=admin_view` +
      "&fields=primaryEmail,name/fullName,suspended,archived,aliases,nonEditableAliases",
    token,
    trace,
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
    "groups.get",
    `/groups/${key}?fields=email,name,description,directMembersCount,aliases,nonEditableAliases`,
    token,
    trace,
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

  // Neither a user nor a group here. A 403 (rather than 404) from either
  // lookup means Google knows the address but it belongs outside this
  // customer, unless the directory is not readable at all (a setup error).
  const forbidden = user.status === "forbidden" ? user : group.status === "forbidden" ? group : null;
  if (forbidden) {
    const customerId = await selfCheck(env, token, trace);
    if (customerId === null) throw forbidden.error;
    const invitable = await isInvitableUser(email, customerId, env, trace);
    const accountType: OutsideTenantKind = invitable === null ? "unknown" : invitable ? "unmanaged" : "other";
    return { found: false, outsideTenant: true, accountType };
  }

  return { found: false };
}
