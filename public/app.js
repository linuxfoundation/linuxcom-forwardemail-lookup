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
  card.classList.remove("found", "missing", "error");

  if (result.error) {
    card.classList.add("error");
    badge.textContent = "Error";
    row(dl, "Details", result.error);
    return;
  }
  if (!result.found) {
    card.classList.add("missing");
    badge.textContent = "Not found";
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

async function init() {
  $("lookup").addEventListener("submit", lookup);

  try {
    const me = await api("/api/me");
    $("whoami").textContent = me.email;
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
