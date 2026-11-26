import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetGoogleTokenCache } from "../src/google";
import { runSweep } from "../src/sweep";
import type { Env } from "../src/env";
import { TEAM, jsonRes, makeEnv, makeKeys, mockFetch, type Keys } from "./helpers";

const TOKEN = "https://oauth2.googleapis.com/token";
const FE_LIST = "https://api.forwardemail.net/v1/domains/linux.com/aliases?";
const USERS_LIST = "https://admin.googleapis.com/admin/directory/v1/users?";
const CERTS = `https://${TEAM}/cdn-cgi/access/certs`;

let keys: Keys;
let env: Env;

beforeAll(async () => {
  keys = await makeKeys();
});
beforeEach(() => {
  env = makeEnv(keys);
  resetGoogleTokenCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const fe = (name: string, recipients: string[], extra: Record<string, unknown> = {}) => ({
  id: `id-${name}`,
  name,
  is_enabled: true,
  recipients,
  labels: [],
  ...extra,
});

const user = (primaryEmail: string, extra: Record<string, unknown> = {}) => ({
  primaryEmail,
  name: { fullName: primaryEmail.split("@")[0] },
  orgUnitPath: "/Staff",
  ...extra,
});

/** FE list mock: one array per page, with X-Page-Count / X-Item-Count. */
function feListPages(pages: unknown[][], withHeaders = true) {
  const total = pages.reduce((n, p) => n + p.length, 0);
  return (req: Request) => {
    const page = Number(new URL(req.url).searchParams.get("page") ?? "1");
    const body = pages[page - 1] ?? [];
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (withHeaders) {
      headers["x-page-count"] = String(pages.length);
      headers["x-item-count"] = String(total);
    }
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
}

/** Directory users.list mock: pages chained with nextPageToken "p2", "p3", ... */
function usersPages(pages: unknown[][]) {
  return (req: Request) => {
    const token = new URL(req.url).searchParams.get("pageToken");
    const i = token ? Number(token.slice(1)) - 1 : 0;
    return jsonRes({ users: pages[i] ?? [], ...(i + 1 < pages.length ? { nextPageToken: `p${i + 2}` } : {}) });
  };
}

const tokenRoute = { [TOKEN]: () => jsonRes({ access_token: "g-token", expires_in: 3600 }) };

describe("runSweep", () => {
  it("matches only @linuxfoundation.org addresses against linux.com aliases", async () => {
    mockFetch({
      ...tokenRoute,
      [FE_LIST]: feListPages([
        [
          fe("alice", ["alice@linuxfoundation.org"]),
          fe("ali", ["someone@gmail.com"]),
          fe("bob", ["bob@example.com"]),
          fe("carol", ["carol@example.com"]),
          fe("*", ["catchall@example.com"]),
          fe("/^dev-.*$/", ["dev@example.com"]),
        ],
      ]),
      [USERS_LIST]: usersPages([
        [
          user("alice@linuxfoundation.org", {
            aliases: ["ali@linuxfoundation.org", "alice@linux.com"],
            nonEditableAliases: ["alice@linux-foundation.org"],
          }),
          // carol only has carol@ on another domain: not compared.
          user("carol@linux-foundation.org", { aliases: ["carol@linux.com"] }),
          user("dave@linuxfoundation.org"),
        ],
      ]),
    });

    const report = await runSweep(env);

    expect(report.matches.map((m) => [m.googleAddress, m.addressType, m.forwardEmailAlias, m.forwardsToUser])).toEqual([
      ["ali@linuxfoundation.org", "alias", "ali@linux.com", false],
      ["alice@linuxfoundation.org", "primary", "alice@linux.com", true],
    ]);
    expect(report.matches[1]).toMatchObject({
      googleUser: "alice@linuxfoundation.org",
      googleName: "alice",
      orgUnit: "/Staff",
      forwardEmailEnabled: true,
      forwardEmailRecipients: ["alice@linuxfoundation.org"],
    });
    expect(report.stats).toMatchObject({
      activeGoogleUsers: 3,
      googleAddressesChecked: 3, // alice@, ali@, dave@ (other domains ignored)
      forwardEmailAliases: 6,
      forwardEmailAliasesSkipped: 2,
      matches: 2,
      matchesForwardingElsewhere: 1,
    });
    expect(report.googleDomain).toBe("linuxfoundation.org");
    expect(report.forwardEmailDomain).toBe("linux.com");
  });

  it("is case-insensitive and treats a forward to any of the user's own addresses as theirs", async () => {
    mockFetch({
      ...tokenRoute,
      [FE_LIST]: feListPages([[fe("JDoe", ["JDoe@Linux.com"])]]),
      [USERS_LIST]: usersPages([[user("JDoe@LinuxFoundation.org", { aliases: ["jdoe@linux.com"] })]]),
    });
    const report = await runSweep(env);
    expect(report.matches).toHaveLength(1);
    expect(report.matches[0]).toMatchObject({ googleAddress: "jdoe@linuxfoundation.org", forwardsToUser: true });
  });

  it("asks Google for active users only and drops archived ones", async () => {
    const calls = mockFetch({
      ...tokenRoute,
      [FE_LIST]: feListPages([[fe("arch", ["x@example.com"]), fe("live", ["y@example.com"])]]),
      [USERS_LIST]: usersPages([[user("arch@linuxfoundation.org", { archived: true }), user("live@linuxfoundation.org")]]),
    });
    const report = await runSweep(env);
    expect(report.matches.map((m) => m.googleUser)).toEqual(["live@linuxfoundation.org"]);
    expect(report.stats.activeGoogleUsers).toBe(1);
    const q = new URL(calls.find((r) => r.url.startsWith(USERS_LIST))!.url).searchParams;
    expect(q.get("customer")).toBe("my_customer");
    expect(q.get("query")).toBe("isSuspended=false");
    expect(q.get("maxResults")).toBe("500");
  });

  it("follows Google and ForwardEmail pagination", async () => {
    const calls = mockFetch({
      ...tokenRoute,
      [FE_LIST]: feListPages([[fe("a1", [])], [fe("a2", [])], [fe("a3", [])]]),
      [USERS_LIST]: usersPages([[user("a1@linuxfoundation.org")], [user("a3@linuxfoundation.org")]]),
    });
    const report = await runSweep(env);
    expect(report.matches.map((m) => m.googleAddress)).toEqual(["a1@linuxfoundation.org", "a3@linuxfoundation.org"]);
    expect(report.stats).toMatchObject({ googlePages: 2, forwardEmailPages: 3, forwardEmailAliases: 3, forwardEmailReportedTotal: 3 });
    expect(calls.filter((r) => r.url.startsWith(FE_LIST))).toHaveLength(3);
  });

  it("falls back to limit=50 when the API rejects limit=1000", async () => {
    const limits: string[] = [];
    mockFetch({
      ...tokenRoute,
      [FE_LIST]: (req) => {
        const limit = new URL(req.url).searchParams.get("limit")!;
        limits.push(limit);
        return limit === "1000" ? jsonRes({ message: "limit too large" }, 400) : feListPages([[fe("x", [])]])(req);
      },
      [USERS_LIST]: usersPages([[]]),
    });
    const report = await runSweep(env);
    expect(limits).toEqual(["1000", "50"]);
    expect(report.stats.forwardEmailPageSize).toBe(50);
  });

  it("without page headers, stops at an empty page or a repeated page", async () => {
    mockFetch({
      ...tokenRoute,
      [FE_LIST]: feListPages([[fe("a", [])], [fe("b", [])]], false),
      [USERS_LIST]: usersPages([[]]),
    });
    expect((await runSweep(env)).stats).toMatchObject({ forwardEmailAliases: 2, forwardEmailPages: 3 });

    resetGoogleTokenCache();
    vi.unstubAllGlobals();
    mockFetch({
      ...tokenRoute,
      // API that ignores ?page= and always returns the same page
      [FE_LIST]: () => jsonRes([fe("same", [])]),
      [USERS_LIST]: usersPages([[]]),
    });
    expect((await runSweep(env)).stats.forwardEmailAliases).toBe(1);
  });

  it("flags matches for review and lists the most urgent first", async () => {
    mockFetch({
      ...tokenRoute,
      [FE_LIST]: feListPages([
        [
          fe("ap", ["someone@store.example"]),
          fe("pat", ["pat.other@gmail.com"]),
          fe("psmithson", ["pat.smithson@gmail.com"]),
          fe("zed", ["zed@linuxfoundation.org"]),
        ],
      ]),
      [USERS_LIST]: usersPages([
        [
          user("ap@linuxfoundation.org", { name: { fullName: "Accounts Payable" }, orgUnitPath: "/Special access" }),
          user("psmithson@linuxfoundation.org", { name: { fullName: "Pat Smithson" }, aliases: ["pat@linuxfoundation.org"] }),
          user("zed@linuxfoundation.org", { name: { fullName: "Zed Zulu" } }),
        ],
      ]),
    });
    const report = await runSweep(env);
    expect(report.matches.map((m) => [m.forwardEmailAlias, m.review])).toEqual([
      ["ap@linux.com", "high"],
      ["pat@linux.com", "review"],
      ["psmithson@linux.com", "none"],
      ["zed@linux.com", "none"],
    ]);
    expect(report.matches[1]!.reviewReasons[0]).toContain("pat.other@gmail.com");
    expect(report.stats).toMatchObject({ reviewHigh: 1, reviewOther: 1 });
  });

  it("requests and uses Google's structured given/family names", async () => {
    const calls = mockFetch({
      ...tokenRoute,
      [FE_LIST]: feListPages([[fe("msmithson", ["ann.jones@outside.example"])]]),
      [USERS_LIST]: usersPages([
        [user("msmithson@linuxfoundation.org", { name: { fullName: "Mary Ann Smithson", givenName: "Mary Ann", familyName: "Smithson" } })],
      ]),
    });
    const report = await runSweep(env);
    expect(report.matches[0]).toMatchObject({ review: "review" });
    const fields = new URL(calls.find((r) => r.url.startsWith(USERS_LIST))!.url).searchParams.get("fields")!;
    expect(fields).toContain("name/givenName");
    expect(fields).toContain("name/familyName");
  });

  it("flags a role-name alias on an ordinary account as High", async () => {
    mockFetch({
      ...tokenRoute,
      [FE_LIST]: feListPages([[fe("support", ["support@vendor.example"])]]),
      [USERS_LIST]: usersPages([
        [user("sharedservices@linuxfoundation.org", { orgUnitPath: "/Staff", aliases: ["support@linuxfoundation.org"] })],
      ]),
    });
    const report = await runSweep(env);
    expect(report.matches[0]).toMatchObject({ forwardEmailAlias: "support@linux.com", review: "high" });
  });

  it("classifies normalized recipients (whitespace / case can't make an internal address look external)", async () => {
    mockFetch({
      ...tokenRoute,
      [FE_LIST]: feListPages([[fe("careers", [" Root@Linux.COM "])]]),
      [USERS_LIST]: usersPages([[user("careers@linuxfoundation.org", { orgUnitPath: "/Special access" })]]),
    });
    const report = await runSweep(env);
    expect(report.matches[0]).toMatchObject({ forwardEmailAlias: "careers@linux.com", review: "none" });
  });

  it("surfaces upstream failures", async () => {
    mockFetch({
      ...tokenRoute,
      [FE_LIST]: () => jsonRes({}, 500),
      [USERS_LIST]: usersPages([[]]),
    });
    await expect(runSweep(env)).rejects.toThrow("ForwardEmail API returned HTTP 500 listing aliases");
  });
});

describe("/api/sweep", () => {
  it("requires Access", async () => {
    mockFetch({ [CERTS]: () => jsonRes(keys.accessJwks) });
    const res = await worker.fetch(new Request("https://lookup.example.org/api/sweep"), env);
    expect(res.status).toBe(401);
  });

  it("returns the report and logs an audit event without addresses", async () => {
    const jwt = await keys.signAccess({ email: "staff@linuxfoundation.org" });
    mockFetch({
      [CERTS]: () => jsonRes(keys.accessJwks),
      ...tokenRoute,
      [FE_LIST]: feListPages([[fe("alice", ["alice@example.com"])]]),
      [USERS_LIST]: usersPages([[user("alice@linuxfoundation.org")]]),
    });
    const res = await worker.fetch(
      new Request("https://lookup.example.org/api/sweep", { headers: { "cf-access-jwt-assertion": jwt } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, any>;
    expect(body.matches).toHaveLength(1);

    const events = vi.mocked(console.log).mock.calls.map((c) => JSON.parse(String(c[0])));
    const audit = events.find((e) => e.event === "sweep");
    expect(audit).toMatchObject({ actor: "staff@linuxfoundation.org", matches: 1, activeGoogleUsers: 1 });
    expect(JSON.stringify(audit)).not.toContain("alice");
  });

  it("returns 502 with the reason when a provider fails", async () => {
    const jwt = await keys.signAccess({ email: "staff@linuxfoundation.org" });
    mockFetch({
      [CERTS]: () => jsonRes(keys.accessJwks),
      ...tokenRoute,
      [FE_LIST]: feListPages([[]]),
      [USERS_LIST]: () => jsonRes({ error: { code: 403, message: "Not Authorized to access this resource/api", errors: [{ reason: "forbidden" }] } }, 403),
    });
    const res = await worker.fetch(
      new Request("https://lookup.example.org/api/sweep", { headers: { "cf-access-jwt-assertion": jwt } }),
      env,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Google Directory API returned HTTP 403: forbidden - Not Authorized to access this resource/api",
    });
  });
});
