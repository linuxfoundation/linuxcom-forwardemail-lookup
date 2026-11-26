export interface Env {
  ASSETS: Fetcher;

  /** Domain whose ForwardEmail aliases are looked up, e.g. "linux.com". */
  FE_DOMAIN: string;
  /** Domain appended to the local part for Google Workspace lookups. */
  GOOGLE_LOOKUP_DOMAIN: string;
  /** Google domain whose addresses the org sweep compares, e.g. "linuxfoundation.org". */
  SWEEP_GOOGLE_DOMAIN: string;
  /** Comma-separated org-unit path prefixes holding shared / role accounts. */
  SWEEP_SHARED_ORG_UNITS?: string;

  /** Zero Trust team domain, e.g. "yourteam.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** Audience (AUD) tag of the Cloudflare Access application. */
  ACCESS_AUD?: string;

  /** Workspace user the service account impersonates. */
  GOOGLE_ADMIN_SUBJECT?: string;

  // Secrets
  FORWARDEMAIL_API_TOKEN?: string;
  GOOGLE_SA_KEY_JSON?: string;

  /** Local development only; honored only for localhost requests. */
  DEV_BYPASS_ACCESS?: string;
}

/** An error whose message is safe to show to signed-in users. */
export class PublicError extends Error {}
