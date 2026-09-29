"use strict";
const SITE_BASE = new URL(".", document.currentScript.src);
const PAGES_MODE =
  location.hostname.endsWith(".github.io") ||
  location.pathname.startsWith("/demo/") ||
  new URL(location.href).searchParams.has("pages-demo");
const requestedDemoAccount = new URL(location.href).searchParams.get("account");
const selectedDemoAccount = requestedDemoAccount === "chair" ? "chair" : requestedDemoAccount === "member" ? "alex" : null;
if (selectedDemoAccount)
  sessionStorage.setItem("ato-scholarship-demo-login", selectedDemoAccount);
const demoLogin = selectedDemoAccount || sessionStorage.getItem("ato-scholarship-demo-login") || "alex";
const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
let user,
  rules,
  submissions = [],
  points = {},
  roster = [],
  filter = "all",
  logs = [],
  busy = false;
const modal = $("#modal"),
  main = $("#main"),
  person = $("#persona");
const money = (n) =>
  Number.isInteger(n) ? String(n) : Number(n).toFixed(2).replace(/0$/, "");
const date = (s) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
const status = (s) =>
  `<span class="status ${s}">${s === "pending" ? "Pending review" : s[0].toUpperCase() + s.slice(1)}</span>`;
const activity = (id) => rules.activities.find((a) => a.id === id);
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("visible"), 4000);
}
async function api(path, { method = "GET", body, raw = false } = {}) {
  const start = performance.now();
  let response, payload;
  try {
    response = await fetch(new URL(path.replace(/^\//, ""), SITE_BASE), {
      method,
      credentials: "same-origin",
      headers: {
        ...(user ? { "X-ATO-Expected-User": user.id } : {}),
        ...(method === "POST"
          ? { "Content-Type": "application/json", "X-ATO-Demo": "1" }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    payload = raw ? await response.text() : await response.json();
    logs.unshift({
      method,
      path,
      status: response.status,
      ms: Math.round(performance.now() - start),
      time: new Date().toLocaleTimeString(),
      request: body || null,
      response: payload,
    });
    logs = logs.slice(0, 50);
    if (!response.ok) throw Error(payload.error || "Request failed.");
    return payload;
  } catch (e) {
    if (!response)
      logs.unshift({
        method,
        path,
        status: "Network error",
        ms: Math.round(performance.now() - start),
        time: new Date().toLocaleTimeString(),
        request: body || null,
        response: { error: e.message },
      });
    throw e;
  }
}
function heading(kicker, title, description, action = "") {
  return `<div class="page-heading"><div><p class="eyebrow">${kicker}</p><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
}
function newButton() {
  return '<button class="button gold" data-action="new">+ New submission</button>';
}
function shield() {
  return '<svg width="18" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z"/><path d="m8 12 3 3 5-6"/></svg>';
}
function navigation() {
  const chair = user.role === "chair",
    pending = submissions.filter((s) => s.status === "pending").length;
  const links = chair
    ? [
        ["queue", "Review queue", pending],
        ["members", "Member progress"],
        ["earn", "Point rules"],
        ["access", "Privacy & sign-in"],
      ]
    : [
        ["overview", "Overview"],
        ["submissions", "My submissions"],
        ["earn", "Ways to earn points"],
        ["access", "Privacy & sign-in"],
      ];
  $("#nav").innerHTML = links
    .map(
      ([id, name, count]) =>
        `<a href="#${id}" class="${route() === id ? "active" : ""}">${name}${count ? `<span class="nav-count">${count}</span>` : ""}</a>`,
    )
    .join("");
  $("#header-person").innerHTML =
    `${esc(user.name)}<span>${chair ? "Scholarship chair" : "Member"} demo</span>`;
  $(".account-button").hidden = false;
  $(".account-button .avatar").textContent = user.initials;
  person.value = user.id;
  $(".portal-label").textContent = chair
    ? "CHAIR WORKSPACE"
    : "SCHOLARSHIP PORTAL";
}
function route() {
  let p =
    location.hash.slice(1) || (user?.role === "chair" ? "queue" : "overview");
  if (["canvas", "api"].includes(p)) p = user?.role === "chair" ? "queue" : "overview";
  if (user?.role === "chair" && ["overview", "submissions"].includes(p))
    p = "queue";
  if (user?.role === "member" && ["queue", "members"].includes(p))
    p = "overview";
  return p;
}
async function refresh() {
  const requests = [api("/api/submissions")];
  requests.push(api(user.role === "chair" ? "/api/members" : "/api/points"));
  const [s, p] = await Promise.all(requests);
  submissions = s.submissions;
  if (user.role === "chair") roster = p.members;
  else points = p;
  render();
}
function rows(items, chair = false) {
  if (!items.length)
    return `<div class="empty"><h3>${filter === "pending" ? "YOU’RE ALL CAUGHT UP." : "NO SUBMISSIONS HERE YET."}</h3><p>${chair ? "Try another status to see previous decisions." : "Submit an activity to start building your points."}</p>${chair ? "" : newButton()}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${chair ? "<th>Member</th>" : ""}<th>Activity</th><th>Date</th><th>Status</th><th class="right">Points</th><th class="right">${chair ? "Review" : "Details"}</th></tr></thead><tbody>${items.map((s) => `<tr>${chair ? `<td><strong>${esc(s.memberName)}</strong><small>${s.owner === "alex" ? "Tier 2 · 1.00×" : "Tier 1 · 1.15×"}</small></td>` : ""}<td><strong>${esc(s.title)}</strong><small>${esc(activity(s.activity).name)} · ${esc(s.course)}</small></td><td>${date(s.date)}</td><td>${status(s.status)}</td><td class="right"><strong>${s.status === "approved" ? "+" + s.awarded : s.status === "denied" ? "—" : money(s.estimate) + "*"}</strong></td><td class="right"><button class="table-link" data-action="detail" data-id="${s.id}">${chair && s.status === "pending" ? "Review" : "View"}</button></td></tr>`).join("")}</tbody></table></div>`;
}
function overview() {
  const percent = Math.round((points.approved / points.goal) * 100),
    remaining = Math.max(0, points.goal - points.approved),
    checkpoint = Math.max(0, points.checkpoint - points.approved);
  const approvedWidth = Math.min(100, Math.max(0, (points.approved / points.goal) * 100));
  const pendingWidth = Math.min(100 - approvedWidth, Math.max(0, (points.pendingEstimate / points.goal) * 100));
  main.innerHTML =
    heading(
      "MEMBER ACCOUNT",
      "MY SCHOLARSHIP POINTS",
      "Track submissions, decisions, and approved points.",
      newButton(),
    ) +
    `<div class="overview-grid"><section class="points-panel"><p class="eyebrow">APPROVED POINTS</p><div class="points-number">${points.approved} <span>/ ${points.goal}</span></div><p>Semester goal · Tier ${user.tier}</p><div class="progress" role="progressbar" aria-label="Approved semester points" aria-valuenow="${points.approved}" aria-valuemin="0" aria-valuemax="${Math.max(points.goal, points.approved)}"><span class="progress-approved" style="width:${approvedWidth}%"></span>${points.pending > 0 && pendingWidth > 0 ? `<span class="progress-pending" aria-hidden="true" style="left:${approvedWidth}%;width:${pendingWidth}%"></span>` : ""}</div><div class="points-foot"><span class="points-foot-detail"><span>${remaining ? remaining + " points to your semester goal" : "Semester point goal reached"}</span>${points.pending > 0 ? `<span class="pending-count" aria-label="${money(points.pendingEstimate)} estimated points pending">${money(points.pendingEstimate)} pending</span>` : ""}</span><strong>${percent}%</strong></div></section><section class="panel checkpoint"><p class="eyebrow">NEXT CHECKPOINT</p><h2>OCTOBER 10</h2><p>${points.checkpoint} approved points required</p><div class="checkpoint-status">${checkpoint ? checkpoint + " points to go" : "Checkpoint reached"}</div><p class="muted">Only approved submissions count toward your goal.</p></section></div><div class="stats-row"><div class="mini-stat"><strong>${points.pending}</strong><span><b>Awaiting review</b>${money(points.pendingEstimate)} estimated points</span></div><div class="mini-stat"><strong>${points.approvedCount}</strong><span><b>Approved submissions</b>Counted toward your goal</span></div><div class="mini-stat"><strong>${money(points.multiplier)}×</strong><span><b>Credit-load multiplier</b>${user.credits} enrolled credits</span></div></div><section class="panel recent"><div class="section-heading"><h2>RECENT SUBMISSIONS</h2><a href="#submissions">View all</a></div>${rows(submissions.slice(0, 4))}</section><p class="bottom-note">${shield()}Your member view shows your records. Only the chair reviews academic evidence.</p><p class="footnote">Demo date: September 28, 2026. *Pending estimates are not awarded points.</p>`;
}
function filters() {
  return `<div class="filters" aria-label="Filter submissions">${["all", "pending", "approved", "denied"].map((f) => `<button class="filter ${f === filter ? "active" : ""}" data-action="filter" data-value="${f}" aria-pressed="${f === filter}">${f === "all" ? "All submissions" : f === "pending" ? "Pending review" : f[0].toUpperCase() + f.slice(1)} <span>(${submissions.filter((s) => f === "all" || s.status === f).length})</span></button>`).join("")}</div>`;
}
function submissionPage() {
  main.innerHTML =
    heading(
      "YOUR RECORD",
      "MY SUBMISSIONS",
      "Every activity, decision, and point award in one place.",
      newButton(),
    ) +
    filters() +
    `<section class="panel recent">${rows(submissions.filter((s) => filter === "all" || s.status === filter))}</section><p class="footnote">*Estimates await chair approval. Denied submissions earn no points.</p>`;
}
function queue() {
  const pending = submissions.filter((s) => s.status === "pending"),
    approved = submissions.filter((s) => s.status === "approved");
  main.innerHTML =
    heading(
      "SCHOLARSHIP CHAIR",
      "REVIEW SUBMISSIONS",
      "Approve or deny fictional claims and inspect point totals.",
      '<button class="button ghost" data-action="export">Export submissions</button>',
    ) +
    `<div class="stats-row chair-stats"><div class="mini-stat"><strong>${pending.length}</strong><span><b>Awaiting your review</b>${new Set(pending.map((s) => s.owner)).size} members with pending claims</span></div><div class="mini-stat"><strong>${approved.length}</strong><span><b>Approved this semester</b>${approved.reduce((n, s) => n + s.awarded, 0)} points awarded</span></div><div class="mini-stat"><strong>${roster.filter((m) => m.approved < m.checkpoint).length}</strong><span><b>Below next checkpoint</b>October 10 · no automatic sanctions</span></div></div><div class="notice info"><strong>One review updates the member’s record.</strong> Approve a claim to award points, or deny it with a reason. Members see your decision and note.</div>${filters()}<section class="panel recent"><div class="section-heading"><h2>${filter === "pending" ? "PENDING SUBMISSIONS" : "SUBMISSION REGISTER"}</h2><span class="muted">Fall 2026</span></div>${rows(
      submissions.filter((s) => filter === "all" || s.status === filter),
      true,
    )}</section><p class="bottom-note">${shield()}This fictional account shows the Scholarship Chair review workflow.</p><p class="footnote">*Estimated points. Fractional estimates require an explicit whole-point decision and explanation.</p>`;
}
function membersPage() {
  main.innerHTML =
    heading(
      "CHAPTER PROGRESS",
      "KNOW WHO NEEDS SUPPORT.",
      "Chair view · individual points and checkpoint progress.",
    ) +
    `<section class="panel"><div class="table-wrap"><table><thead><tr><th>Member</th><th>Tier</th><th>Credits</th><th>Approved / goal</th><th>Pending</th><th>Oct 10 target</th></tr></thead><tbody>${roster.map((m) => `<tr><td><div class="table-person"><span class="avatar">${m.initials}</span><div><strong>${esc(m.name)}</strong><small>Fictional member</small></div></div></td><td>Tier ${m.tier}</td><td>${m.credits} · ${money(m.multiplier)}×</td><td><strong>${m.approved} / ${m.goal}</strong><div class="member-progress"><span style="width:${Math.min(100, (m.approved / m.goal) * 100)}%"></span></div></td><td>${m.pending}</td><td><span class="status ${m.approved >= m.checkpoint ? "approved" : "pending"}">${Math.max(0, m.checkpoint - m.approved)} points to go</span></td></tr>`).join("")}</tbody></table></div></section><div class="notice" style="margin-top:24px">Point totals are separate from required study-night attendance. This proof of concept does not determine disciplinary outcomes.</div>`;
}
function earnPage() {
  main.innerHTML =
    heading(
      "2026 SCHOLARSHIP PLAN",
      "POINT RULES",
      "Base points from your chapter plan. Approved credit-load multipliers apply.",
    ) +
    `<div class="notice"><strong>Submit within 14 days.</strong> Include credible evidence. A maximum of five study hours and three minor assignments can be claimed per week. Never claim one activity twice.</div><div class="rules-grid">${rules.activities.map((a) => `<article class="rule-card"><div class="section-heading"><h3>${esc(a.name.toUpperCase())}</h3><span class="rule-points">${a.points} <small>PTS</small></span></div><p>Per ${a.unit}. ${esc(a.proof)}</p>${a.id === "major" ? '<p style="margin-top:10px">95%+: 5 · 90–94.99%: 4 · 85–89.99%: 3 · 80–84.99%: 2</p>' : ""}</article>`).join("")}</div><section class="panel" style="margin-top:24px"><h2>CHECKPOINTS · FALL 2026</h2><div class="table-wrap"><table><thead><tr><th>Tier</th>${rules.checkpoints.map((c) => `<th>${date(c.date)}</th>`).join("")}</tr></thead><tbody>${[1, 2, 3, 4, 5].map((t) => `<tr><td>Tier ${t}${t === 1 ? " / PNM" : ""}</td>${rules.checkpoints.map((c) => `<td>${c.targets[t - 1]}</td>`).join("")}</tr>`).join("")}</tbody></table></div><p class="footnote">Targets are treated as cumulative in this demo. They are not multiplied by credit load.</p></section><div class="notice" style="margin-top:24px"><strong>Policy decisions still needed</strong><p>The plan lists conflicting GPA boundaries for Tiers 3 and 4. It also prohibits fractional points without specifying rounding. This demo uses chair-assigned tiers and requires a note for any adjusted award.</p><p>Weeks run Monday–Sunday for the demo. Only explicit study categories share the study cap; assignment claim dates use the date entered. The chair must confirm these conventions and the end-of-semester closing date before launch.</p></div>`;
}
function accessPage() {
  main.innerHTML =
    heading(
      "MEMBERSHIP & PRIVACY",
      "ACCOUNT ACCESS",
      "The member and chair views have different permissions in the real portal.",
    ) +
    `<div class="notice"><strong>Demo access is simulated.</strong> The public demo buttons select fictional browser-stored records. It does not authenticate a real chapter member or connect to Supabase.</div><div class="flow"><article><div class="step">01</div><h3>CHAPTER LOGIN</h3><p>The planned production login verifies a chapter-managed email and password. Members may use an assigned badge or portal ID as an alias.</p></article><article><div class="step">02</div><h3>APPROVED MEMBERSHIP</h3><p>The portal binds that account to an approved member record. The Scholarship Chair manages invitations and access.</p></article><article><div class="step">03</div><h3>PRIVATE RECORDS</h3><p>The production server checks ownership or chair role on every academic request.</p></article></div><section class="panel"><h2>WHAT EACH ROLE CAN SEE</h2><p><strong>Member:</strong> own submissions, own evidence, approved points, and review notes.</p><p><strong>Scholarship Chair:</strong> member submissions, confidential evidence, review actions, and progress totals.</p></section>`;
}
function apiPage() {
  main.innerHTML =
    heading(
      "WORKING API DEMONSTRATION",
      "SEE WHAT HAPPENS UNDERNEATH.",
      PAGES_MODE
        ? "API-shaped requests handled in this browser by a service worker. No server is running."
        : "Real HTTP requests from this browser to the local demo backend.",
      `<button class="button gold" data-action="ping">${PAGES_MODE ? 'Run a demo request' : 'Run a live request'}</button>`,
    ) +
    `<div class="integration-grid"><section class="panel"><span class="status approved">${PAGES_MODE ? "Browser simulation" : "Live demo API"}</span><h3 style="margin-top:16px">SUBMISSIONS & POINTS</h3><p>${PAGES_MODE ? "Service-worker requests, browser rules, IndexedDB records, and simulated role checks." : "HTTP endpoints, server-side rules, SQLite records, review history, and role checks."}</p></section><section class="panel"><span class="status pending">Not connected</span><h3 style="margin-top:16px">CHAPTER LOGIN</h3><p>The real chapter account system is separate from this demo.</p></section><section class="panel"><span class="status pending">Not connected</span><h3 style="margin-top:16px">CANVAS / DRIVE / GRAPH</h3><p>Sample Canvas import is available. Live provider access is not connected. CSV export works now.</p></section></div><section class="panel"><div class="section-heading"><h2>REQUEST LOG <span class="review-count">${logs.length} requests</span></h2><button class="text-btn" data-action="clear-log">Clear log</button></div><p class="footnote">Select a request to inspect its actual payload and response. Cookies and credentials are not logged.</p><div class="api-log">${logs.map((l, i) => `<button class="api-row" data-action="request-detail" data-index="${i}"><span class="http-method">${l.method}</span><code>${esc(l.path)}</code><span class="http-status ${Number(l.status) >= 400 ? "bad" : ""}">${esc(l.status)}</span><span class="muted">${l.ms} ms</span></button>`).join("") || '<p class="muted">No requests yet. Run a live request above.</p>'}</div></section><div class="overview-grid" style="margin-top:24px"><section class="panel"><h2>TRY AN ACCESS CHECK</h2><p>${PAGES_MODE ? "The simulation scopes records to the selected demo member and demonstrates rejected requests. Browser checks are not a security boundary." : "The backend scopes records to the selected demo member and rejects chair-only actions from a member role."}</p><button class="button ghost" data-action="access-check" ${user.role === "chair" ? "disabled" : ""}>Test another member’s record</button><p class="footnote" style="margin-top:12px">${user.role === "chair" ? "Sign out and use the member demo account to try an access check." : "Expected result: 404. Another member’s record is not returned."}</p></section><section class="panel"><h2>WHAT THIS PROVES</h2><p>${PAGES_MODE ? "This hosted version demonstrates the workflow without a backend. The demo buttons select fictional roles, and records stay in this browser." : "The submission and review flow uses a real backend. Role checks are implemented, but switching identities is intentionally open in the demo."}</p><p class="footnote">This is not production authentication. ${PAGES_MODE ? "Fictional records persist only in this browser’s IndexedDB. They are not shared across devices." : "Fictional records persist in the local SQLite database during that session."}</p></section></div>`;
}
function render() {
  if (PAGES_MODE)
    document.querySelector(".demo-bar > span").innerHTML =
      "<strong>LIVE SITE DEMO</strong> Fictional data · browser-simulated API · no chapter account needed";
  if (!user || !rules) return;
  navigation();
  (
    ({
      overview,
      submissions: submissionPage,
      queue,
      members: membersPage,
      earn: earnPage,
      canvas: canvasPage,
      access: accessPage,
      api: apiPage,
    })[route()] || overview
  )();
}
function openModal(title, subtitle, body) {
  $("#modal-content").innerHTML =
    `<div class="modal-heading"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ""}</div><button class="close" data-action="close" aria-label="Close dialog">×</button></div>${body}`;
  if (!modal.open) modal.showModal();
}
function formError(message) {
  let e = $("#form-error");
  if (!e) {
    e = document.createElement("div");
    e.id = "form-error";
    e.className = "error";
    e.setAttribute("role", "alert");
    $("#modal-content").append(e);
  }
  e.textContent = message;
  e.scrollIntoView({ block: "nearest" });
}
function activityPicker() {
  const first = rules.activities[0];
  return `<div class="activity-picker"><input id="activity-search" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="activity-options" value="${esc(first.name)}" autocomplete="off" required><button id="activity-open" type="button" aria-label="Show activity types">▾</button><div id="activity-options" class="activity-options" role="listbox" hidden></div><input id="activity" name="activity" type="hidden" value="${esc(first.id)}"></div><small>Type to find an activity or open the list.</small>`;
}
function wireActivityPicker() {
  const search = $("#activity-search"), selected = $("#activity"),
    menu = $("#activity-options"), picker = search.closest(".activity-picker");
  let matches = [], active = 0;
  function close() {
    menu.hidden = true;
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
  }
  function highlight() {
    menu.querySelectorAll("[role=option]").forEach((option, index) => {
      option.classList.toggle("active", index === active);
      option.setAttribute("aria-selected", String(index === active));
    });
    if (matches.length) search.setAttribute("aria-activedescendant", `activity-option-${active}`);
    else search.removeAttribute("aria-activedescendant");
  }
  function open(all = false) {
    const query = search.value.trim().toLowerCase();
    matches = rules.activities.filter((a) => all || a.name.toLowerCase().includes(query));
    active = Math.max(0, matches.findIndex((a) => a.id === selected.value));
    menu.innerHTML = matches.length
      ? matches.map((a, index) => `<button id="activity-option-${index}" type="button" role="option" data-id="${esc(a.id)}">${esc(a.name)}</button>`).join("")
      : '<div class="activity-empty">No matching activity</div>';
    menu.hidden = false;
    search.setAttribute("aria-expanded", "true");
    highlight();
  }
  function choose(index) {
    const match = matches[index];
    if (!match) return;
    search.value = match.name;
    selected.value = match.id;
    close();
    updateForm();
    search.focus();
  }
  search.addEventListener("input", () => {
    const match = rules.activities.find((a) => a.name.toLowerCase() === search.value.trim().toLowerCase());
    selected.value = match?.id || "";
    updateForm();
    open();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { close(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (menu.hidden) open();
      else if (matches.length) {
        active = (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
        highlight();
      }
    }
    if (event.key === "Enter" && !menu.hidden && matches.length) {
      event.preventDefault();
      choose(active);
    }
  });
  $("#activity-open").addEventListener("click", () => {
    search.focus();
    if (menu.hidden) open(true);
    else close();
  });
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[role=option]");
    if (option) choose(matches.findIndex((a) => a.id === option.dataset.id));
  });
  picker.addEventListener("focusout", (event) => {
    if (!picker.contains(event.relatedTarget)) close();
  });
}
function newSubmission() {
  if (user.role !== "member") return;
  openModal(
    "SUBMIT YOUR EFFORT",
    "Add a fictional activity for the Scholarship Chair to review.",
    `<form id="claim-form"><div class="form-grid"><div class="field span2"><label for="activity-search">Activity type</label>${activityPicker()}</div><div class="field span2"><label for="title">Assignment or activity title</label><input id="title" name="title" required maxlength="120" placeholder="e.g. Calculus II · Quiz 4"></div><div class="field"><label for="course">Course</label><input id="course" name="course" required maxlength="80" placeholder="e.g. MTH 2002"></div><div class="field"><label for="date">Activity date</label><input id="date" name="date" type="date" value="2026-09-28" min="2026-09-14" max="2026-09-28" required><small>Demo date: September 28, 2026.</small></div><div id="dynamic-field" class="field span2"></div></div><div class="preview-points"><div>Estimated points<small>Only awarded after chair approval · ${money(points.multiplier)}× credit multiplier</small></div><strong id="estimate">—</strong></div><div class="field"><label>Supporting evidence</label><p id="proof-hint" class="footnote"></p><div id="attachment" class="attachment"><p>Use a fictional sample for this demonstration. Real file uploads are not enabled.</p><button class="button ghost small" type="button" data-action="sample">Attach sample evidence</button></div><input id="evidence" name="evidence" type="hidden" value=""></div><div class="field"><label for="note">Note for the chair <span class="muted">(optional)</span></label><textarea id="note" name="note" maxlength="1000" placeholder="Any details that help verify the activity."></textarea></div><label class="checkbox-line"><input type="checkbox" name="confirm" required><span>This is a new activity, and I have not claimed it under another category.</span></label><div id="form-error" role="alert"></div><div class="modal-actions"><button class="button ghost" type="button" data-action="close">Cancel</button><button class="button gold" type="submit">Submit for review</button></div></form>`,
  );
  wireActivityPicker();
  $("#claim-form").addEventListener("input", estimate);
  $("#claim-form").addEventListener("submit", submitClaim);
  updateForm();
}
function updateForm() {
  const a = activity($("#activity").value);
  if (!a) {
    $("#proof-hint").textContent = "Choose an activity type from the list.";
    $("#dynamic-field").innerHTML = "";
    $("#estimate").textContent = "—";
    return;
  }
  $("#proof-hint").textContent = a.proof;
  $("#dynamic-field").innerHTML = a.grade
    ? '<label for="grade">Grade (%)</label><input id="grade" name="grade" type="number" min="0" max="100" step="0.01" value="95" required>'
    : a.hours
      ? '<label for="quantity">Hours completed</label><input id="quantity" name="quantity" type="number" min="0.01" max="24" step="0.01" value="1" required>'
      : "";
  estimate();
}
function estimate() {
  const form = $("#claim-form");
  if (!form) return;
  const data = Object.fromEntries(new FormData(form)),
    a = activity(data.activity),
    g = Number(data.grade),
    q = Number(data.quantity || 1);
  if (!a) {
    $("#estimate").textContent = "—";
    return;
  }
  let base =
    a.id === "major"
      ? g >= 95
        ? 5
        : g >= 90
          ? 4
          : g >= 85
            ? 3
            : g >= 80
              ? 2
              : 0
      : a.grade
        ? g >= 90
          ? 2
          : 0
        : Number(a.points) * (a.hours ? q : 1);
  const total = Math.round(base * points.multiplier * 100) / 100;
  $("#estimate").textContent = money(total);
}
async function submitClaim(e) {
  e.preventDefault();
  if (!$("#activity").value) {
    formError("Choose an activity type from the list.");
    $("#activity-search").focus();
    return;
  }
  if (busy) return;
  busy = true;
  const button = e.submitter;
  button.disabled = true;
  const data = Object.fromEntries(new FormData(e.target));
  data.confirm = data.confirm === "on";
  if (data.grade) data.grade = Number(data.grade);
  if (data.quantity) data.quantity = Number(data.quantity);
  try {
    await api("/api/submissions", { method: "POST", body: data });
    modal.close();
    filter = "pending";
    location.hash = "submissions";
    await refresh();
    toast("Submitted. Sign out and enter as Chair to review it in this browser.");
  } catch (err) {
    formError(err.message);
  } finally {
    busy = false;
    button.disabled = false;
  }
}
async function detail(id) {
  try {
    const { submission: s } = await api(
      "/api/submissions/" + encodeURIComponent(id),
    );
    const a = activity(s.activity),
      canReview = user.role === "chair" && s.status === "pending";
    openModal(
      canReview ? "REVIEW SUBMISSION" : "SUBMISSION DETAILS",
      `${esc(s.id)} · ${esc(s.memberName)}`,
      `<div class="section-heading"><h3>${esc(s.title)}</h3>${status(s.status)}</div><dl class="details"><div><dt>Activity</dt><dd>${esc(a.name)}</dd></div><div><dt>Course</dt><dd>${esc(s.course)}</dd></div><div><dt>Activity date</dt><dd>${date(s.date)}, 2026</dd></div><div><dt>${s.status === "approved" ? "Awarded points" : "Estimated points"}</dt><dd>${s.status === "approved" ? s.awarded : money(s.estimate)}${s.status === "pending" ? " · not yet awarded" : ""}</dd></div>${s.grade !== null ? `<div><dt>Grade</dt><dd>${s.grade}%</dd></div>` : ""}${a.hours ? `<div><dt>Hours</dt><dd>${s.quantity}</dd></div>` : ""}</dl>${s.source === "canvas-sample" ? '<div class="notice info"><strong>Canvas sample import</strong> Assignment category was selected by the member. Verify its individual course weight before approving.</div>' : ""}<h3>SUPPORTING EVIDENCE</h3><div class="sample-file"><span class="file-symbol">▤</span><div><strong>Fictional activity record</strong><small>Generated demo evidence · no real student file</small></div><button class="table-link" style="margin-left:auto" data-action="evidence" data-id="${s.id}">Open</button></div><div id="evidence-preview"></div><p class="footnote" style="margin-top:12px">Required: ${esc(a.proof)}</p>${s.note ? `<div class="review-note"><strong>Member note</strong><br>${esc(s.note)}</div>` : ""}${canReview ? `<form id="review-form" data-id="${s.id}"><div class="subtle-rule"></div><div class="field"><label for="award">Points to award</label><input id="award" name="points" type="number" min="0" max="100" step="1" ${Number.isInteger(s.estimate) ? `value="${s.estimate}"` : 'placeholder="Enter a whole-point award"'}><small>Base ${money(s.base)} × credit multiplier = ${money(s.estimate)} estimated. ${Number.isInteger(s.estimate) ? "Explain any adjustment." : "Rounding is undefined in the plan. Record a whole-point decision and explain it."}</small></div><div class="field"><label for="review-note">Review note</label><textarea id="review-note" name="note" maxlength="1000" placeholder="Required for a denial or point adjustment. Visible to the member."></textarea></div><div id="form-error" role="alert"></div><div class="modal-actions"><button type="submit" name="decision" value="denied" formnovalidate class="button danger">Deny submission</button><button type="submit" name="decision" value="approved" class="button gold">Approve & award points</button></div></form>` : `${s.reviewNote ? `<div class="review-note" style="margin-top:18px"><strong>Chair’s note</strong><br>${esc(s.reviewNote)}</div>` : ""}<div class="history">${s.history.map((h) => `<p><strong>${esc(h.event)}</strong><small>${new Date(h.at).toLocaleString()}${h.by ? " · " + esc(h.by) : ""}</small></p>`).join("")}</div><div class="modal-actions"><button class="button ghost" data-action="close">Close</button></div>`}`,
    );
    if (canReview) $("#review-form").addEventListener("submit", review);
  } catch (e) {
    toast(e.message);
  }
}
async function review(e) {
  e.preventDefault();
  if (busy) return;
  const decision = e.submitter.value,
    form = e.target,
    data = Object.fromEntries(new FormData(form));
  busy = true;
  form.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await api(
      "/api/submissions/" + encodeURIComponent(form.dataset.id) + "/review",
      {
        method: "POST",
        body: {
          decision,
          points: data.points === "" ? null : Number(data.points),
          note: data.note,
        },
      },
    );
    modal.close();
    await refresh();
    toast(
      decision === "approved"
        ? "Approved. The member’s point total has been updated."
        : "Denied. The member can see your reason.",
    );
  } catch (err) {
    formError(err.message);
  } finally {
    busy = false;
    form.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}
async function evidence(id) {
  try {
    const { evidence: e } = await api(
      "/api/submissions/" + encodeURIComponent(id) + "/evidence",
    );
    $("#evidence-preview").innerHTML =
      `<div class="evidence-sheet"><div class="sample-stamp">FICTIONAL SAMPLE · FOR DEMONSTRATION</div><h3>${esc(e.title)}</h3><p>${esc(e.course)} · ${date(e.date)}, 2026</p>${e.grade !== null ? `<p><strong>Recorded grade: ${e.grade}%</strong></p>` : `<p><strong>Recorded activity: ${esc(e.activity)}</strong></p>`}<p class="muted">${esc(e.verification)}</p></div>`;
  } catch (e) {
    toast(e.message);
  }
}
async function switchUser(id) {
  person.disabled = true;
  try {
    const result = await api("/api/demo/session", {
      method: "POST",
      body: { persona: id },
    });
    user = result.user;
    logs = [];
    filter = user.role === "chair" ? "pending" : "all";
    submissions = [];
    roster = [];
    points = {};
    main.innerHTML = '<p role="status">Loading the selected demo account…</p>';
    await refresh();
    location.hash = user.role === "chair" ? "queue" : "overview";
    toast("Now viewing " + user.name + "’s demo account.");
  } catch (e) {
    toast(e.message);
    person.value = user.id;
  } finally {
    person.disabled = false;
  }
}
function identity(provider) {
  openModal(
    `${provider.toUpperCase()} SIGN-IN PREVIEW`,
    "This demonstration does not connect to your university.",
    `<div class="notice info"><strong>In the live version</strong><p>You would sign in on ${provider}’s own page. This portal would never ask for your university password.</p></div><ol><li>Verify the signed token and the allowed ${provider === "Microsoft" ? "university tenant" : "university domain"} on the server.</li><li>Match the verified identity to an approved chapter member.</li><li>Issue a secure session and apply member or chair permissions to every request.</li></ol><p>The demo uses a freely switchable sample identity instead. No ${provider} token or profile was requested.</p><div class="modal-actions"><button class="button gold" data-action="close">Back to demo</button></div>`,
  );
}
async function handleAction(e) {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const action = b.dataset.action;
  try {
    if (action === "logout") {
      sessionStorage.removeItem("ato-scholarship-demo-login");
      location.assign("/");
    } else if (action === "new") newSubmission();
    else if (action === "close") modal.close();
    else if (action === "detail") await detail(b.dataset.id);
    else if (action === "evidence") await evidence(b.dataset.id);
    else if (action === "filter") {
      filter = b.dataset.value;
      render();
    } else if (action === "sample") {
      $("#evidence").value = "sample";
      $("#attachment").innerHTML =
        '<div class="sample-file"><span>▤</span><div><strong>Sample evidence attached</strong><small>Fictional activity record · previewable by the chair</small></div></div>';
    } else if (action === "account") {
      openModal(
        "DEMO ACCOUNT",
        esc(user.name),
        `<p>You are viewing the ${user.role === "chair" ? "Scholarship Chair" : "member"} workflow as a fictional user. Sign out to try the other account.</p><p class="muted">This demo contains no real chapter records. Chapter sign-in is separate.</p><div class="modal-actions"><button class="button ghost" data-action="logout">Sign out</button><button class="button gold" data-action="close">Close</button></div>`,
      );
    } else if (action === "identity") identity(b.dataset.provider);
    else if (action === "reset") {
      openModal(
        "RESET THE DEMONSTRATION?",
        "Only this demo session’s fictional records will be reset.",
        `<p>This restores the sample submissions and point totals. It does not touch Google, Microsoft, or any chapter records.</p><div class="modal-actions"><button class="button ghost" data-action="close">Cancel</button><button class="button gold" data-action="confirm-reset">Reset demo</button></div>`,
      );
    } else if (action === "confirm-reset") {
      await api("/api/demo/reset", { method: "POST", body: {} });
      modal.close();
      await refresh();
      toast("Sample records restored.");
    } else if (action === "ping") {
      await api("/api/me");
      apiPage();
      toast(PAGES_MODE ? "Browser demo request completed. Select it to see the response." : "Live request completed. Select it to see the response.");
    } else if (action === "clear-log") {
      logs = [];
      apiPage();
    } else if (action === "request-detail") {
      const l = logs[Number(b.dataset.index)];
      openModal(
        "API REQUEST",
        `${l.method} ${esc(l.path)} · ${esc(l.status)} · ${l.ms} ms`,
        `<h3>REQUEST BODY</h3><pre>${esc(l.request ? JSON.stringify(l.request, null, 2) : "No request body")}</pre><h3>RESPONSE BODY</h3><pre>${esc(typeof l.response === "string" ? l.response : JSON.stringify(l.response, null, 2))}</pre><div class="modal-actions"><button class="button ghost" data-action="close">Close</button></div>`,
      );
    } else if (action === "access-check") {
      try {
        await api(
          "/api/submissions/" + (user.id === "alex" ? "S-2001" : "S-1001"),
        );
        toast("Unexpected: the request returned a record.");
      } catch (err) {
        toast("Access check: " + err.message + " (404)");
      }
      apiPage();
    } else if (action === "load-canvas") {
      await loadCanvas();
    } else if (action === "canvas-submit") {
      await importCanvas();
    } else if (action === "export") {
      const csv = await api("/api/export", { raw: true });
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "ato-demo-submissions.csv";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("CSV export downloaded.");
    }
  } catch (err) {
    toast(err.message);
  }
}
document.addEventListener("click", handleAction);
person.addEventListener("change", () => {
  if (!location.pathname.startsWith("/demo/")) switchUser(person.value);
});
window.addEventListener("hashchange", render);
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.close();
});
async function init() {
  try {
    const requested = location.pathname.startsWith("/demo/")
      ? demoLogin
      : new URL(location.href).searchParams.get("view");
    const result = await api("/api/demo/session", {
      method: "POST",
      body:
        requested && ["chair", "alex", "jordan"].includes(requested)
          ? { persona: requested }
          : {},
    });
    if (requested) {
      const clean = new URL(location.href);
      clean.searchParams.delete("view");
      clean.searchParams.delete("account");
      history.replaceState(null, "", clean);
    }
    user = result.user;
    if (location.pathname.startsWith("/demo/")) {
      person.disabled = true;
      document.querySelector(".sidebar-bottom p").textContent = "Sign out to try the other demo account.";
    }
    rules = await api("/api/rules");
    filter = user.role === "chair" ? "pending" : "all";
    await refresh();
    registerTools();
  } catch (err) {
    main.innerHTML =
      heading(
        "DEMO SERVICE",
        "LET’S RECONNECT.",
        "The local backend is not available.",
      ) +
      `<div class="error">${esc(err.message)}</div><button class="button gold" id="retry">Try again</button>`;
    $("#retry").onclick = init;
  }
}
function registerTools() {
  if (!document.modelContext?.registerTool) return;
  const lifecycle = new AbortController();
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
  const tool = {
    name: "get_scholarship_demo_records",
    title: "Read current scholarship demo records",
    description:
      "Read the visible demo persona’s submissions through the same API used by the interface. Does not change roles or records.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(input) {
      if (!input || typeof input !== "object" || Object.keys(input).length)
        throw Error("Expected an empty object.");
      const result = await api("/api/submissions");
      submissions = result.submissions;
      if (route() === "api") apiPage();
      return { persona: user.id, submissions: result.submissions };
    },
  };
  try {
    Promise.resolve(
      document.modelContext.registerTool(tool, { signal: lifecycle.signal }),
    ).catch(() => {});
  } catch {}
}
startApp();

function canvasPage() {
  main.innerHTML =
    heading(
      "LESS MANUAL ENTRY",
      "BRING YOUR WORK WITH YOU.",
      "Import graded Canvas assignments, choose a category, and send them for review.",
    ) +
    `<div class="notice"><strong>Canvas sample mode · not connected to Florida Tech.</strong><p>The API returns fictional Canvas-shaped records. Real Canvas access requires a university-approved OAuth developer key and each member’s authorization. Microsoft sign-in alone does not grant Canvas access.</p></div><div class="flow"><article><div class="step">01</div><h3>LOAD GRADED WORK</h3><p>Read only the signed-in member’s assignments and released grades from selected courses.</p></article><article><div class="step">02</div><h3>CONFIRM THE CATEGORY</h3><p>Choose major, minor, or lab. A Canvas assignment group does not establish an individual assignment’s course weight.</p></article><article><div class="step">03</div><h3>CHAIR REVIEWS</h3><p>Import creates pending submissions. Points are awarded only after the chair approves.</p></article></div><section class="panel"><div class="section-heading"><h2>CANVAS ASSIGNMENTS</h2><button class="button gold" data-action="load-canvas" ${user.role !== "member" ? "disabled" : ""}>Load sample assignments</button></div><div id="canvas-results"><p class="muted">${user.role === "member" ? "Load the sample to try an import. Existing imports are detected to prevent duplicate claims." : "Switch to a member view to try importing that member’s assignments."}</p></div></section><p class="footnote">Demo convention: grade-posting date starts the 14-day claim window. This interpretation must be confirmed by the Scholarship Chair before launch.</p>`;
}
async function loadCanvas() {
  try {
    const response = await api("/api/integrations/canvas/assignments");
    $("#canvas-results").innerHTML =
      `<div class="table-wrap"><table><thead><tr><th>Select</th><th>Assignment</th><th>Grade</th><th>Category</th><th>Grade posted</th></tr></thead><tbody>${response.assignments.map((a) => `<tr><td><input class="canvas-select" type="checkbox" value="${a.id}" aria-label="Select ${esc(a.name)}" ${a.imported ? "disabled" : ""}></td><td><strong>${esc(a.name)}</strong><small>${esc(a.course)}${a.imported ? " · Already imported" : ""}</small></td><td>${a.percent}%<small>${a.submission.score} / ${a.points_possible}</small></td><td><select id="category-${a.id}" aria-label="Category for ${esc(a.name)}" ${a.imported ? "disabled" : ""}><option value="">Choose category</option><option value="major">Major assignment</option><option value="minor">Minor assignment</option><option value="lab">Lab report</option></select></td><td>${date(a.submission.graded_at.slice(0, 10))}</td></tr>`).join("")}</tbody></table></div><label class="checkbox-line"><input id="canvas-confirm" type="checkbox"><span>I have checked the individual assignment categories and have not claimed these activities elsewhere.</span></label><div id="canvas-error" role="alert"></div><div class="section-heading"><p class="footnote">Sample records only. No Canvas credentials are needed.</p><button class="button gold" data-action="canvas-submit">Import selected for review</button></div>`;
  } catch (e) {
    toast(e.message);
  }
}
async function importCanvas() {
  const selected = [...document.querySelectorAll(".canvas-select:checked")].map(
    (el) => ({
      assignmentId: Number(el.value),
      activity: $("#category-" + el.value).value,
    }),
  );
  const err = $("#canvas-error");
  err.className = "";
  err.textContent = "";
  if (
    !selected.length ||
    selected.some((s) => !s.activity) ||
    !$("#canvas-confirm").checked
  ) {
    err.className = "error";
    err.textContent =
      "Select at least one assignment, choose each category, and confirm the statement.";
    return;
  }
  const btn = $('[data-action="canvas-submit"]');
  btn.disabled = true;
  try {
    const result = await api("/api/integrations/canvas/import", {
      method: "POST",
      body: { items: selected, confirm: true },
    });
    await refresh();
    await loadCanvas();
    toast(
      result.imported.length + " Canvas sample assignment(s) sent for review.",
    );
  } catch (e) {
    err.className = "error";
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function startApp() {
  if (PAGES_MODE) {
    try {
      if (!("serviceWorker" in navigator))
        throw Error("This browser does not support the hosted demo.");
      await navigator.serviceWorker.register(
        new URL("demo-worker.js", SITE_BASE),
        { scope: SITE_BASE.pathname, type: "module" },
      );
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise((resolve) =>
          navigator.serviceWorker.addEventListener(
            "controllerchange",
            resolve,
            { once: true },
          ),
        );
    } catch (e) {
      main.innerHTML = '<div class="error">' + esc(e.message) + "</div>";
      return;
    }
  }
  await init();
}
