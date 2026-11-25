import { PublicError, type Env } from "./env";

const API = "https://api.forwardemail.net";

export type ForwardEmailResult =
  | { found: false }
  | {
      found: true;
      name: string;
      enabled: boolean | null;
      recipients: string[];
      labels: string[];
      description: string | null;
      hasImap: boolean | null;
    };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** Looks up `<local>@FE_DOMAIN` as an explicit ForwardEmail alias. */
export async function lookupForwardEmail(local: string, env: Env): Promise<ForwardEmailResult> {
  if (!env.FORWARDEMAIL_API_TOKEN) {
    throw new PublicError("ForwardEmail API token is not configured");
  }

  // Basic auth: API token as username, empty password.
  const auth = `Basic ${btoa(`${env.FORWARDEMAIL_API_TOKEN}:`)}`;
  const url =
    `${API}/v1/domains/${encodeURIComponent(env.FE_DOMAIN)}` +
    `/aliases/${encodeURIComponent(local)}`;

  const res = await fetch(url, { headers: { authorization: auth, accept: "application/json" } });
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new PublicError(`ForwardEmail API returned HTTP ${res.status}`);

  const a = (await res.json()) as Record<string, unknown>;
  return {
    found: true,
    name: typeof a.name === "string" ? a.name : local,
    enabled: bool(a.is_enabled),
    recipients: strings(a.recipients),
    labels: strings(a.labels),
    description: typeof a.description === "string" && a.description ? a.description : null,
    hasImap: bool(a.has_imap),
  };
}
