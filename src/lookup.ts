import { PublicError, type Env } from "./env";
import { lookupForwardEmail } from "./forwardemail";
import { lookupGoogle, type TraceStep } from "./google";

function settled<T>(r: PromiseSettledResult<T>, source: string): T | { error: string } {
  if (r.status === "fulfilled") return r.value;
  const err = r.reason as Error;
  console.error(JSON.stringify({ event: "lookup_error", source, message: err?.message }));
  return { error: err instanceof PublicError ? err.message : "Unexpected error" };
}

/**
 * Looks up `<local>@FE_DOMAIN` in ForwardEmail and Google Workspace and writes
 * the audit log. Shared by GET /api/lookup and the MCP lookup tool (`via`).
 */
export async function performLookup(local: string, env: Env, actor: string, via: "web" | "mcp" = "web") {

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
      via,
      query: body.query,
      forwardemail: "error" in body.forwardemail ? "error" : body.forwardemail.found,
      google: googleOutcome,
      conflict: body.conflict,
    }),
  );
  if (unusual) {
    console.log(JSON.stringify({ event: "google_trace", actor, query: body.query, outcome: googleOutcome, steps: googleTrace }));
  }

  return body;
}

export type LookupResult = Awaited<ReturnType<typeof performLookup>>;
