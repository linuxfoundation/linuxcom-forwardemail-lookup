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
 * Whether an outside recipient plausibly belongs to this person.
 *
 * The mailbox name (before "@") must contain their surname (any name token
 * after the first, or its first four letters when longer) or one of their own
 * local parts (3+ characters). The domain only counts on a full token match
 * (4+ characters, e.g. a personal domain like "smithson.example"), never on a
 * prefix, so a provider such as gmail/hotmail can't match "Mailer".
 * A first name alone is not enough ("john" matches far too many people), so
 * a local part that is just the first name ("john@", "frank@") is ignored.
 */
export function resemblesPerson(recipient: string, input: Pick<ReviewInput, "fullName" | "ownLocalParts" | "primaryEmail">): boolean {
  const at = recipient.lastIndexOf("@");
  const mailbox = alnum(at === -1 ? recipient : recipient.slice(0, at));
  const domainLabels = (at === -1 ? "" : recipient.slice(at + 1)).toLowerCase().split(".").slice(0, -1).map(alnum);

  const tokens = (input.fullName ?? "").split(/\s+/).map(alnum).filter(Boolean);
  const firstName = tokens[0] ?? "";
  const whole = new Set<string>(); // full surname tokens and own local parts
  const prefixes = new Set<string>(); // 4-letter surname prefixes (mailbox only)
  for (const t of tokens.slice(1)) {
    if (t.length >= 3) whole.add(t);
    if (t.length >= 5) prefixes.add(t.slice(0, 4));
  }
  const primaryLocal = input.primaryEmail.slice(0, input.primaryEmail.indexOf("@"));
  for (const l of [primaryLocal, ...input.ownLocalParts]) {
    const n = alnum(l);
    if (n.length >= 3 && n !== firstName) whole.add(n);
  }

  for (const n of [...whole, ...prefixes]) if (mailbox.includes(n)) return true;
  for (const n of whole) if (n.length >= 4 && domainLabels.some((label) => label.includes(n))) return true;
  return false;
}

export function classify(input: ReviewInput, opts: ReviewOptions): { level: ReviewLevel; reasons: string[] } {
  if (input.forwardsToUser) return { level: "none", reasons: [] };

  const outside = input.recipients.filter((r) => !isInternal(r, opts.internalDomains));
  if (outside.length === 0) return { level: "none", reasons: [] };

  // High needs an alias known to be enabled; an unknown status (null) stays
  // at Review, and only an explicit false is described as disabled.
  const enabled = input.aliasEnabled === true;
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

  if (level !== "none" && input.aliasEnabled === false) reasons.push("Alias is disabled in ForwardEmail");
  if (level !== "none" && input.aliasEnabled === null) reasons.push("Alias enabled status is unknown");
  return { level, reasons };
}
