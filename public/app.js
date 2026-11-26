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

// "Reload to sign in again": a real full-page reload, so an expired
// Cloudflare Access session is sent back through sign-in. A plain link to the
// same URL + #fragment would only do same-document navigation.
function reloadLink() {
  const a = document.createElement("a");
  a.href = location.href;
  a.textContent = "Reload to sign in again";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    location.reload();
  });
  return a;
}

function setStatus(text, kind = "", withReload = false) {
  const el = $("status");
  el.className = `status ${kind}`.trim();
  el.textContent = text;
  if (withReload) {
    el.append(" ", reloadLink());
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

// ---------- Views (hash routing: #/lookup, #/sweep) ----------

const VIEWS = { lookup: "Address Lookup", sweep: "Org Sweep" };

function currentView() {
  const v = location.hash.replace(/^#\/?/, "");
  return Object.hasOwn(VIEWS, v) ? v : "lookup";
}

function showView() {
  const view = currentView();
  for (const panel of document.querySelectorAll("[data-view-panel]")) {
    panel.hidden = panel.dataset.viewPanel !== view;
  }
  for (const link of document.querySelectorAll(".nav-item[data-view]")) {
    const active = link.dataset.view === view;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.title = `linux.com ${VIEWS[view]}`;
  if (view === "lookup") $("user").focus();
}

// ---------- Org sweep ----------

let sweepReport = null;

function setSweepStatus(text, kind = "", withReload = false) {
  const el = $("sweep-status");
  el.className = `status ${kind}`.trim();
  el.textContent = text;
  if (withReload) {
    el.append(" ", reloadLink());
  }
}

function stat(label, value, tone = "") {
  const div = document.createElement("div");
  div.className = `stat ${tone}`.trim();
  const v = document.createElement("div");
  v.className = "stat-value";
  v.textContent = String(value);
  const l = document.createElement("div");
  l.className = "stat-label";
  l.textContent = label;
  div.append(v, l);
  return div;
}

function cell(tr, ...nodes) {
  const td = document.createElement("td");
  for (const n of nodes) td.append(n);
  tr.append(td);
  return td;
}

function text(t, cls) {
  const s = document.createElement("div");
  if (cls) s.className = cls;
  s.textContent = t;
  return s;
}

function pill(t, tone) {
  const s = document.createElement("span");
  s.className = `pill ${tone}`;
  s.textContent = t;
  return s;
}

function sweepRowsShown() {
  if (!sweepReport) return [];
  const q = $("sweep-filter").value.trim().toLowerCase();
  const elsewhereOnly = $("sweep-elsewhere").checked;
  return sweepReport.matches.filter((m) => {
    if (elsewhereOnly && m.forwardsToUser) return false;
    if (!q) return true;
    return [m.googleUser, m.googleName, m.googleAddress, m.forwardEmailAlias, m.orgUnit, ...m.forwardEmailRecipients]
      .some((v) => v && String(v).toLowerCase().includes(q));
  });
}

function renderSweepRows() {
  const rows = sweepRowsShown();
  const tbody = $("sweep-rows");
  tbody.replaceChildren();
  for (const m of rows) {
    const tr = document.createElement("tr");
    cell(tr, text(m.googleName || "—", "strong"), text(m.googleUser, "sub"));
    cell(tr, text(m.googleAddress), pill(m.addressType === "primary" ? "Primary" : "Alias", "neutral"));
    const alias = cell(tr, text(m.forwardEmailAlias));
    if (m.forwardEmailEnabled === false) alias.append(pill("Disabled", "neutral"));
    const fwd = cell(tr);
    if (m.forwardEmailRecipients.length) for (const r of m.forwardEmailRecipients) fwd.append(text(r));
    else fwd.append(text("—", "sub"));
    cell(tr, m.forwardsToUser ? pill("Yes", "ok") : pill("No — elsewhere", "warn"));
    cell(tr, text(m.orgUnit || "—", "sub"));
    tbody.append(tr);
  }
  const total = sweepReport ? sweepReport.matches.length : 0;
  $("sweep-count").textContent = rows.length === total ? `${total} rows` : `${rows.length} of ${total} rows`;
  $("sweep-empty").hidden = rows.length > 0;
}

function renderSweep(report) {
  sweepReport = report;
  const s = report.stats;
  for (const el of document.querySelectorAll(".sweep-gdomain")) el.textContent = `@${report.googleDomain}`;
  for (const el of document.querySelectorAll(".sweep-fdomain")) el.textContent = `@${report.forwardEmailDomain}`;
  $("sweep-generated").textContent = new Date(report.generatedAt).toLocaleString();
  $("sweep-stats").replaceChildren(
    stat("Active Google accounts", s.activeGoogleUsers),
    stat(`@${report.googleDomain} addresses checked`, s.googleAddressesChecked),
    stat(`${report.forwardEmailDomain} aliases`, s.forwardEmailAliases),
    stat("Matches", s.matches, s.matches ? "accent" : ""),
    stat("Forwarding elsewhere", s.matchesForwardingElsewhere, s.matchesForwardingElsewhere ? "warn" : ""),
  );
  const notes = [];
  if (s.forwardEmailAliasesSkipped) {
    notes.push(`${s.forwardEmailAliasesSkipped} catch-all/regex ForwardEmail aliases can't be matched by name and were not compared.`);
  }
  if (s.forwardEmailReportedTotal !== null && s.forwardEmailReportedTotal !== s.forwardEmailAliases) {
    notes.push(`ForwardEmail reported ${s.forwardEmailReportedTotal} aliases but ${s.forwardEmailAliases} were read; the report may be incomplete.`);
  }
  notes.push(`Took ${(s.durationMs / 1000).toFixed(1)} s (${s.googlePages} Google pages, ${s.forwardEmailPages} ForwardEmail pages).`);
  $("sweep-note").textContent = notes.join(" ");
  $("sweep-results").hidden = false;
  $("sweep-csv").disabled = false;
  renderSweepRows();
}

async function runSweep() {
  $("sweep-run").disabled = true;
  $("sweep-csv").disabled = true;
  setSweepStatus("Running sweep… reading every active Google account and every linux.com alias. This can take a minute.", "busy");
  try {
    renderSweep(await api("/api/sweep"));
    setSweepStatus("");
  } catch (err) {
    setSweepStatus(err.message, "error", err instanceof SessionError);
    $("sweep-csv").disabled = !sweepReport;
  } finally {
    $("sweep-run").disabled = false;
  }
}

// CSV with every cell quoted. Cells that a spreadsheet could treat as a
// formula are prefixed with ' (CSV injection): a leading = + - @, tab, CR or
// LF (OWASP's list), plus the full-width ＝ ＋ － ＠ forms some apps accept.
const CSV_FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/;
function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (CSV_FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function sweepCsv(report) {
  const header = [
    "google_account", "google_name", "org_unit", "matching_address", "address_type",
    "linux_com_alias", "alias_enabled", "forwards_to", "forwards_to_this_user", "alias_description", "alias_labels",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const m of report.matches) {
    lines.push([
      m.googleUser, m.googleName, m.orgUnit, m.googleAddress, m.addressType,
      m.forwardEmailAlias, m.forwardEmailEnabled === null ? "" : m.forwardEmailEnabled ? "yes" : "no",
      m.forwardEmailRecipients.join("; "), m.forwardsToUser ? "yes" : "no",
      m.forwardEmailDescription, m.forwardEmailLabels.join("; "),
    ].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function downloadSweepCsv() {
  if (!sweepReport) return;
  const blob = new Blob(["﻿", sweepCsv(sweepReport)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `linuxcom-org-sweep-${sweepReport.generatedAt.slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function init() {
  $("lookup").addEventListener("submit", lookup);
  $("sweep-run").addEventListener("click", runSweep);
  $("sweep-csv").addEventListener("click", downloadSweepCsv);
  $("sweep-filter").addEventListener("input", renderSweepRows);
  $("sweep-elsewhere").addEventListener("change", renderSweepRows);
  window.addEventListener("hashchange", showView);
  showView();

  // Signing out ends the Cloudflare Access session for this app. There is no
  // Access session when running under `wrangler dev`.
  if (["localhost", "127.0.0.1"].includes(location.hostname)) $("signout").hidden = true;

  try {
    const me = await api("/api/me");
    showUser("", me.email);
    loadDisplayName(me.email);
    $("suffix").textContent = `@${me.domain}`;
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
