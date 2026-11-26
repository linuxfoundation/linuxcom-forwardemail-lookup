import { AuthError, requireAccess } from "./access";
import { PublicError, type Env } from "./env";
import { lookupForwardEmail } from "./forwardemail";
import { lookupGoogle, type TraceStep } from "./google";
import { runSweep } from "./sweep";
import { normalizeLocalPart } from "./validate";

/**
 * Org-wide sweep: active Google users' @SWEEP_GOOGLE_DOMAIN addresses that
 * also exist as ForwardEmail aliases on FE_DOMAIN. Returns the whole report;
 * the page renders it and builds the CSV.
 */
async function handleSweep(env: Env, actor: string): Promise<Response> {
  try {
    const report = await runSweep(env);
    // Audit trail: who ran it and the counts (no addresses or recipients).
    console.log(JSON.stringify({ event: "sweep", actor, ...report.stats }));
    return json(report);
  } catch (err) {
    console.error(JSON.stringify({ event: "sweep_error", actor, message: (err as Error)?.message }));
    return json({ error: err instanceof PublicError ? err.message : "Unexpected error" }, 502);
  }
}

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

  const googleTrace: TraceStep[] = [];
  const [fe, google] = await Promise.allSettled([
    lookupForwardEmail(local, env),
    lookupGoogle(`${local}@${env.GOOGLE_LOOKUP_DOMAIN}`, env, googleTrace),
  ]);

  const forwardemail = settled(fe, "forwardemail");
  const googleResult = settled(google, "google");
  const googleOutcome =
    "error" in googleResult
      ? "error"
      : googleResult.found
        ? googleResult.kind
        : "outsideTenant" in googleResult
          ? `outside-tenant:${googleResult.accountType}`
          : "not-found";

  // Anything other than plain found / not-found answers (a 403, an error, a
  // skipped check) gets its full call trace, in the logs and the response.
  const unusual = googleTrace.some((s) => s.status !== 200 && s.status !== 404);

  const body = {
    query: `${local}@${env.FE_DOMAIN}`,
    forwardemail,
    google: googleResult,
    // Google Workspace routing takes priority over ForwardEmail for linux.com,
    // so an address that exists in both is delivered to Google only.
    conflict:
      !("error" in forwardemail) && forwardemail.found &&
      !("error" in googleResult) && googleResult.found,
    ...(unusual ? { googleTrace } : {}),
  };

  // Audit trail in Workers Logs. No recipients or secrets.
  console.log(
    JSON.stringify({
      event: "lookup",
      actor,
      query: body.query,
      forwardemail: "error" in body.forwardemail ? "error" : body.forwardemail.found,
      google: googleOutcome,
      conflict: body.conflict,
    }),
  );
  if (unusual) {
    console.log(JSON.stringify({ event: "google_trace", actor, query: body.query, outcome: googleOutcome, steps: googleTrace }));
  }

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
      case "/api/sweep":
        return handleSweep(env, actor);
      default:
        return json({ error: "Not found" }, 404);
    }
  },
} satisfies ExportedHandler<Env>;
