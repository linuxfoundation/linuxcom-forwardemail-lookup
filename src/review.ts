// Heuristics that flag sweep matches for a human to look at. They are
// deliberately simple and explainable: every flag carries its reasons.

export type ReviewLevel = "high" | "review" | "none";

export interface ReviewInput {
  primaryEmail: string;
  fullName: string | null;
  orgUnit: string | null;
  /** Local parts of the user's @SWEEP_GOOGLE_DOMAIN addresses. */
  ownLocalParts: string[];
  aliasEnabled: boolean | null;
  recipients: string[];
  forwardsToUser: boolean;
}

export interface ReviewOptions {
  /** Org-unit path prefixes that hold shared / role accounts. */
  sharedOrgUnits: string[];
  /** Domains (and their subdomains) that count as internal destinations. */
  internalDomains: string[];
}

/** Local parts that conventionally name a shared mailbox, not a person. */
const ROLE_LOCAL_PARTS = new Set([
  "abuse", "accounting", "accounts", "admin", "administrator", "ap", "ar", "billing", "careers",
  "contact", "events", "finance", "help", "helpdesk", "hostmaster", "hr", "info", "it", "jobs",
  "legal", "marketing", "no-reply", "noreply", "office", "ops", "payroll", "postmaster", "pr",
  "press", "privacy", "root", "sales", "security", "support", "sysadmin", "team", "training",
  "webmaster",
]);

const alnum = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

function isInternal(address: string, internalDomains: string[]): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return internalDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export function isSharedAccount(input: Pick<ReviewInput, "primaryEmail" | "orgUnit">, opts: ReviewOptions): boolean {
  const local = input.primaryEmail.slice(0, input.primaryEmail.indexOf("@")).toLowerCase();
  if (ROLE_LOCAL_PARTS.has(local)) return true;
  const ou = input.orgUnit ?? "";
  return opts.sharedOrgUnits.some((prefix) => prefix && (ou === prefix || ou.startsWith(`${prefix}/`)));
}

/**
 * Whether an outside recipient plausibly belongs to this person: it contains
 * their surname (any name token after the first, or its first four letters
 * when the token is longer) or one of their own local parts (3+ characters).
 * A first name alone is not enough ("john" matches far too many people), so
 * a local part that is just the first name ("john@", "frank@") is ignored.
 */
export function resemblesPerson(recipient: string, input: Pick<ReviewInput, "fullName" | "ownLocalParts" | "primaryEmail">): boolean {
  const target = alnum(recipient);
  const needles = new Set<string>();
  const tokens = (input.fullName ?? "").split(/\s+/).map(alnum).filter(Boolean);
  const firstName = tokens[0] ?? "";
  for (const t of tokens.slice(1)) {
    if (t.length >= 3) needles.add(t);
    if (t.length >= 5) needles.add(t.slice(0, 4));
  }
  const primaryLocal = input.primaryEmail.slice(0, input.primaryEmail.indexOf("@"));
  for (const l of [primaryLocal, ...input.ownLocalParts]) {
    const n = alnum(l);
    if (n.length >= 3 && n !== firstName) needles.add(n);
  }
  for (const n of needles) if (target.includes(n)) return true;
  return false;
}

export function classify(input: ReviewInput, opts: ReviewOptions): { level: ReviewLevel; reasons: string[] } {
  if (input.forwardsToUser) return { level: "none", reasons: [] };

  const outside = input.recipients.filter((r) => !isInternal(r, opts.internalDomains));
  if (outside.length === 0) return { level: "none", reasons: [] };

  const enabled = input.aliasEnabled !== false;
  const reasons: string[] = [];
  let level: ReviewLevel = "none";

  if (isSharedAccount(input, opts)) {
    reasons.push("Shared/role account: its linux.com alias forwards outside the organization");
    level = enabled ? "high" : "review";
  }

  const strangers = outside.filter((r) => !resemblesPerson(r, input));
  if (strangers.length && !isSharedAccount(input, opts)) {
    reasons.push(`Forwards to an address that doesn't resemble this person: ${strangers.join(", ")}`);
    if (level === "none") level = "review";
  }

  if (level !== "none" && !enabled) reasons.push("Alias is disabled in ForwardEmail");
  return { level, reasons };
}
