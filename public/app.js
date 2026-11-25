"use strict";

const $ = (id) => document.getElementById(id);

// Access redirects expired sessions to the IdP, which a fetch() cannot follow
// across origins; surface that as "reload to sign in".
class SessionError extends Error {}

async function api(path) {
  let res;
  try {
    res = await fetch(path, { headers: { accept: "application/json" }, credentials: "same-origin" });
  } catch {
    throw new SessionError("Your session may have expired.");
  }
  const type = res.headers.get("content-type") || "";
  if (res.status === 401 || res.redirected || !type.includes("application/json")) {
    throw new SessionError("Your session may have expired.");
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed (HTTP ${res.status})`);
  return body;
}

function setStatus(text, kind = "", withReload = false) {
  const el = $("status");
  el.className = `status ${kind}`.trim();
  el.textContent = text;
  if (withReload) {
    const a = document.createElement("a");
    a.href = location.pathname;
    a.textContent = "Reload to sign in again";
    el.append(" ", a);
  }
}

function row(dl, label, value) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return;
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  if (Array.isArray(value)) {
    const ul = document.createElement("ul");
    for (const v of value) {
      const li = document.createElement("li");
      li.textContent = v;
      ul.append(li);
    }
    dd.append(ul);
  } else {
    dd.textContent = String(value);
  }
  dl.append(dt, dd);
}

function renderCard(id, result, describe) {
  const card = $(id);
  const badge = card.querySelector('[data-role="badge"]');
  const dl = card.querySelector('[data-role="details"]');
  dl.replaceChildren();
  card.classList.remove("found", "missing", "error", "shadowed");

  if (result.error) {
    card.classList.add("error");
    badge.textContent = "Error";
    row(dl, "Details", result.error);
    return;
  }
  if (!result.found) {
    card.classList.add("missing");
    badge.textContent = "Not found";
    if (result.outsideTenant) {
      badge.textContent = "Not in Workspace";
      const OUTSIDE = {
        unmanaged: [
          "Unmanaged personal account",
          "A personal Google account uses this address as its login. It can be invited to become a managed Workspace account.",
          "Admin console → Directory → Unmanaged users → Personal accounts",
        ],
        other: [
          "Google account outside this Workspace",
          "Google knows this address but it isn't an unmanaged account on our domains (e.g. it belongs to another organization or is a conflicting account).",
          "Admin console → Directory → Unmanaged users → Manage conflicting accounts",
        ],
        unknown: [
          "Google account outside this Workspace",
          "Most likely an unmanaged personal account. The Cloud Identity check that would confirm it is unavailable (see Why?).",
          "Admin console → Directory → Unmanaged users",
        ],
      };
      const [type, details, where] = OUTSIDE[result.accountType] || OUTSIDE.unknown;
      row(dl, "Type", type);
      row(dl, "Details", `${details} It does not receive this domain's mail.`);
      row(dl, "Where to look", where);
    }
    return;
  }
  card.classList.add("found");
  describe(result, badge, dl);
}

const yesNo = (v) => (v === null || v === undefined ? null : v ? "Yes" : "No");

function describeFe(r, badge, dl) {
  badge.textContent = r.enabled === false ? "Found (disabled)" : "Found";
  row(dl, "Alias", r.name);
  row(dl, "Enabled", yesNo(r.enabled));
  row(dl, "Forwards to", r.recipients);
  row(dl, "IMAP mailbox", yesNo(r.hasImap));
  row(dl, "Labels", r.labels.length ? r.labels.join(", ") : null);
  row(dl, "Description", r.description);
}

const KIND_LABEL = {
  user: "User",
  "user-alias": "Alias of a user",
  group: "Group",
  "group-alias": "Alias of a group",
};

function describeGoogle(r, badge, dl) {
  badge.textContent = KIND_LABEL[r.kind] || "Found";
  if (r.kind === "user" || r.kind === "user-alias") {
    row(dl, "Primary email", r.primaryEmail);
    row(dl, "Name", r.fullName);
    row(dl, "Suspended", yesNo(r.suspended));
    if (r.archived) row(dl, "Archived", "Yes");
  } else {
    row(dl, "Group email", r.email);
    row(dl, "Name", r.name);
    row(dl, "Direct members", r.directMembersCount);
    row(dl, "Description", r.description);
  }
  row(dl, "Aliases", r.aliases);
}

