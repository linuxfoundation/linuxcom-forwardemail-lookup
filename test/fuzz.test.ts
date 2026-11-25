// Property-based fuzzing (fast-check) of the code that handles untrusted
// input: the address parser and the /api/lookup request handler.
import fc from "fast-check";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetGoogleTokenCache } from "../src/google";
import { normalizeLocalPart } from "../src/validate";
import { jsonRes, makeEnv, makeKeys, mockFetch, type Keys } from "./helpers";

const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

// Arbitrary strings, including unicode, control characters and things that
// look like paths, query strings or other addresses.
const hostile = fc.oneof(
  fc.string({ unit: "binary", maxLength: 200 }),
  fc.string({ unit: "grapheme", maxLength: 80 }),
  fc.constantFrom("../x", "a/b", "a%2fb", "a?b=c", "a#b", "*", "a@b@linux.com", "a..b", ".a", "a.", "\u0000", " "),
  fc.emailAddress(),
);

// Strings that are valid local parts by construction.
const validLocal = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
    fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789._+-"), maxLength: 30 }),
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
  )
  .map(([a, mid, z]) => a + mid + z)
  .filter((s) => !s.includes(".."));

describe("normalizeLocalPart (fuzz)", () => {
  it("never throws and only ever returns a safe local part", () => {
    fc.assert(
      fc.property(hostile, (input) => {
        const out = normalizeLocalPart(input, "linux.com");
        if (out !== null) {
          expect(out).toMatch(LOCAL_PART);
          expect(out).not.toContain("..");
          expect(out.length).toBeLessThanOrEqual(64);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("accepts every valid local part, with or without the domain, in any case", () => {
    fc.assert(
      fc.property(validLocal, fc.boolean(), (local, withDomain) => {
        const input = (withDomain ? `${local}@LINUX.com` : local).toUpperCase();
        expect(normalizeLocalPart(`  ${input} `, "linux.com")).toBe(local);
      }),
      { numRuns: 1000 },
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(hostile, (input) => {
        const once = normalizeLocalPart(input, "linux.com");
        if (once !== null) expect(normalizeLocalPart(once, "linux.com")).toBe(once);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("/api/lookup (fuzz)", () => {
  let keys: Keys;
  beforeAll(async () => {
    keys = await makeKeys();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("answers 200 or 400, and never sends invalid input upstream", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = makeEnv(keys, { DEV_BYPASS_ACCESS: "1" });

    await fc.assert(
      fc.asyncProperty(hostile, async (input) => {
        resetGoogleTokenCache();
        const calls = mockFetch({
          "https://oauth2.googleapis.com/token": () => jsonRes({ access_token: "t", expires_in: 3600 }),
          "https://api.forwardemail.net/": () => jsonRes({}, 404),
          "https://admin.googleapis.com/": () => jsonRes({}, 404),
        });
        const url = new URL("http://localhost:8787/api/lookup");
        url.searchParams.set("user", input);
        const res = await worker.fetch(new Request(url), env);
        const local = normalizeLocalPart(input, "linux.com");

        if (local === null) {
          expect(res.status).toBe(400);
          expect(calls).toHaveLength(0);
        } else {
          expect(res.status).toBe(200);
          // Upstream URLs only ever carry the validated local part.
          for (const c of calls.filter((r) => r.method === "GET")) {
            expect(decodeURIComponent(new URL(c.url).pathname)).toContain(local);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
