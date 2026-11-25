import { AuthError, requireAccess } from "./access";
import { PublicError, type Env } from "./env";
import { lookupForwardEmail } from "./forwardemail";
import { lookupGoogle } from "./google";
import { normalizeLocalPart } from "./validate";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function settled<T>(r: PromiseSettledResult<T>, source: string): T | { error: string } {
  if (r.status === "fulfilled") return r.value;
  const err = r.reason as Error;
  console.error(JSON.stringify({ event: "lookup_error", source, message: err?.message }));
  return { error: err instanceof PublicError ? err.message : "Unexpected error" };
}

async function handleLookup(url: URL, env: Env, actor: string): Promise<Response> {
  const local = normalizeLocalPart(url.searchParams.get("user") ?? "", env.FE_DOMAIN);
  if (!local) {
    return json({ error: `Enter a valid address on ${env.FE_DOMAIN}` }, 400);
  }

  const [fe, google] = await Promise.allSettled([
    lookupForwardEmail(local, env),
    lookupGoogle(`${local}@${env.GOOGLE_LOOKUP_DOMAIN}`, env),
  ]);

  const forwardemail = settled(fe, "forwardemail");
  const googleResult = settled(google, "google");
  const body = {
    query: `${local}@${env.FE_DOMAIN}`,
    forwardemail,
    google: googleResult,
    // Google Workspace routing takes priority over ForwardEmail for linux.com,
    // so an address that exists in both is delivered to Google only.
    conflict:
      !("error" in forwardemail) && forwardemail.found &&
      !("error" in googleResult) && googleResult.found,
  };

  // Audit trail in Workers Logs. No recipients or secrets.
  console.log(
    JSON.stringify({
      event: "lookup",
      actor,
      query: body.query,
      forwardemail: "error" in body.forwardemail ? "error" : body.forwardemail.found,
      google:
        "error" in body.google ? "error" : body.google.found ? body.google.kind : false,
      conflict: body.conflict,
    }),
  );

  return json(body);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });

    let actor: string;
    try {
      ({ email: actor } = await requireAccess(req, env));
    } catch (err) {
      if (err instanceof AuthError) {
        console.warn(JSON.stringify({ event: "auth_rejected", reason: err.message }));
        return json({ error: "Unauthorized" }, 401);
      }
      throw err;
    }

    switch (url.pathname) {
      case "/api/me":
        return json({ email: actor, domain: env.FE_DOMAIN });
      case "/api/lookup":
        return handleLookup(url, env, actor);
      default:
        return json({ error: "Not found" }, 404);
    }
  },
} satisfies ExportedHandler<Env>;
