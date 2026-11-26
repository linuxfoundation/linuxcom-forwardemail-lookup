import { PublicError, type Env } from "./env";

const API = "https://api.forwardemail.net";

export interface ForwardEmailAlias {
  name: string;
  enabled: boolean | null;
  recipients: string[];
  labels: string[];
  description: string | null;
  hasImap: boolean | null;
}

export type ForwardEmailResult = { found: false } | ({ found: true } & ForwardEmailAlias);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

function toAlias(a: Record<string, unknown>, fallbackName = ""): ForwardEmailAlias {
  return {
    name: typeof a.name === "string" ? a.name : fallbackName,
    enabled: bool(a.is_enabled),
    recipients: strings(a.recipients),
    labels: strings(a.labels),
    description: typeof a.description === "string" && a.description ? a.description : null,
    hasImap: bool(a.has_imap),
  };
}

function authHeaders(env: Env): Record<string, string> {
  if (!env.FORWARDEMAIL_API_TOKEN) {
    throw new PublicError("ForwardEmail API token is not configured");
  }
  // Basic auth: API token as username, empty password.
  return { authorization: `Basic ${btoa(`${env.FORWARDEMAIL_API_TOKEN}:`)}`, accept: "application/json" };
}

const aliasesUrl = (env: Env) => `${API}/v1/domains/${encodeURIComponent(env.FE_DOMAIN)}/aliases`;

/** Looks up `<local>@FE_DOMAIN` as an explicit ForwardEmail alias. */
export async function lookupForwardEmail(local: string, env: Env): Promise<ForwardEmailResult> {
  const res = await fetch(`${aliasesUrl(env)}/${encodeURIComponent(local)}`, { headers: authHeaders(env) });
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new PublicError(`ForwardEmail API returned HTTP ${res.status}`);
  return { found: true, ...toAlias((await res.json()) as Record<string, unknown>, local) };
}

export interface AliasListing {
  aliases: ForwardEmailAlias[];
  pages: number;
  pageSize: number;
  /** X-Item-Count from the API, when it sends one. */
  reportedTotal: number | null;
}

/**
 * Lists every alias on FE_DOMAIN. The API docs disagree on page sizes
 * (a 1000-result default vs. a `limit` capped at 50), so this asks for 1000,
 * falls back to 50 if that is rejected, and follows X-Page-Count. Without
 * that header it keeps going until an empty or repeated page.
 */
export async function listForwardEmailAliases(env: Env, maxPages = 200): Promise<AliasListing> {
  const headers = authHeaders(env);
  const aliases: ForwardEmailAlias[] = [];
  const seenPageKeys = new Set<string>();
  let limit = 1000;
  let page = 1;
  let reportedTotal: number | null = null;

  for (;;) {
    if (page > maxPages) {
      throw new PublicError(`ForwardEmail alias list exceeded ${maxPages} pages; aborting`);
    }
    const url = `${aliasesUrl(env)}?paginate=true&page=${page}&limit=${limit}`;
    const res = await fetch(url, { headers });
    if (res.status === 400 && page === 1 && limit > 50) {
      limit = 50;
      continue;
    }
    if (!res.ok) throw new PublicError(`ForwardEmail API returned HTTP ${res.status} listing aliases`);

    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new PublicError("ForwardEmail alias list was not an array");
    if (body.length === 0) break;

    // Stop if the API ignores `page` and repeats the same page.
    const first = body[0] as Record<string, unknown>;
    const pageKey = String(first?.id ?? first?.name ?? "");
    if (seenPageKeys.has(pageKey)) break;
    seenPageKeys.add(pageKey);

    for (const a of body) aliases.push(toAlias(a as Record<string, unknown>));

    const total = Number(res.headers.get("x-item-count"));
    if (Number.isFinite(total) && res.headers.has("x-item-count")) reportedTotal = total;

    const pageCount = Number(res.headers.get("x-page-count"));
    if (res.headers.has("x-page-count") && Number.isFinite(pageCount) && page >= pageCount) break;
    page++;
  }

  return { aliases, pages: page, pageSize: limit, reportedTotal };
}
