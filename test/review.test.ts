import { describe, expect, it } from "vitest";
import { classify, isSharedAccount, resemblesPerson, type ReviewInput } from "../src/review";

const opts = { sharedOrgUnits: ["/Special access"], internalDomains: ["linuxfoundation.org", "linux.com"] };

const person = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  primaryEmail: "psmith@linuxfoundation.org",
  fullName: "Pat Smithson",
  orgUnit: "/Full Time Employees",
  ownLocalParts: ["psmith"],
  aliasEnabled: true,
  recipients: ["someone@example.com"],
  forwardsToUser: false,
  ...over,
});

describe("isSharedAccount", () => {
  it.each([
    [{ primaryEmail: "ap@linuxfoundation.org", orgUnit: "/Staff" }, true],
    [{ primaryEmail: "support@linuxfoundation.org", orgUnit: null }, true],
    [{ primaryEmail: "billing@linuxfoundation.org", orgUnit: "/Staff" }, true],
    [{ primaryEmail: "x@linuxfoundation.org", orgUnit: "/Special access" }, true],
    [{ primaryEmail: "x@linuxfoundation.org", orgUnit: "/Special access/Departmental Integrations" }, true],
    [{ primaryEmail: "x@linuxfoundation.org", orgUnit: "/Special accessories" }, false],
    [{ primaryEmail: "psmith@linuxfoundation.org", orgUnit: "/Full Time Employees" }, false],
  ])("%j -> %s", (input, expected) => {
    expect(isSharedAccount(input, opts)).toBe(expected);
  });
});

describe("resemblesPerson", () => {
  const p = { primaryEmail: "psmith@linuxfoundation.org", fullName: "Pat Smithson", ownLocalParts: ["psmith", "pat"] };
  it.each([
    ["pat.smithson@gmail.com", true], // surname
    ["smit.p@example.com", true], // 4-letter surname prefix
    ["psmith@home.example", true], // own local part
    ["P.Smith-123@Example.com", true], // case / punctuation ignored
    ["pat@other.example", false], // first name alone is not enough
    ["pat.jones@gmail.com", false],
    ["cooldude@example.com", false],
  ])("%s -> %s", (recipient, expected) => {
    expect(resemblesPerson(recipient, p)).toBe(expected);
  });

  it("ignores a local part that is just the first name", () => {
    const named = { primaryEmail: "pjones@linuxfoundation.org", fullName: "Pat Jones", ownLocalParts: ["pjones", "pat"] };
    expect(resemblesPerson("pat.other@gmail.com", named)).toBe(false);
  });

  it("skips name tokens shorter than three characters", () => {
    const short = { primaryEmail: "tli@linuxfoundation.org", fullName: "Tam Li", ownLocalParts: ["tli"] };
    expect(resemblesPerson("li.family@example.com", short)).toBe(false);
    expect(resemblesPerson("tli@example.com", short)).toBe(true);
  });
});

describe("classify", () => {
  it("never flags an alias that forwards to the user", () => {
    expect(classify(person({ forwardsToUser: true, recipients: ["ap@elsewhere.example"] }), opts)).toEqual({ level: "none", reasons: [] });
  });

  it("never flags internal destinations", () => {
    expect(classify(person({ recipients: ["root@linux.com", "x@apac.linux.com", "y@contractor.linuxfoundation.org"] }), opts).level).toBe("none");
  });

  it("does not flag a personal address that resembles the person", () => {
    expect(classify(person({ recipients: ["pat.smithson@gmail.com"] }), opts).level).toBe("none");
  });

  it("flags an unrelated outside address for review", () => {
    const r = classify(person({ recipients: ["cooldude@example.com"] }), opts);
    expect(r.level).toBe("review");
    expect(r.reasons[0]).toContain("cooldude@example.com");
  });

  it("flags a shared account forwarding outside as high", () => {
    const r = classify(person({ primaryEmail: "ap@linuxfoundation.org", fullName: "Accounts Payable", recipients: ["x@store.example"] }), opts);
    expect(r).toEqual({ level: "high", reasons: ["Shared/role account: its linux.com alias forwards outside the organization"] });
  });

  it("downgrades disabled aliases and says why", () => {
    const shared = classify(person({ orgUnit: "/Special access", aliasEnabled: false, recipients: ["x@store.example"] }), opts);
    expect(shared.level).toBe("review");
    expect(shared.reasons).toContain("Alias is disabled in ForwardEmail");

    const stranger = classify(person({ aliasEnabled: false, recipients: ["cooldude@example.com"] }), opts);
    expect(stranger.level).toBe("review");
    expect(stranger.reasons).toContain("Alias is disabled in ForwardEmail");
  });
});
