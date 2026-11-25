import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetGoogleTokenCache } from "../src/google";
import { normalizeLocalPart } from "../src/validate";
import type { Env } from "../src/env";
import { AUD, TEAM, jsonRes, makeEnv, makeKeys, mockFetch, type Keys } from "./helpers";

const FE = "https://api.forwardemail.net/v1/domains/linux.com/aliases/";
const TOKEN = "https://oauth2.googleapis.com/token";
const USERS = "https://admin.googleapis.com/admin/directory/v1/users/";
const GROUPS = "https://admin.googleapis.com/admin/directory/v1/groups/";
const CERTS = `https://${TEAM}/cdn-cgi/access/certs`;

let keys: Keys;
let env: Env;
let jwt: string;

beforeAll(async () => {
  keys = await makeKeys();
});

beforeEach(async () => {
  env = makeEnv(keys);
  jwt = await keys.signAccess({ email: "staff@linuxfoundation.org" });
  resetGoogleTokenCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const call = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://lookup.example.org${path}`, { headers, ...init }), env);

const authed = (path: string) => call(path, { "cf-access-jwt-assertion": jwt });

/** Default upstreams: everything not found. */
function upstreams(overrides: Record<string, (req: Request) => Response | Promise<Response>> = {}) {
  return mockFetch({
    [CERTS]: () => jsonRes(keys.accessJwks),
    [TOKEN]: () => jsonRes({ access_token: "g-token", expires_in: 3600, token_type: "Bearer" }),
    [FE]: () => jsonRes({ message: "Alias does not exist" }, 404),
    [USERS]: () => jsonRes({ error: { code: 404 } }, 404),
    [GROUPS]: () => jsonRes({ error: { code: 404 } }, 404),
    ...overrides,
  });
}

describe("normalizeLocalPart", () => {
  it.each([
    ["jdoe", "jdoe"],
    ["  JDoe ", "jdoe"],
    ["jdoe@linux.com", "jdoe"],
    ["JDoe@Linux.COM", "jdoe"],
    ["first.last", "first.last"],
    ["a+tag", "a+tag"],
    ["x", "x"],
    ["a_b-c", "a_b-c"],
  ])("accepts %j", (input, expected) => {
    expect(normalizeLocalPart(input, "linux.com")).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "jdoe@example.com",
    "a@b@linux.com",
    ".jdoe",
    "jdoe.",
    "a..b",
    "has space",
    "../etc/passwd",
    "a/b",
    "a%2fb",
    "a?b",
    "*",
    "x".repeat(65),
  ])("rejects %j", (input) => {
    expect(normalizeLocalPart(input, "linux.com")).toBeNull();
  });
});

describe("Access gate", () => {
  it("rejects requests with no token", async () => {
    upstreams();
    const res = await call("/api/lookup?user=jdoe");
    expect(res.status).toBe(401);
  });

  it("rejects a token signed by another key", async () => {
    upstreams();
    const bad = await keys.signWithOtherKey({ email: "x@y.z" });
    const res = await call("/api/me", { "cf-access-jwt-assertion": bad });
    expect(res.status).toBe(401);
  });

  it("rejects a token for another audience", async () => {
    upstreams();
    const bad = await keys.signAccess({ email: "x@y.z" }, { aud: "other-app" });
    const res = await call("/api/me", { "cf-access-jwt-assertion": bad });
    expect(res.status).toBe(401);
  });

  it("rejects a token from another issuer", async () => {
    upstreams();
    const bad = await keys.signAccess({ email: "x@y.z" }, { iss: "https://evil.cloudflareaccess.com" });
    const res = await call("/api/me", { "cf-access-jwt-assertion": bad });
    expect(res.status).toBe(401);
  });

  it("fails closed when Access is not configured", async () => {
    upstreams();
    env = makeEnv(keys, { ACCESS_AUD: "" });
    const res = await authed("/api/me");
    expect(res.status).toBe(401);
  });

  it("accepts a valid header token", async () => {
    upstreams();
    const res = await authed("/api/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "staff@linuxfoundation.org", domain: "linux.com" });
  });

  it("accepts the CF_Authorization cookie", async () => {
    upstreams();
    const res = await call("/api/me", { cookie: `foo=bar; CF_Authorization=${jwt}` });
    expect(res.status).toBe(200);
  });

  it("only honors the dev bypass on localhost", async () => {
    upstreams();
    env = makeEnv(keys, { DEV_BYPASS_ACCESS: "1" });
    const remote = await call("/api/me");
    expect(remote.status).toBe(401);

    const local = await worker.fetch(new Request("http://localhost:8787/api/me"), env);
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({ email: "dev@localhost" });
  });

  it("rejects non-GET methods", async () => {
    upstreams();
    const res = await call("/api/lookup?user=jdoe", { "cf-access-jwt-assertion": jwt }, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("/api/lookup", () => {
  it("400s on invalid input without calling upstreams", async () => {
    const calls = upstreams();
    const res = await authed("/api/lookup?user=" + encodeURIComponent("../x"));
    expect(res.status).toBe(400);
    expect(calls.filter((r) => !r.url.startsWith(CERTS))).toHaveLength(0);
  });

  it("reports not found in both sources", async () => {
    upstreams();
    const res = await authed("/api/lookup?user=nobody");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      query: "nobody@linux.com",
      forwardemail: { found: false },
      google: { found: false },
      conflict: false,
    });
  });

  it("flags a conflict when the address exists in both sources", async () => {
    upstreams({
      [FE]: () => jsonRes({ name: "jdoe", is_enabled: true, recipients: ["x@example.com"] }),
      [USERS]: () => jsonRes({ primaryEmail: "jdoe@linux.com" }),
    });
    const body = (await (await authed("/api/lookup?user=jdoe")).json()) as Record<string, any>;
    expect(body.conflict).toBe(true);
  });

  it.each([
    ["only ForwardEmail", { name: "jdoe" }, null],
    ["only Google", null, { primaryEmail: "jdoe@linux.com" }],
  ])("does not flag a conflict when found in %s", async (_label, fe, user) => {
    upstreams({
      ...(fe ? { [FE]: () => jsonRes(fe) } : {}),
      ...(user ? { [USERS]: () => jsonRes(user) } : {}),
    });
    const body = (await (await authed("/api/lookup?user=jdoe")).json()) as Record<string, any>;
    expect(body.conflict).toBe(false);
  });

  it("does not flag a conflict when a source errored", async () => {
    upstreams({
      [FE]: () => jsonRes({ name: "jdoe" }),
      [USERS]: () => jsonRes({ error: { code: 403 } }, 403),
    });
    const body = (await (await authed("/api/lookup?user=jdoe")).json()) as Record<string, any>;
    expect(body.conflict).toBe(false);
  });

  it("returns ForwardEmail alias details and sends Basic auth", async () => {
    const calls = upstreams({
      [FE]: () =>
        jsonRes({
          id: "abc",
          name: "jdoe",
          is_enabled: true,
          recipients: ["jdoe@example.com", "backup@example.net"],
          labels: ["staff"],
          description: "John Doe",
          has_imap: false,
        }),
    });
    const res = await authed("/api/lookup?user=JDoe@linux.com");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.forwardemail).toEqual({
      found: true,
      name: "jdoe",
      enabled: true,
      recipients: ["jdoe@example.com", "backup@example.net"],
      labels: ["staff"],
      description: "John Doe",
      hasImap: false,
    });
    const feCall = calls.find((r) => r.url.startsWith(FE))!;
    expect(feCall.url).toBe(`${FE}jdoe`);
    expect(feCall.headers.get("authorization")).toBe(`Basic ${btoa("fe-test-token:")}`);
  });

  it("keeps Google results when ForwardEmail fails", async () => {
    upstreams({
      [FE]: () => jsonRes({ message: "boom" }, 502),
      [USERS]: () => jsonRes({ primaryEmail: "jdoe@linux.com", name: { fullName: "J Doe" } }),
    });
    const body = (await (await authed("/api/lookup?user=jdoe")).json()) as Record<string, any>;
    expect(body.forwardemail).toEqual({ error: "ForwardEmail API returned HTTP 502" });
    expect(body.google).toMatchObject({ found: true, kind: "user" });
  });

  it("reports missing configuration per source", async () => {
    upstreams();
    env = makeEnv(keys, { FORWARDEMAIL_API_TOKEN: "", GOOGLE_SA_KEY_JSON: "" });
    const body = (await (await authed("/api/lookup?user=jdoe")).json()) as Record<string, any>;
    expect(body.forwardemail.error).toMatch(/not configured/);
    expect(body.google.error).toMatch(/not configured/);
  });

  it("hides unexpected internal errors", async () => {
    upstreams({ [FE]: () => { throw new TypeError("socket hang up"); } });
    const body = (await (await authed("/api/lookup?user=jdoe")).json()) as Record<string, any>;
    expect(body.forwardemail).toEqual({ error: "Unexpected error" });
  });
});

describe("Google Workspace lookup", () => {
  it("signs a delegated JWT for the token exchange", async () => {
    let assertion = "";
    const calls = upstreams({
      [TOKEN]: async (req) => {
        assertion = new URLSearchParams(await req.text()).get("assertion") ?? "";
        return jsonRes({ access_token: "g-token", expires_in: 3600 });
      },
    });
    await authed("/api/lookup?user=jdoe");
    const [header, payload] = assertion.split(".").slice(0, 2).map((p) => JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/"))));
    expect(header).toMatchObject({ alg: "RS256", kid: "sa-key-1" });
    expect(payload).toMatchObject({
      iss: "lookup@test-project.iam.gserviceaccount.com",
      sub: "readonly-admin@example.org",
      aud: TOKEN,
      scope:
        "https://www.googleapis.com/auth/admin.directory.user.readonly https://www.googleapis.com/auth/admin.directory.group.readonly",
    });
    const userCall = calls.find((r) => r.url.startsWith(USERS))!;
    expect(userCall.headers.get("authorization")).toBe("Bearer g-token");
    expect(new URL(userCall.url).pathname).toBe("/admin/directory/v1/users/jdoe%40linux.com");
  });

  it("caches the access token across lookups", async () => {
    const calls = upstreams();
    await authed("/api/lookup?user=a");
    await authed("/api/lookup?user=b");
    expect(calls.filter((r) => r.url.startsWith(TOKEN))).toHaveLength(1);
  });

  it("identifies a primary user", async () => {
    upstreams({
      [USERS]: () =>
        jsonRes({
          primaryEmail: "jdoe@linux.com",
          name: { fullName: "Jane Doe" },
          suspended: false,
          archived: false,
          aliases: ["jane@linux.com"],
        }),
    });
    const body = (await (await authed("/api/lookup?user=jdoe")).json()) as Record<string, any>;
    expect(body.google).toEqual({
      found: true,
      kind: "user",
      primaryEmail: "jdoe@linux.com",
      fullName: "Jane Doe",
      suspended: false,
      archived: false,
      aliases: ["jane@linux.com"],
    });
  });

  it("identifies a user alias (incl. domain-alias addresses)", async () => {
    upstreams({
      [USERS]: () =>
        jsonRes({
          primaryEmail: "jdoe@linuxfoundation.org",
          name: { fullName: "Jane Doe" },
          suspended: true,
          nonEditableAliases: ["jdoe@linux.com"],
        }),
    });
    const body = (await (await authed("/api/lookup?user=jdoe")).json()) as Record<string, any>;
    expect(body.google).toMatchObject({
      kind: "user-alias",
      primaryEmail: "jdoe@linuxfoundation.org",
      suspended: true,
      aliases: ["jdoe@linux.com"],
    });
  });

  it("falls back to groups and identifies a group", async () => {
    upstreams({
      [GROUPS]: () => jsonRes({ email: "team@linux.com", name: "Team", directMembersCount: "12" }),
    });
    const body = (await (await authed("/api/lookup?user=team")).json()) as Record<string, any>;
    expect(body.google).toEqual({
      found: true,
      kind: "group",
      email: "team@linux.com",
      name: "Team",
      description: null,
      directMembersCount: 12,
      aliases: [],
    });
  });

  it("identifies a group alias", async () => {
    upstreams({
      [GROUPS]: () => jsonRes({ email: "team@linuxfoundation.org", name: "Team", aliases: ["t@linux.com"] }),
    });
    const body = (await (await authed("/api/lookup?user=t")).json()) as Record<string, any>;
    expect(body.google).toMatchObject({ kind: "group-alias", email: "team@linuxfoundation.org" });
  });

  it("surfaces token exchange errors", async () => {
    upstreams({ [TOKEN]: () => jsonRes({ error: "unauthorized_client" }, 401) });
    const body = (await (await authed("/api/lookup?user=jdoe")).json()) as Record<string, any>;
    expect(body.google).toEqual({ error: "Google token exchange failed (HTTP 401: unauthorized_client)" });
  });

  it("includes Google's reason for Directory API errors", async () => {
    upstreams({
      [USERS]: () =>
        jsonRes(
          {
            error: {
              code: 403,
              message: "Not Authorized to access this resource/api",
              errors: [{ reason: "forbidden" }],
            },
          },
          403,
        ),
    });
    const body = (await (await authed("/api/lookup?user=jdoe")).json()) as Record<string, any>;
    expect(body.google).toEqual({
      error: "Google Directory API returned HTTP 403: forbidden - Not Authorized to access this resource/api",
    });
  });

  it("prefers the structured reason (e.g. SERVICE_DISABLED)", async () => {
    upstreams({
      [USERS]: () =>
        jsonRes(
          {
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: "Admin SDK API has not been used in project 123 before or it is disabled.",
              details: [{ reason: "SERVICE_DISABLED" }],
            },
          },
          403,
        ),
    });
    const body = (await (await authed("/api/lookup?user=jdoe")).json()) as Record<string, any>;
    expect(body.google.error).toMatch(/^Google Directory API returned HTTP 403: SERVICE_DISABLED - Admin SDK API/);
  });

  it("copes with a non-JSON error body", async () => {
    upstreams({ [USERS]: () => new Response("nope", { status: 500 }) });
    const body = (await (await authed("/api/lookup?user=jdoe")).json()) as Record<string, any>;
    expect(body.google).toEqual({ error: "Google Directory API returned HTTP 500" });
  });
});

describe("routing", () => {
  it("passes non-API paths to static assets", async () => {
    const res = await call("/");
    expect(await res.text()).toBe("asset");
  });

  it("404s unknown API routes after auth", async () => {
    upstreams();
    expect((await authed("/api/nope")).status).toBe(404);
  });
});
