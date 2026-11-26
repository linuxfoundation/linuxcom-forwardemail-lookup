import type { Env } from "./env";
import { listForwardEmailAliases } from "./forwardemail";
import { listDirectoryUsers } from "./google";

/**
 * One @SWEEP_GOOGLE_DOMAIN address (primary or alias) of an active Google
 * user whose local part is also an explicit ForwardEmail alias on FE_DOMAIN.
 */
export interface SweepMatch {
  googleUser: string;
  googleName: string | null;
  orgUnit: string | null;
  /** The matching @SWEEP_GOOGLE_DOMAIN address on the Google account. */
  googleAddress: string;
  addressType: "primary" | "alias";
  forwardEmailAlias: string;
  forwardEmailEnabled: boolean | null;
  forwardEmailRecipients: string[];
  /** Whether the ForwardEmail alias forwards to any of this user's own addresses. */
  forwardsToUser: boolean;
  forwardEmailDescription: string | null;
  forwardEmailLabels: string[];
}

export interface SweepReport {
  generatedAt: string;
  googleDomain: string;
  forwardEmailDomain: string;
  stats: {
    activeGoogleUsers: number;
    googleAddressesChecked: number;
    forwardEmailAliases: number;
    /** Catch-all / regex aliases, which can't be matched by name. */
    forwardEmailAliasesSkipped: number;
    matches: number;
    matchesForwardingElsewhere: number;
    googlePages: number;
    forwardEmailPages: number;
    forwardEmailPageSize: number;
    forwardEmailReportedTotal: number | null;
    durationMs: number;
  };
  matches: SweepMatch[];
}

/** Plain local parts only: "*" catch-alls and "/regex/" aliases are skipped. */
const isPlainName = (name: string) => name.length > 0 && !name.includes("*") && !name.startsWith("/");

export async function runSweep(env: Env, now: () => number = Date.now): Promise<SweepReport> {
  const started = now();
  const googleDomain = env.SWEEP_GOOGLE_DOMAIN.toLowerCase();
  const suffix = `@${googleDomain}`;

  // Both full listings in parallel; joining in memory keeps API calls to a
  // handful of pages instead of one lookup per address.
  const [fe, google] = await Promise.all([
    listForwardEmailAliases(env),
    listDirectoryUsers(env, { activeOnly: true }),
  ]);

  const feByName = new Map<string, (typeof fe.aliases)[number]>();
  let skipped = 0;
  for (const alias of fe.aliases) {
    const name = alias.name.trim().toLowerCase();
    if (!isPlainName(name)) {
      skipped++;
      continue;
    }
    feByName.set(name, alias);
  }

  const matches: SweepMatch[] = [];
  let checked = 0;
  for (const user of google.users) {
    const primary = user.primaryEmail.toLowerCase();
    const all = new Set([primary, ...user.aliases.map((a) => a.toLowerCase())]);
    for (const address of all) {
      if (!address.endsWith(suffix)) continue;
      checked++;
      const local = address.slice(0, -suffix.length);
      const alias = feByName.get(local);
      if (!alias) continue;
      const recipients = alias.recipients.map((r) => r.trim().toLowerCase());
      matches.push({
        googleUser: user.primaryEmail,
        googleName: user.fullName,
        orgUnit: user.orgUnitPath,
        googleAddress: address,
        addressType: address === primary ? "primary" : "alias",
        forwardEmailAlias: `${alias.name}@${env.FE_DOMAIN}`,
        forwardEmailEnabled: alias.enabled,
        forwardEmailRecipients: alias.recipients,
        forwardsToUser: recipients.some((r) => all.has(r)),
        forwardEmailDescription: alias.description,
        forwardEmailLabels: alias.labels,
      });
    }
  }

  matches.sort((a, b) => a.googleUser.localeCompare(b.googleUser) || a.googleAddress.localeCompare(b.googleAddress));

  return {
    generatedAt: new Date(started).toISOString(),
    googleDomain,
    forwardEmailDomain: env.FE_DOMAIN,
    stats: {
      activeGoogleUsers: google.users.length,
      googleAddressesChecked: checked,
      forwardEmailAliases: fe.aliases.length,
      forwardEmailAliasesSkipped: skipped,
      matches: matches.length,
      matchesForwardingElsewhere: matches.filter((m) => !m.forwardsToUser).length,
      googlePages: google.pages,
      forwardEmailPages: fe.pages,
      forwardEmailPageSize: fe.pageSize,
      forwardEmailReportedTotal: fe.reportedTotal,
      durationMs: now() - started,
    },
    matches,
  };
}