// Every Google API call behind an unusual answer (403s, errors, skipped
// checks), with Google's own error response, in a collapsible section.
function renderTrace(card, steps) {
  card.querySelector(".trace")?.remove();
  if (!Array.isArray(steps) || !steps.length) return;

  const details = document.createElement("details");
  details.className = "trace";
  const summary = document.createElement("summary");
  summary.textContent = "Why?";
  const list = document.createElement("ol");
  for (const s of steps) {
    const li = document.createElement("li");
    const head = document.createElement("div");
    head.className = "trace-head";
    const name = document.createElement("code");
    name.textContent = s.step;
    const status = document.createElement("span");
    const ok = s.status === 200 || s.status === 404;
    status.className = `trace-status ${ok ? "ok" : "bad"}`;
    status.textContent = `${s.status}${typeof s.ms === "number" ? ` · ${s.ms} ms` : ""}`;
    head.append(name, status);
    li.append(head);
    if (s.error !== undefined) {
      const pre = document.createElement("pre");
      pre.textContent = typeof s.error === "string" ? s.error : JSON.stringify(s.error, null, 2);
      li.append(pre);
    }
    list.append(li);
  }
  details.append(summary, list);
  card.append(details);
}

// Google Workspace routing rules take priority over ForwardEmail for this
// domain, so when both have the address only Google receives the mail.
function renderConflict(data) {
  const box = $("conflict");
  box.hidden = !data.conflict;
  if (!data.conflict) return;

  const g = data.google;
  const target =
    g.kind === "user" || g.kind === "user-alias"
      ? `the Google Workspace user ${g.primaryEmail}`
      : `the Google Workspace group ${g.email}`;
  $("conflict-text").textContent =
    ` Mail to ${data.query} is delivered to ${target} because Google Workspace routing rules take priority. ` +
    "The ForwardEmail alias will not receive it.";

  const dl = $("card-fe").querySelector('[data-role="details"]');
  row(dl, "Receives mail", "No: Google Workspace takes priority");
  $("card-fe").classList.add("shadowed");
  $("card-fe").querySelector('[data-role="badge"]').textContent = "Found (not receiving)";
}

let inFlight = null;

async function lookup(event) {
  event.preventDefault();
  const input = $("user");
  const value = input.value.trim();
  if (!value) {
    input.focus();
    return;
  }

  inFlight?.abort?.();
  const ticket = (inFlight = { aborted: false, abort() { this.aborted = true; } });

  $("go").disabled = true;
  setStatus("Looking up…", "busy");
  try {
    const data = await api(`/api/lookup?user=${encodeURIComponent(value)}`);
    if (ticket.aborted) return;
    $("query").textContent = data.query;
    renderCard("card-fe", data.forwardemail, describeFe);
    renderCard("card-google", data.google, describeGoogle);
    renderTrace($("card-google"), data.googleTrace);
    renderConflict(data);
    $("results").hidden = false;
    setStatus("");
    history.replaceState(null, "", `?user=${encodeURIComponent(value)}`);
  } catch (err) {
    if (ticket.aborted) return;
    $("results").hidden = true;
    setStatus(err.message, "error", err instanceof SessionError);
  } finally {
    if (!ticket.aborted) $("go").disabled = false;
  }
}

function initials(name, email) {
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (email || "?").slice(0, 2).toUpperCase();
}

function showUser(name, email) {
  $("user-name").textContent = name || email.split("@")[0];
  $("whoami").textContent = email;
  $("avatar").textContent = initials(name, email);
}

// Cloudflare Access exposes the IdP identity (including the Okta display
// name) on the app's own origin. Best effort: fall back to the email.
async function loadDisplayName(email) {
  try {
    const res = await fetch("/cdn-cgi/access/get-identity", { credentials: "same-origin" });
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) return;
    const id = await res.json();
    const name = typeof id.name === "string" ? id.name.trim() : "";
    if (name) showUser(name, email);
  } catch {
    /* keep the email-based fallback */
  }
}

async function init() {
  $("lookup").addEventListener("submit", lookup);

  // Signing out ends the Cloudflare Access session for this app. There is no
  // Access session when running under `wrangler dev`.
  if (["localhost", "127.0.0.1"].includes(location.hostname)) $("signout").hidden = true;

  try {
    const me = await api("/api/me");
    showUser("", me.email);
    loadDisplayName(me.email);
    $("suffix").textContent = `@${me.domain}`;
    document.title = `${me.domain} Address Lookup`;
  } catch (err) {
    setStatus(err.message, "error", err instanceof SessionError);
    return;
  }

  const initial = new URLSearchParams(location.search).get("user");
  if (initial) {
    $("user").value = initial;
    $("lookup").requestSubmit();
  }
}

init();
