import { AuthError, requireAccess } from "./access";
import { PublicError, type Env } from "./env";
import { performLookup } from "./lookup";
import { handleMcp } from "./mcp";
import { performSweep } from "./sweep";
import { normalizeLocalPart } from "./validate";

/**
 * Org-wide sweep: active Google users' @SWEEP_GOOGLE_DOMAIN addresses that
 * also exist as ForwardEmail aliases on FE_DOMAIN. Returns the whole report;
 * the page renders it and builds the CSV.
 */
async function handleSweep(env: Env, actor: string): Promise<Response> {
  try {
    return json(await performSweep(env, actor));
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

async function handleLookup(url: URL, env: Env, actor: string): Promise<Response> {
  const local = normalizeLocalPart(url.searchParams.get("user") ?? "", env.FE_DOMAIN);
  if (!local) {
    return json({ error: `Enter a valid address on ${env.FE_DOMAIN}` }, 400);
  }
  return json(await performLookup(local, env, actor));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const isMcp = url.pathname === "/mcp";
    if (!isMcp && !url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    if (!isMcp && req.method !== "GET") return json({ error: "Method not allowed" }, 405, { allow: "GET" });

    let actor: string;
    try {
      ({ email: actor } = await requireAccess(req, env));
    } catch (err) {
      if (err instanceof AuthError) {
        console.warn(JSON.stringify({ event: "auth_rejected", path: url.pathname, reason: err.message }));
        return json({ error: "Unauthorized" }, 401);
      }
      throw err;
    }

    if (isMcp) return handleMcp(req, env, actor);

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
