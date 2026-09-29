"use strict";
let appConfig = { mode: "demo", providers: [], canvasConfigured: false },
  sessionEpoch = 0,
  csrfToken = null,
  canvasConnected = false,
  accountToken = null;
const isDemo = () => appConfig.mode === "demo";
const redact = (value) =>
  JSON.parse(
    JSON.stringify(value, (key, val) =>
      /csrf|token|secret|password|recovery|base64|authorization|uploadUrl|downloadUrl|signedUrl/i.test(
        key,
      ) ||
      (typeof val === "string" &&
        /[?&](token|signature|access_token)=/i.test(val))
        ? "[redacted]"
        : val,
    ),
  );
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
const checkpointDate = () =>
  points.checkpointDate ||
  rules.checkpoints.find((c) => c.date >= rules.today)?.date ||
  rules.checkpoints.at(-1).date;
const canvasDate = (timestamp) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: appConfig.semester?.timeZone || "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
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
  const epoch = sessionEpoch,
    owner = user?.id,
    csrf = csrfToken;
  const current = () =>
    epoch === sessionEpoch && owner === user?.id && csrf === csrfToken;
  let response, payload;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(user ? { "X-ATO-Expected-User": user.id } : {}),
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        ...(method === "POST"
          ? { "Content-Type": "application/json", "X-ATO-Demo": "1" }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    payload = raw ? await response.text() : await response.json();
    if (!current())
      throw Error("Account changed. Refresh this view to continue.");
    logs.unshift({
      method,
      path,
      status: response.status,
      ms: Math.round(performance.now() - start),
      time: new Date().toLocaleTimeString(),
      request: body ? redact(body) : null,
      response: redact(payload),
    });
    logs = logs.slice(0, 50);
    if (!response.ok)
      throw Object.assign(Error(payload.error || "Request failed."), {
        status: response.status,
      });
    return payload;
  } catch (e) {
    if (!response && current())
      logs.unshift({
        method,
        path,
        status: "Network error",
        ms: Math.round(performance.now() - start),
        time: new Date().toLocaleTimeString(),
        request: body ? redact(body) : null,
        response: { error: e.message },
      });
    throw e;
  }
}
function heading(kicker, title, description, action = "") {
  return `<div class="page-heading"><div>${kicker ? `<p class="eyebrow">${kicker}</p>` : ""}<h1>${title}</h1>${description ? `<p>${description}</p>` : ""}</div>${action}</div>`;
}
function newButton() {
  return '<button class="button gold" data-action="new">+ New submission</button>';
}
function shield() {
  return '<svg width="18" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z"/><path d="m8 12 3 3 5-6"/></svg>';
}
function navigation() {
  $(".term").textContent = rules.semester?.name || "Current semester";
  const chair = user.role === "chair",
    pending = submissions.filter((s) => s.status === "pending").length;
  const links = chair
    ? [
        ["queue", "Review queue", pending],
        ["members", "Member progress"],
        ["roster", "Chapter roster"],
        ["semester", "Semester settings"],
        ["audit", "Review history"],
        ["earn", "Point rules"],
        ["access", "Privacy & sign-in"],
        ["setup", "Connections"],
      ]
    : [
        ["overview", "Overview"],
        ["submissions", "My submissions"],
        ["earn", "Ways to earn points"],
        ["access", "Privacy & sign-in"],
        ["setup", "Connections"],
      ];
  $("#nav").innerHTML = links
    .map(
      ([id, name, count]) =>
        `<a href="#${id}" class="${route() === id ? "active" : ""}">${name}${count ? `<span class="nav-count">${count}</span>` : ""}</a>`,
    )
    .join("");
  $("#header-person").innerHTML =
    `${esc(user.name)}<span>${chair ? "Scholarship chair" : "Member"}${isDemo() ? " · demo" : ""}</span>`;
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
  if (
    user?.role === "member" &&
    ["queue", "members", "roster", "audit", "semester"].includes(p)
  )
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
  return `<div class="table-wrap"><table><thead><tr>${chair ? "<th>Member</th>" : ""}<th>Activity</th><th>Date</th><th>Status</th><th class="right">Points</th><th class="right">${chair ? "Review" : "Details"}</th></tr></thead><tbody>${items.map((s) => `<tr>${chair ? `<td><strong>${esc(s.memberName)}</strong><small>${s.memberTier ? "Tier " + s.memberTier : "Member submission"}</small></td>` : ""}<td><strong>${esc(s.title)}</strong><small>${esc(activity(s.activity).name)} · ${esc(s.course)}</small></td><td>${date(s.date)}</td><td>${status(s.status)}</td><td class="right"><strong>${s.status === "approved" ? "+" + s.awarded : s.status === "denied" ? "—" : money(s.estimate) + "*"}</strong></td><td class="right"><button class="table-link" data-action="detail" data-id="${s.id}">${chair && s.status === "pending" ? "Review" : "View"}</button></td></tr>`).join("")}</tbody></table></div>`;
}
function overview() {
  const percent = Math.round((points.approved / points.goal) * 100),
    remaining = Math.max(0, points.goal - points.approved),
    checkpoint = Math.max(0, points.checkpoint - points.approved);
  const approvedWidth = Math.min(100, Math.max(0, (points.approved / points.goal) * 100));
  const pendingWidth = Math.min(100 - approvedWidth, Math.max(0, (points.pendingEstimate / points.goal) * 100));
  main.innerHTML =
    heading(
      "",
      "Overview",
      "",
      newButton(),
    ) +
    `<div class="overview-grid"><section class="points-panel"><p class="eyebrow">APPROVED POINTS</p><div class="points-number">${points.approved} <span>/ ${points.goal}</span></div><p>Semester goal · Tier ${user.tier}</p><div class="progress" role="progressbar" aria-label="Approved semester points" aria-valuenow="${points.approved}" aria-valuemin="0" aria-valuemax="${Math.max(points.goal, points.approved)}"><span class="progress-approved" style="width:${approvedWidth}%"></span>${points.pending > 0 && pendingWidth > 0 ? `<span class="progress-pending" aria-hidden="true" style="left:${approvedWidth}%;width:${pendingWidth}%"></span>` : ""}</div><div class="points-foot"><span class="points-foot-detail"><span>${remaining ? remaining + " points to your semester goal" : "Semester point goal reached"}</span>${points.pending > 0 ? `<span class="pending-count" aria-label="${money(points.pendingEstimate)} estimated points pending">${money(points.pendingEstimate)} pending</span>` : ""}</span><strong>${percent}%</strong></div></section><section class="panel checkpoint"><p class="eyebrow">NEXT CHECKPOINT</p><h2>${date(checkpointDate()).toUpperCase()}</h2><p>${points.checkpoint} approved points required</p><div class="checkpoint-status">${checkpoint ? checkpoint + " points to go" : "Checkpoint reached"}</div><p class="muted">Only approved submissions count toward your goal.</p></section></div><div class="stats-row"><div class="mini-stat"><strong>${points.pending}</strong><span><b>Awaiting review</b>${money(points.pendingEstimate)} estimated points</span></div><div class="mini-stat"><strong>${points.approvedCount}</strong><span><b>Approved submissions</b>Counted toward your goal</span></div><div class="mini-stat"><strong>${money(points.multiplier)}×</strong><span><b>Credit-load multiplier</b>${user.credits} enrolled credits</span></div></div><section class="panel recent"><div class="section-heading"><h2>RECENT SUBMISSIONS</h2><a href="#submissions">View all</a></div>${rows(submissions.slice(0, 4))}</section><p class="bottom-note">${shield()}Your member view shows your records. Only the chair reviews academic evidence.</p><p class="footnote">${isDemo() ? "Demo date" : "As of"}: ${esc(rules.today)}. *Pending estimates are not awarded points.</p>`;
}
function filters() {
  return `<div class="filters" aria-label="Filter submissions">${["all", "pending", "approved", "denied"].map((f) => `<button class="filter ${f === filter ? "active" : ""}" data-action="filter" data-value="${f}" aria-pressed="${f === filter}">${f === "all" ? "All submissions" : f === "pending" ? "Pending review" : f[0].toUpperCase() + f.slice(1)} <span>(${submissions.filter((s) => f === "all" || s.status === f).length})</span></button>`).join("")}</div>`;
}
function submissionPage() {
  main.innerHTML =
    heading(
      "",
      "My submissions",
      "",
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
      "",
      "Review queue",
      "Approve or deny pending submissions.",
      '<button class="button ghost" data-action="export">Export submissions</button>',
    ) +
    `<div class="stats-row chair-stats"><div class="mini-stat"><strong>${pending.length}</strong><span><b>Awaiting your review</b>${new Set(pending.map((s) => s.owner)).size} members with pending claims</span></div><div class="mini-stat"><strong>${approved.length}</strong><span><b>Approved this semester</b>${approved.reduce((n, s) => n + s.awarded, 0)} points awarded</span></div><div class="mini-stat"><strong>${roster.filter((m) => m.approved < m.checkpoint).length}</strong><span><b>Below next checkpoint</b>${date(checkpointDate())} · no automatic sanctions</span></div></div><div class="notice info"><strong>One review updates the member’s record.</strong> Approve a claim to award points, or deny it with a reason. Members see your decision and note.</div>${filters()}<section class="panel recent"><div class="section-heading"><h2>${filter === "pending" ? "PENDING SUBMISSIONS" : "SUBMISSION REGISTER"}</h2><span class="muted">${esc(rules.semester?.name || "Current semester")}</span></div>${rows(
      submissions.filter((s) => filter === "all" || s.status === filter),
      true,
    )}</section><p class="bottom-note">${shield()}Academic evidence is reserved for the Scholarship Chair.${isDemo() ? " Demo identities are freely switchable." : ""}</p><p class="footnote">*Estimated points. Fractional estimates require an explicit whole-point decision and explanation.</p>`;
}
function membersPage() {
  main.innerHTML =
    heading(
      "",
      "Member points",
      "Approved points and checkpoint targets for each member.",
    ) +
    `<section class="panel"><div class="table-wrap"><table><thead><tr><th>Member</th><th>Tier</th><th>Credits</th><th>Approved / goal</th><th>Pending</th><th>${date(checkpointDate())} target</th></tr></thead><tbody>${roster.map((m) => `<tr><td><div class="table-person"><span class="avatar">${m.initials}</span><div><strong>${esc(m.name)}</strong><small>${isDemo() ? "Fictional member" : esc(m.email || "")}</small></div></div></td><td>Tier ${m.tier}</td><td>${m.credits} · ${money(m.multiplier)}×</td><td><strong>${m.approved} / ${m.goal}</strong><div class="member-progress"><span style="width:${Math.min(100, (m.approved / m.goal) * 100)}%"></span></div></td><td>${m.pending}</td><td><span class="status ${m.approved >= m.checkpoint ? "approved" : "pending"}">${Math.max(0, m.checkpoint - m.approved)} points to go</span></td></tr>`).join("")}</tbody></table></div></section><div class="notice" style="margin-top:24px">Point totals are separate from required study-night attendance. The portal does not determine disciplinary outcomes.</div>`;
}
function earnPage() {
  main.innerHTML =
    heading(
      "",
      "Point rules",
      "Point values, claim limits, and checkpoint targets.",
    ) +
    `<div class="notice"><strong>Submit within 14 days.</strong> Include credible evidence. A maximum of five study hours and three minor assignments can be claimed per week. Never claim one activity twice.</div><div class="rules-grid">${rules.activities.map((a) => `<article class="rule-card"><div class="section-heading"><h3>${esc(a.name.toUpperCase())}</h3><span class="rule-points">${a.points} <small>PTS</small></span></div><p>Per ${a.unit}. ${esc(a.proof)}</p>${a.id === "major" ? '<p style="margin-top:10px">95%+: 5 · 90–94.99%: 4 · 85–89.99%: 3 · 80–84.99%: 2</p>' : ""}</article>`).join("")}</div><section class="panel" style="margin-top:24px"><h2>CHECKPOINTS · FALL 2026</h2><div class="table-wrap"><table><thead><tr><th>Tier</th>${rules.checkpoints.map((c) => `<th>${date(c.date)}</th>`).join("")}</tr></thead><tbody>${[1, 2, 3, 4, 5].map((t) => `<tr><td>Tier ${t}${t === 1 ? " / PNM" : ""}</td>${rules.checkpoints.map((c) => `<td>${c.targets[t - 1]}</td>`).join("")}</tr>`).join("")}</tbody></table></div><p class="footnote">Targets are interpreted as cumulative. They are not multiplied by credit load.</p></section><div class="notice" style="margin-top:24px"><strong>Policy decisions still needed</strong><p>The plan lists conflicting GPA boundaries for Tiers 3 and 4. It also prohibits fractional points without specifying rounding. The portal uses chair-assigned tiers and requires a note for any adjusted award.</p><p>The configured convention is Monday–Sunday weeks. Only explicit study categories share the study cap; assignment claim dates use the date entered. The chair must confirm these conventions and the end-of-semester closing date before launch.</p></div>`;
}
function accessPage() {
  const chapter = appConfig.chapterAuth?.enabled;
  main.innerHTML =
    heading(
      "",
      "Privacy and access",
      "How sign-in and record access work.",
    ) +
    `<div class="flow"><article><div class="step">01</div><h3>${chapter ? "VERIFY CHAPTER ACCOUNT" : "VERIFY UNIVERSITY IDENTITY"}</h3><p>${chapter ? "The member signs in with an approved badge number, portal ID, or email and a personal password verified by Supabase Auth." : "Microsoft Entra ID verifies the signed-in university account. The server validates token signature, audience, issuer, expiry, and the approved tenant or domain."}</p></article><article><div class="step">02</div><h3>CHECK CHAPTER MEMBERSHIP</h3><p>${chapter ? "The Scholarship Chair uses a dedicated office account. It invites and deactivates member accounts. The chapter roster remains a separate eligibility check." : "The roster binds a provider and a stable verified identity ID to a member. Email text alone cannot grant access. The chair role is assigned on the server."}</p></article><article><div class="step">03</div><h3>ENFORCE RECORD OWNERSHIP</h3><p>Every submission, file, review, and export passes an owner or chair-role check. Members receive their own records; the chair receives the review queue.</p></article></div><section class="panel prose"><h2>ACADEMIC EVIDENCE STAYS PRIVATE</h2><p>Evidence is stored privately. The server checks your access before providing a download; hosted download links expire shortly after they are issued.</p><h2>ONE AUTHORITATIVE RECORD</h2><p>A chair decision updates the submission. Point totals are derived from approved records. CSV exports support reporting without maintaining a second editable points ledger.</p><h2>CANVAS IS SEPARATE</h2><p>Portal sign-in does not authorize Canvas. Each member separately connects Canvas through the university’s authorization page. Tokens stay encrypted on the backend.</p><p class="footnote">${isDemo() ? "This preview is in demo mode. Sample accounts are freely switchable; use fictional records only." : "You are using the authenticated portal. Ask the chair about the chapter’s retention and academic-evidence policy."}</p></section>`;
}

function apiPage() {
  main.innerHTML =
    heading(
      "",
      "API activity",
      "Requests handled by the portal backend.",
      '<button class="button gold" data-action="ping">Run a live request</button>',
    ) +
    `<div class="integration-grid"><section class="panel"><span class="status approved">Working backend</span><h3>SUBMISSIONS & EVIDENCE</h3><p>Server validation, private files, shared records, review history, and ownership checks.</p></section><section class="panel"><span class="status ${(appConfig.chapterAuth?.enabled ? appConfig.chapterAuth.configured : appConfig.providers.some((p) => p.configured)) ? "approved" : "pending"}">${(appConfig.chapterAuth?.enabled ? appConfig.chapterAuth.configured : appConfig.providers.some((p) => p.configured)) ? "Configured" : "Setup required"}</span><h3>${appConfig.chapterAuth?.enabled ? "CHAPTER SIGN-IN" : "MICROSOFT SIGN-IN"}</h3><p>${isDemo() ? "Demo mode uses fictional identities." : appConfig.chapterAuth?.enabled ? "Supabase Auth verifies passwords; chapter membership controls portal access." : "The server verifies your university identity before granting roster-based access."}</p></section><section class="panel"><span class="status ${canvasConnected ? "approved" : "pending"}">${canvasConnected ? "Connected" : appConfig.canvasConfigured ? "Available to connect" : "Setup required"}</span><h3>CANVAS</h3><p>${isDemo() ? "Sample import available. Live Canvas is disabled in demo mode." : "Read-only assignment import with each member’s own authorization."}</p></section></div><section class="panel"><div class="section-heading"><h2>REQUEST LOG</h2><button class="text-btn" data-action="clear-log">Clear log</button></div><p class="footnote">Passwords, tokens, secrets, CSRF values, and file payloads are redacted. Academic fields belong to your authorized view.</p><div class="api-log">${logs.map((l, i) => `<button class="api-row" data-action="request-detail" data-index="${i}"><span class="http-method">${l.method}</span><code>${esc(l.path)}</code><span class="http-status ${l.status >= 400 ? "bad" : ""}">${l.status}</span><span>${l.ms} ms</span></button>`).join("")}</div></section>`;
}

function render() {
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
      setup: setupPage,
      roster: rosterPage,
      semester: semesterPage,
      audit: auditPage,
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
    isDemo()
      ? "Add a fictional activity for the Scholarship Chair to review."
      : "Add an activity and evidence for the Scholarship Chair to review.",
    `<form id="claim-form"><div class="form-grid"><div class="field span2"><label for="activity-search">Activity type</label>${activityPicker()}</div><div class="field span2"><label for="title">Assignment or activity title</label><input id="title" name="title" required maxlength="120" placeholder="e.g. Calculus II · Quiz 4"></div><div class="field"><label for="course">Course</label><input id="course" name="course" required maxlength="80" placeholder="e.g. MTH 2002"></div><div class="field"><label for="date">Activity date</label><input id="date" name="date" type="date" value="${rules.today}" min="${new Date(Date.parse(rules.today) - 14 * 86400000).toISOString().slice(0, 10)}" max="${rules.today}" required><small>${isDemo() ? "Demo date" : "Today"}: ${esc(rules.today)}.</small></div><div id="dynamic-field" class="field span2"></div></div><div class="preview-points"><div>Estimated points<small>Only awarded after chair approval · ${money(points.multiplier)}× credit multiplier</small></div><strong id="estimate">—</strong></div><div class="field"><label>Supporting evidence</label><p id="proof-hint" class="footnote"></p><div id="attachment" class="attachment"><p>${isDemo() ? "Upload a fictional sample file, or use the built-in evidence record." : "Upload a PDF, PNG, or JPEG, up to 5 MB. Only you and the chair can retrieve it."}</p><label for="evidence-file">Choose evidence file</label><input id="evidence-file" type="file" accept="application/pdf,image/png,image/jpeg">${isDemo() ? '<button class="button ghost small" type="button" data-action="sample" style="margin-top:12px">Use built-in sample</button>' : ""}</div><input id="evidence" name="evidence" type="hidden" value=""></div><div class="field"><label for="note">Note for the chair <span class="muted">(optional)</span></label><textarea id="note" name="note" maxlength="1000" placeholder="Any details that help verify the activity."></textarea></div><label class="checkbox-line"><input type="checkbox" name="confirm" required><span>This is a new activity, and I have not claimed it under another category.</span></label><div id="form-error" role="alert"></div><div class="modal-actions"><button class="button ghost" type="button" data-action="close">Cancel</button><button class="button gold" type="submit">Submit for review</button></div></form>`,
  );
  wireActivityPicker();
  $("#evidence-file").addEventListener("change", uploadEvidence);
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
  if (data.evidence && data.evidence !== "sample")
    data.evidenceId = data.evidence;
  data.confirm = data.confirm === "on";
  if (data.grade) data.grade = Number(data.grade);
  if (data.quantity) data.quantity = Number(data.quantity);
  try {
    await api("/api/submissions", { method: "POST", body: data });
    modal.close();
    filter = "pending";
    location.hash = "submissions";
    await refresh();
    toast("Submission sent. Points will count after chair approval.");
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
      `<div class="section-heading"><h3>${esc(s.title)}</h3>${status(s.status)}</div><dl class="details"><div><dt>Activity</dt><dd>${esc(a.name)}</dd></div><div><dt>Course</dt><dd>${esc(s.course)}</dd></div><div><dt>Activity date</dt><dd>${date(s.date)}, ${esc(s.date.slice(0, 4))}</dd></div><div><dt>${s.status === "approved" ? "Awarded points" : "Estimated points"}</dt><dd>${s.status === "approved" ? s.awarded : money(s.estimate)}${s.status === "pending" ? " · not yet awarded" : ""}</dd></div>${s.grade !== null ? `<div><dt>Grade</dt><dd>${s.grade}%</dd></div>` : ""}${a.hours ? `<div><dt>Hours</dt><dd>${s.quantity}</dd></div>` : ""}</dl>${s.source === "canvas-sample" ? '<div class="notice info"><strong>Canvas sample import</strong> Assignment category was selected by the member. Verify its individual course weight before approving.</div>' : ""}<h3>SUPPORTING EVIDENCE</h3><div class="sample-file"><span class="file-symbol">▤</span><div><strong>${s.evidenceId ? "Private evidence file" : s.source === "canvas" ? "Canvas grade record" : "Fictional activity record"}</strong><small>${s.evidenceId ? "Protected download · owner and chair only" : s.source === "canvas" ? "Imported with this member’s authorization" : "Generated demo evidence"}</small></div><button class="table-link" style="margin-left:auto" data-action="evidence" data-id="${s.id}">Open</button></div><div id="evidence-preview"></div><p class="footnote" style="margin-top:12px">Required: ${esc(a.proof)}</p>${s.note ? `<div class="review-note"><strong>Member note</strong><br>${esc(s.note)}</div>` : ""}${canReview ? `<form id="review-form" data-id="${s.id}"><div class="subtle-rule"></div><div class="field"><label for="award">Points to award</label><input id="award" name="points" type="number" min="0" max="100" step="1" ${Number.isInteger(s.estimate) ? `value="${s.estimate}"` : 'placeholder="Enter a whole-point award"'}><small>Base ${money(s.base)} × credit multiplier = ${money(s.estimate)} estimated. ${Number.isInteger(s.estimate) ? "Explain any adjustment." : "Rounding is undefined in the plan. Record a whole-point decision and explain it."}</small></div><div class="field"><label for="review-note">Review note</label><textarea id="review-note" name="note" maxlength="1000" placeholder="Required for a denial or point adjustment. Visible to the member."></textarea></div><div id="form-error" role="alert"></div><div class="modal-actions"><button type="submit" name="decision" value="denied" formnovalidate class="button danger">Deny submission</button><button type="submit" name="decision" value="approved" class="button gold">Approve & award points</button></div></form>` : `${s.reviewNote ? `<div class="review-note" style="margin-top:18px"><strong>Chair’s note</strong><br>${esc(s.reviewNote)}</div>` : ""}<div class="history">${s.history.map((h) => `<p><strong>${esc(h.event)}</strong><small>${new Date(h.at).toLocaleString()}${h.by ? " · " + esc(h.by) : ""}</small></p>`).join("")}</div><div class="modal-actions"><button class="button ghost" data-action="close">Close</button></div>`}`,
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
  const destination = $("#evidence-preview");
  if (!destination) return;
  try {
    const { evidence: e } = await api(
      "/api/submissions/" + encodeURIComponent(id) + "/evidence",
    );
    if (!destination.isConnected || !modal.open) return;
    if (e.sample === false && e.downloadUrl) {
      destination.innerHTML = `<div class="evidence-sheet"><h3>${esc(e.name)}</h3><p>${esc(e.mime)} · private academic evidence</p><a class="button ghost" href="${esc(e.downloadUrl)}" target="_blank" rel="noopener">Download evidence</a></div>`;
    } else {
      destination.innerHTML = `<div class="evidence-sheet"><div class="sample-stamp">${e.sample === false ? "CANVAS RECORD" : "FICTIONAL SAMPLE"}</div><h3>${esc(e.title)}</h3><p>${esc(e.course)} · ${esc(e.date)}</p><p><strong>${e.grade !== null && e.grade !== undefined ? "Grade: " + e.grade + "%" : esc(e.activity || "")}</strong></p><p class="muted">${esc(e.verification || "Imported record")}</p></div>`;
    }
  } catch (e) {
    toast(e.message);
  }
}

async function switchUser(id) {
  sessionEpoch++;
  logs = [];
  modal.close();
  person.disabled = true;
  try {
    const result = await api("/api/demo/session", {
      method: "POST",
      body: { persona: id },
    });
    user = result.user;
    csrfToken = result.csrfToken || csrfToken;
    canvasConnected = Boolean(result.canvasConnected);
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
  if (!isDemo()) {
    location.assign("/auth/" + provider.toLowerCase());
    return;
  }
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
  if (action === "account" && !isDemo()) {
    openModal(
      "YOUR ACCOUNT",
      esc(user.name),
      `<p>${esc(user.email || "")}</p><p>${user.role === "chair" ? "Scholarship Chair office account" : "Chapter member"}</p>${user.role === "chair" && appConfig.chapterAuth?.enabled ? '<p class="muted">At a chair transition, use the chapter inbox to reset this password. That signs out existing portal sessions.</p>' : ""}<div class="modal-actions"><button class="button ghost" data-action="logout">Sign out</button><button class="button gold" data-action="close">Close</button></div>`,
    );
    return;
  }
  try {
    if (action === "new") newSubmission();
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
        `<p>You are viewing the ${user.role === "chair" ? "Scholarship Chair" : "member"} workflow as a fictional user. Use “View as” in the sidebar to change roles.</p><p class="muted">University sign-in is not connected. No real password is needed.</p><div class="modal-actions"><button class="button ghost" data-action="identity" data-provider="Microsoft">Microsoft preview</button><button class="button gold" data-action="close">Close</button></div>`,
      );
    } else if (action === "identity") identity(b.dataset.provider);
    else if (action === "reset") {
      openModal(
        "RESET THE DEMONSTRATION?",
        "Only this demo session’s fictional records will be reset.",
        `<p>This restores the sample submissions and point totals. It does not touch university accounts, connected services, or chapter records.</p><div class="modal-actions"><button class="button ghost" data-action="close">Cancel</button><button class="button gold" data-action="confirm-reset">Reset demo</button></div>`,
      );
    } else if (action === "confirm-reset") {
      await api("/api/demo/reset", { method: "POST", body: {} });
      modal.close();
      await refresh();
      toast("Sample records restored.");
    } else if (action === "ping") {
      await api("/api/me");
      apiPage();
      toast("Live request completed. Select it to see the response.");
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
      link.download = isDemo()
        ? "ato-demo-submissions.csv"
        : "ato-submissions.csv";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("CSV export downloaded.");
    }
  } catch (err) {
    toast(err.message);
  }
}
document.addEventListener("click", handleAction);
person.addEventListener("change", () => switchUser(person.value));
window.addEventListener("hashchange", render);
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.close();
});
async function init() {
  try {
    appConfig = await api("/api/config");
    if (appConfig.chapterAuth?.enabled && location.pathname.startsWith("/account/")) {
      const fragment = new URLSearchParams(location.hash.slice(1));
      accountToken = fragment.get("access_token");
      history.replaceState(null, "", location.pathname);
      accountSetupPage();
      return;
    }
    const requested = new URL(location.href).searchParams.get("view");
    let result;
    try {
      result = await api("/api/session");
    } catch (e) {
      if (e.status !== 401) throw e;
      if (!isDemo()) {
        loginPage();
        return;
      }
      result = await api("/api/demo/session", { method: "POST", body: {} });
    }
    csrfToken = result.csrfToken;
    if (
      isDemo() &&
      requested &&
      ["alex", "jordan", "chair"].includes(requested) &&
      requested !== result.user.id
    )
      result = await api("/api/demo/session", {
        method: "POST",
        body: { persona: requested },
      });
    user = result.user;
    document.body.classList.remove("portal-loading", "signed-out");
    document.querySelector(".account-button").hidden = false;
    csrfToken = result.csrfToken;
    canvasConnected = Boolean(result.canvasConnected);
    const clean = new URL(location.href);
    clean.searchParams.delete("view");
    history.replaceState(null, "", clean);
    rules = await api("/api/rules");
    filter = user.role === "chair" ? "pending" : "all";
    document.querySelector(".demo-bar > span").innerHTML = isDemo()
      ? "<strong>PRIVATE EDITION · DEMO</strong> Fictional data · real backend · identity not connected"
      : "<strong>CHAPTER SCHOLARSHIP PORTAL</strong> Signed-in members · confidential academic records";
    document.querySelector(".sidebar-bottom").style.display = isDemo()
      ? ""
      : "none";
    document.querySelector('[data-action="reset"]').hidden = !isDemo();
    await refresh();
  } catch (e) {
    document.body.classList.remove("portal-loading");
    document.body.classList.add("signed-out");
    main.innerHTML =
      heading(
        "",
        "Service unavailable",
        "The service could not load your account.",
      ) +
      `<div class="error">${esc(e.message)}</div><button class="button gold" id="retry">Try again</button>`;
    $("#retry").onclick = init;
  }
}
function loginPage() {
  document.body.classList.remove("portal-loading");
  document.body.classList.add("signed-out");
  sessionEpoch++;
  logs = [];
  submissions = [];
  roster = [];
  points = {};
  canvasConnected = false;
  modal.close();
  user = null;
  csrfToken = null;
  $(".term").textContent = appConfig.semester?.name || "Current semester";
  document.querySelector(".account-button").hidden = true;
  $("#nav").innerHTML = "";
  document.querySelector(".sidebar-bottom").style.display = "none";
  document.querySelector('[data-action="reset"]').hidden = true;
  document.querySelector(".demo-bar > span").innerHTML =
    "<strong>CHAPTER PORTAL</strong> Approved chapter membership required";
  if (appConfig.chapterAuth?.enabled) {
    main.innerHTML = heading("", "Sign in", "Use your chapter account.") +
      `<section class="panel login-panel"><h2>Chapter account sign-in</h2><p>Members can use an approved email, badge number, or assigned portal ID. The Scholarship Chair uses the chapter office account.</p><form id="chapter-login"><div class="field"><label for="login-id">Email, badge number, or portal ID</label><input id="login-id" name="identifier" autocomplete="username" required maxlength="254"></div><div class="field"><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required></div><div id="form-error" role="alert"></div><button class="button gold" type="submit" ${appConfig.chapterAuth.configured ? "" : "disabled"}>Sign in</button></form><button class="text-btn" id="forgot-password" type="button" ${appConfig.chapterAuth.configured ? "" : "disabled"}>Forgot password?</button>${appConfig.chapterAuth.configured ? "" : '<p class="footnote">Chapter accounts are being set up. Use the demo below to explore the portal in the meantime.</p>'}</section>` + sandboxLinks();
    $("#chapter-login").onsubmit = async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target));
      try {
        await api("/api/auth/login", { method: "POST", body: values });
        await init();
      } catch (error) { $("#form-error").textContent = error.message; }
    };
    $("#forgot-password").onclick = () => {
      const panel = $(".login-panel");
      panel.innerHTML = `<h2>Reset password</h2><p>Enter your approved email, badge number, or portal ID. The Chair office account uses its chapter inbox.</p><form id="reset-request"><div class="field"><label for="reset-id">Email, badge number, or portal ID</label><input id="reset-id" name="identifier" autocomplete="username" required maxlength="254"></div><div id="form-error" role="alert"></div><button class="button gold" type="submit">Send reset link</button></form><button class="text-btn" id="back-login" type="button">Back to sign in</button>`;
      $("#back-login").onclick = loginPage;
      $("#reset-request").onsubmit = async (event) => {
        event.preventDefault();
        try {
          const result = await api("/api/auth/request-reset", { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
          panel.innerHTML = `<h2>Check your email</h2><p>${esc(result.message)}</p><button class="button ghost" id="back-login" type="button">Back to sign in</button>`;
          $("#back-login").onclick = loginPage;
        } catch (error) { $("#form-error").textContent = error.message; }
      };
    };
    return;
  }
  main.innerHTML =
    heading(
      "",
      "Sign in",
      "Use your approved university account.",
    ) +
    `<section class="panel login-panel"><h2>University sign-in</h2><p>Your university verifies your identity. The chapter roster determines access to the portal.</p>${appConfig.providers.map((p) => `<a class="button ${p.configured ? "gold" : "ghost"}" style="display:flex;margin:12px 0" ${p.configured ? `href="/auth/${p.id}"` : 'aria-disabled="true"'}>Continue with ${esc(p.name)}${p.configured ? "" : " · not configured"}</a>`).join("")}<p class="footnote">If your account is not on the roster, the chair must bind your verified identity before access is granted. This portal never asks for your university password.</p></section>` + sandboxLinks();
}

function sandboxLinks() {
  return `<section class="panel login-panel sandbox-panel"><h2>Explore the demo</h2><p>Choose a view to explore fictional records in this browser. Demo accounts are separate from chapter accounts.</p><div class="sandbox-actions"><a class="button ghost" href="/demo/?account=member">Open member demo</a><a class="button ghost" href="/demo/?account=chair">Open Chair demo</a></div></section>`;
}

function accountSetupPage() {
  document.body.classList.remove("portal-loading");
  document.body.classList.add("signed-out");
  user = null;
  csrfToken = null;
  document.querySelector(".account-button").hidden = true;
  $("#nav").innerHTML = "";
  document.querySelector(".sidebar-bottom").style.display = "none";
  document.querySelector('[data-action="reset"]').hidden = true;
  main.innerHTML = heading("", "Set your password", "This link can be used only for account setup or recovery.") +
    `<section class="panel login-panel">${accountToken ? '<form id="account-setup"><div class="field"><label for="new-password">New password</label><input id="new-password" name="password" type="password" autocomplete="new-password" minlength="12" required></div><div class="field"><label for="confirm-password">Confirm password</label><input id="confirm-password" name="confirm" type="password" autocomplete="new-password" minlength="12" required></div><div id="form-error" role="alert"></div><button class="button gold" type="submit">Save password</button></form>' : '<p>That account link is missing or has expired. Ask the chair for a new invitation or request a password reset.</p><a class="button ghost" href="/">Go to sign in</a>'}</section>`;
  if (!accountToken) return;
  $("#account-setup").onsubmit = async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    if (values.password !== values.confirm) {
      $("#form-error").textContent = "Passwords do not match.";
      return;
    }
    try {
      await api("/api/auth/complete", { method: "POST", body: { accessToken: accountToken, password: values.password } });
      accountToken = null;
      history.replaceState(null, "", "/");
      loginPage();
      toast("Password saved. Sign in to continue.");
    } catch (error) { $("#form-error").textContent = error.message; }
  };
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
init();

function canvasPage() {
  main.innerHTML =
    heading(
      "",
      "Canvas import",
      "Import graded assignments, confirm the category, and submit them for review.",
    ) +
    `<div class="notice ${canvasConnected ? "info" : ""}"><strong>${isDemo() ? "Canvas sample mode" : canvasConnected ? "Canvas connected" : appConfig.canvasConfigured ? "Canvas authorization required" : "Canvas setup required"}</strong><p>${isDemo() ? "Fictional records only. No university API is contacted." : canvasConnected ? "Only your released, graded assignments are imported. Points still require chair approval." : "The university must approve a scoped Canvas OAuth developer key. Microsoft sign-in does not grant Canvas access."}</p></div><section class="panel"><div class="section-heading"><h2>YOUR CANVAS ASSIGNMENTS</h2>${!isDemo() && !canvasConnected ? `<button class="button gold" data-action="connect-canvas" ${appConfig.canvasConfigured ? "" : "disabled"}>Connect Canvas</button>` : `<button class="button gold" data-action="load-canvas">${isDemo() ? "Load sample assignments" : "Load assignments"}</button>`}</div><div id="canvas-results"><p class="muted">Choose which assignments to submit. Canvas assignment groups do not determine whether an individual assignment is major or minor.</p></div></section><p class="footnote">The import uses the grade-posting date as the claim date. Confirm that interpretation with the chapter before using live records.</p>`;
}

async function loadCanvas() {
  const destination = $("#canvas-results");
  if (!destination) return;
  try {
    const response = await api("/api/integrations/canvas/assignments");
    if (!destination.isConnected) return;
    destination.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Select</th><th>Assignment</th><th>Grade</th><th>Category</th><th>Grade posted</th></tr></thead><tbody>${response.assignments.map((a) => `<tr><td><input class="canvas-select" type="checkbox" value="${a.id}" data-course="${a.course_id}" aria-label="Select ${esc(a.name)}" ${a.imported ? "disabled" : ""}></td><td><strong>${esc(a.name)}</strong><small>${esc(a.course)}${a.imported ? " · Already imported" : ""}</small></td><td>${Number(a.percent).toFixed(2).replace(/\.00$/, "")}%<small>${a.submission.score} / ${a.points_possible}</small></td><td><select id="category-${a.id}" aria-label="Category for ${esc(a.name)}" ${a.imported ? "disabled" : ""}><option value="">Choose category</option><option value="major">Major assignment</option><option value="minor">Minor assignment</option><option value="lab">Lab report</option></select></td><td>${date(canvasDate(a.submission.posted_at))}</td></tr>`).join("")}</tbody></table></div><label class="checkbox-line"><input id="canvas-confirm" type="checkbox"><span>I have checked the individual assignment categories and have not claimed these activities elsewhere.</span></label><div id="canvas-error" role="alert"></div><div class="section-heading"><p class="footnote">${isDemo() ? "Sample records only. No Canvas credentials are needed." : "Only selected records are saved for chair review."}</p><button class="button gold" data-action="canvas-submit">Import selected for review</button></div>`;
  } catch (e) {
    toast(e.message);
  }
}
async function importCanvas() {
  const selected = [...document.querySelectorAll(".canvas-select:checked")].map(
    (el) => ({
      assignmentId: String(el.value),
      courseId: String(el.dataset.course),
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
    toast(result.imported.length + " assignment(s) sent for review.");
  } catch (e) {
    err.className = "error";
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function uploadEvidence(e) {
  const input = e.target,
    form = input.closest("form"),
    hidden = form.querySelector("#evidence"),
    attachment = form.querySelector("#attachment"),
    submit = form.querySelector('button[type="submit"]'),
    owner = user.id,
    file = input.files[0];
  const current = () =>
    form.isConnected && user?.id === owner && $("#claim-form") === form;
  if (!file) return;
  hidden.value = "";
  attachment.innerHTML =
    '<p class="muted">No verified attachment selected.</p>';
  if (file.size > 5 * 1024 * 1024) {
    formError("Choose a file no larger than 5 MB.");
    return;
  }
  submit.disabled = true;
  input.disabled = true;
  try {
    let result;
    if (appConfig.uploadMode === "direct") {
      const intent = await api("/api/uploads/init", {
        method: "POST",
        body: { name: file.name, mime: file.type, size: file.size },
      });
      if (!current()) return;
      const destination = new URL(intent.uploadUrl);
      if (
        destination.protocol !== "https:" ||
        destination.username ||
        destination.password
      )
        throw Error("The private upload destination is unavailable.");
      const response = await fetch(destination.href, {
        method: "PUT",
        credentials: "omit",
        redirect: "error",
        headers: { "Content-Type": file.type, "x-upsert": "false" },
        body: file,
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok)
        throw Error(
          "The evidence could not be uploaded. Choose the file again to retry.",
        );
      if (!current()) return;
      result = await api(
        "/api/uploads/" + encodeURIComponent(intent.id) + "/complete",
        {
          method: "POST",
          body: {},
        },
      );
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      if (!current()) return;
      result = await api("/api/uploads", {
        method: "POST",
        body: { name: file.name, mime: file.type, base64: btoa(binary) },
      });
    }
    if (!current()) return;
    hidden.value = result.upload.id;
    attachment.innerHTML =
      '<div class="sample-file"><div><strong>' +
      esc(result.upload.name) +
      "</strong><small>Uploaded privately · " +
      Math.ceil(result.upload.size / 1024) +
      " KB</small></div></div>";
    toast("Evidence uploaded. Submit the form to attach it to your claim.");
  } catch (err) {
    if (current()) formError(err.message);
  } finally {
    if (current()) {
      submit.disabled = false;
      input.disabled = false;
    }
  }
}
function setupPage() {
  main.innerHTML =
    heading(
      "",
      "Connections",
      "Status of sign-in, Canvas, and evidence storage.",
    ) +
    `<div class="rules-grid">${appConfig.providers.map((p) => `<section class="rule-card"><span class="status ${p.configured ? "approved" : "pending"}">${p.configured ? "Configured" : "Not configured"}</span><h3 style="margin-top:15px">${esc(p.name.toUpperCase())}</h3><p>University identity verification using OpenID Connect. ${isDemo() ? "The current session is a sample identity." : "Your chapter roster controls access after sign-in."}</p></section>`).join("")}<section class="rule-card"><span class="status ${canvasConnected ? "approved" : "pending"}">${canvasConnected ? "Connected" : appConfig.canvasConfigured ? "Ready to connect" : "Not configured"}</span><h3 style="margin-top:15px">CANVAS</h3><p>Read-only access to your released assignment grades. Tokens are encrypted on the server.</p>${user.role === "member" && !isDemo() ? `<button class="button ghost small" style="margin-top:14px" data-action="${canvasConnected ? "disconnect-canvas" : "connect-canvas"}" ${canvasConnected || appConfig.canvasConfigured ? "" : "disabled"}>${canvasConnected ? "Disconnect Canvas" : "Connect Canvas"}</button>` : ""}</section><section class="rule-card"><span class="status approved">Available</span><h3 style="margin-top:15px">PRIVATE EVIDENCE</h3><p>PDF, PNG, and JPEG uploads up to 5 MB. The server checks member or chair access before issuing a download.</p></section></div>`;
}
async function rosterPage() {
  main.innerHTML =
    heading(
      "",
      "Roster",
      "Manage member identities and access.",
      '<button class="button gold" data-action="add-member">Add member</button>',
    ) +
    `${appConfig.chapterAuth?.enabled ? '<div class="notice info"><strong>Scholarship Chair office account</strong><p>This account belongs to the office, not to a member. Transfer control of its chapter inbox to the incoming chair and reset its password during each transition. Other members have separate accounts.</p></div>' : ""}<section class="panel" id="roster-sync"><p>Checking sheet connection…</p></section><section class="panel recent" id="roster-table"><p>Loading roster…</p></section>`;
  loadRosterSync();
  const destination = $("#roster-table");
  try {
    const result = await api("/api/roster");
    if (!destination.isConnected) return;
    destination.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Member / Portal Member ID</th><th>${appConfig.chapterAuth?.enabled ? "Sign-in ID" : "Identity provider"}</th><th>Role</th><th>Tier / credits</th><th>Access</th></tr></thead><tbody>${result.members.map((m) => `<tr><td><strong>${esc(m.name)}</strong><small>${esc(m.email || "")}</small><code>${esc(m.id)}</code></td><td>${appConfig.chapterAuth?.enabled ? esc(m.identities?.filter((i) => i.provider === "login").map((i) => i.subject.toUpperCase()).join(" · ") || "Pending") : esc(m.identities?.length ? m.identities.map((i) => i.provider).join(", ") : isDemo() ? "Demo" : "Not linked")}</td><td>${esc(m.role)}</td><td>${m.tier || "—"} / ${m.credits || "—"}</td><td>${m.active === false || m.active === 0 ? "Inactive" : m.id === user.id ? "Current account" : `${appConfig.chapterAuth?.enabled ? `<button class="table-link" data-action="reset-member-password" data-id="${esc(m.id)}">Send reset</button> · ` : ""}<button class="table-link" data-action="deactivate-member" data-id="${esc(m.id)}">Deactivate</button>`}</td></tr>`).join("")}</tbody></table></div>`;
  } catch (e) {
    if (destination.isConnected)
      destination.innerHTML = '<div class="error">' + esc(e.message) + "</div>";
  }
}
async function loadRosterSync() {
  const panel = $("#roster-sync");
  try {
    const result = await api("/api/admin/roster-sync");
    if (!panel.isConnected) return;
    panel.innerHTML = `<div class="section-heading"><h2>ROSTER SHEET</h2><span class="status ${result.fresh ? "approved" : "pending"}">${result.fresh ? "Up to date" : result.required ? "Refresh required" : "Not connected"}</span></div><p>Copy each Portal Member ID below into the sheet, then use TRUE or FALSE in its Active column. Chapter sign-in identifies the member; the sheet controls continuing access.</p><p class="muted">${result.fetchedAt ? `Last successful refresh: ${esc(new Date(result.fetchedAt).toLocaleString())}. ${result.activeCount} active IDs.` : "Connect the sheet in the hosting settings to enable automatic eligibility checks."} Members need a successful refresh at least every 15 minutes. Chair access remains available for recovery.</p>${result.lastError ? `<p class="error">${esc(result.lastError)}</p>` : ""}<button class="button ghost" id="sync-roster" ${result.configured ? "" : "disabled"}>Refresh roster now</button>`;
    $("#sync-roster").onclick = async (event) => {
      event.target.disabled = true;
      try {
        await api("/api/admin/roster-sync", { method: "POST", body: {} });
        toast("Roster eligibility updated.");
      } catch (error) {
        toast(error.message);
      }
      await loadRosterSync();
    };
  } catch (error) {
    if (panel.isConnected)
      panel.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

async function semesterPage() {
  const owner = user.id;
  main.innerHTML =
    heading(
      "",
      "Semester reset",
      "Clear the old semester’s academic records while keeping member accounts.",
    ) +
    '<section class="panel" id="semester-panel"><p>Loading semester…</p></section>';
  const panel = $("#semester-panel");
  try {
    const result = await api("/api/semester");
    if (!panel.isConnected || user.id !== owner) return;
    const reset = result.reset;
    const active = result.semester;
    if (reset.status === "purging") {
      panel.innerHTML = `<h2>SEMESTER CLEANUP IN PROGRESS</h2><p>Old submissions and points have been cleared. New submissions reopen after all evidence deletion is verified.</p><p id="cleanup-progress" role="status"><strong>${reset.remaining}</strong> stored objects still need verification.</p>${reset.nextAttemptAt ? `<p>Next cleanup attempt: ${esc(new Date(reset.nextAttemptAt).toLocaleString())}.</p>` : ""}<p class="muted">Recent upload links must expire before the final cleanup pass. You can leave this page and return later.</p>${reset.lastError ? `<p class="error">${esc(reset.lastError)}</p>` : ""}<button class="button gold" id="resume-semester">Resume cleanup</button>`;
      $("#resume-semester").onclick = async (event) => {
        event.target.disabled = true;
        try {
          let progress;
          do {
            progress = await api("/api/semester/reset/resume", {
              method: "POST",
              body: {},
            });
            if (!panel.isConnected || user.id !== owner) return;
            $("#cleanup-progress").textContent =
              `${progress.reset.remaining} stored objects still need verification.`;
          } while (
            progress.reset.status === "purging" &&
            progress.reset.phase === "purging" &&
            !progress.reset.lastError
          );
          await updateSemesterState();
        } catch (error) {
          toast(error.message);
          if (panel.isConnected) event.target.disabled = false;
        }
      };
      return;
    }
    panel.innerHTML = `${reset.status === "completed" ? '<div class="notice info">Cleanup completed. The new semester is active.</div>' : ""}<h2>${esc(active?.name || "Current semester")}</h2><p>Starting a new semester permanently removes submissions, point awards, uploaded evidence, and academic review history from the live portal. Accounts, university identity links, and roster settings stay in place.</p><p class="muted">Separately retained backups expire under the hosting provider’s retention policy. This action cannot be undone in the portal.</p><form id="semester-form"><div class="form-grid"><div class="field span2"><label for="semester-name">New semester name</label><input id="semester-name" name="name" required maxlength="80" placeholder="Spring 2027"></div>${[
      ["startDate", "Semester start"],
      ["checkpoint1", "First checkpoint"],
      ["checkpoint2", "Second checkpoint"],
      ["checkpoint3", "Third checkpoint"],
      ["targetDate", "Final point target"],
      ["endDate", "Submissions close"],
    ]
      .map(
        ([id, label]) =>
          `<div class="field"><label for="semester-${id}">${label}</label><input id="semester-${id}" name="${id}" type="date" required></div>`,
      )
      .join(
        "",
      )}</div><p class="muted">Point tiers stay the same. Enter the chapter’s approved dates for the new semester.</p><button class="button danger" type="submit">Review semester reset</button><p id="semester-error" role="alert"></p></form>`;
    $("#semester-form").onsubmit = async (event) => {
      event.preventDefault();
      const button = event.target.querySelector('button[type="submit"]');
      button.disabled = true;
      const data = Object.fromEntries(new FormData(event.target));
      const semester = {
        name: data.name,
        startDate: data.startDate,
        targetDate: data.targetDate,
        endDate: data.endDate,
        checkpointDates: [data.checkpoint1, data.checkpoint2, data.checkpoint3],
      };
      try {
        const preview = await api("/api/semester/preview");
        if (!panel.isConnected || user.id !== owner) return;
        openModal(
          "PERMANENTLY RESET THIS SEMESTER?",
          "Review what will be removed before continuing.",
          `<p><strong>${preview.counts.submissions}</strong> submissions and <strong>${preview.counts.evidence}</strong> evidence records will be deleted. <strong>${preview.counts.accounts}</strong> member accounts will remain.</p><p>Next semester: <strong>${esc(semester.name)}</strong>, ${esc(semester.startDate)} to ${esc(semester.endDate)}.</p><p class="muted">${esc(preview.backupNotice)}</p><form id="confirm-semester-form"><div class="field"><label for="semester-confirm">Type DELETE SEMESTER to confirm</label><input id="semester-confirm" autocomplete="off" required></div><div id="form-error" role="alert"></div><div class="modal-actions"><button class="button ghost" type="button" data-action="close">Cancel</button><button class="button danger" type="submit">Delete semester records</button></div></form>`,
        );
        $("#confirm-semester-form").onsubmit = async (event) => {
          event.preventDefault();
          const submit = event.target.querySelector('button[type="submit"]');
          submit.disabled = true;
          try {
            await api("/api/semester/reset", {
              method: "POST",
              body: {
                confirm: $("#semester-confirm").value,
                previewToken: preview.previewToken,
                semester,
              },
            });
            modal.close();
            logs = [];
            await updateSemesterState();
            await semesterPage();
          } catch (error) {
            formError(error.message);
            submit.disabled = false;
          }
        };
      } catch (error) {
        $("#semester-error").textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };
  } catch (error) {
    if (panel.isConnected)
      panel.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}
async function updateSemesterState() {
  const epoch = sessionEpoch;
  const session = await api("/api/session");
  const nextRules = await api("/api/rules");
  if (epoch !== sessionEpoch) return;
  rules = nextRules;
  appConfig.semester = session.semester;
  submissions = [];
  roster = [];
  points = {};
  await refresh();
}
function addMember() {
  if (appConfig.chapterAuth?.enabled) {
    openModal("ADD A CHAPTER MEMBER", "An invitation will be emailed. The member chooses their own password.",
      `<form id="roster-form"><div class="form-grid"><div class="field"><label for="member-name">Name</label><input id="member-name" name="name" required maxlength="100"></div><div class="field"><label for="member-email">Email for account setup</label><input id="member-email" name="email" type="email" required></div><div class="field"><label for="member-badge">Badge number (optional)</label><input id="member-badge" name="badge" maxlength="32"><small>New members receive a portal sign-in ID automatically.</small></div><div class="field"><label for="member-tier">Assigned tier</label><select id="member-tier" name="tier">${[1, 2, 3, 4, 5].map((t) => `<option>${t}</option>`).join("")}</select></div><div class="field"><label for="member-credits">Enrolled credits</label><input id="member-credits" name="credits" type="number" min="0" max="30" required value="15"></div></div><div id="form-error" role="alert"></div><div class="modal-actions"><button class="button ghost" type="button" data-action="close">Cancel</button><button class="button gold" type="submit">Send invitation</button></div></form>`);
    $("#roster-form").onsubmit = async (event) => {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(event.target));
      body.tier = Number(body.tier);
      body.credits = Number(body.credits);
      try {
        const result = await api("/api/roster", { method: "POST", body });
        modal.close();
        await rosterPage();
        toast(`Invitation sent. Sign-in ID: ${result.loginId}`);
      } catch (error) { formError(error.message); }
    };
    return;
  }
  openModal(
    "ADD A CHAPTER MEMBER",
    "Use the stable identity ID verified by the university provider.",
    `<form id="roster-form"><div class="form-grid"><div class="field"><label for="member-name">Name</label><input id="member-name" name="name" required maxlength="120"></div><div class="field"><label for="member-email">Contact email</label><input id="member-email" name="email" type="email" required></div><div class="field"><label for="member-provider">Identity provider</label><input id="member-provider" value="Microsoft" disabled><input type="hidden" name="provider" value="microsoft"></div><div class="field"><label for="member-tier">Assigned tier</label><select id="member-tier" name="tier">${[1, 2, 3, 4, 5].map((t) => `<option>${t}</option>`).join("")}</select></div><div class="field span2"><label for="member-subject">Verified identity ID</label><input id="member-subject" name="subject" required maxlength="300"><small>Use the verified Microsoft tenant ID and directory object ID: tenant:oid:object-id. An email address or badge number is not an identity ID.</small></div><div class="field"><label for="member-credits">Enrolled credits</label><input id="member-credits" name="credits" type="number" min="0" max="30" required value="15"></div></div><div id="form-error" role="alert"></div><div class="modal-actions"><button class="button ghost" type="button" data-action="close">Cancel</button><button class="button gold" type="submit">Add member</button></div></form>`,
  );
  $("#roster-form").onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.tier = Number(body.tier);
    body.credits = Number(body.credits);
    try {
      await api("/api/roster", { method: "POST", body });
      modal.close();
      await rosterPage();
      toast("Member added to the chapter roster.");
    } catch (err) {
      formError(err.message);
    }
  };
}
async function auditPage() {
  main.innerHTML =
    heading(
      "",
      "Review history",
      "Decisions, membership changes, and evidence access.",
    ) +
    '<section class="panel" id="audit-table"><p>Loading activity…</p></section>';
  const destination = $("#audit-table");
  try {
    const result = await api("/api/audit");
    if (!destination.isConnected) return;
    destination.innerHTML = `<div class="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>Who</th><th>Record</th></tr></thead><tbody>${result.events.map((e) => `<tr><td>${esc(new Date(e.at).toLocaleString())}</td><td><strong>${esc(e.action)}</strong></td><td>${esc(e.actor || "System")}</td><td>${esc(e.subject || "")}</td></tr>`).join("")}</tbody></table></div>${result.events.length ? "" : '<p class="muted">No recorded actions yet.</p>'}`;
  } catch (e) {
    if (destination.isConnected)
      destination.innerHTML = '<div class="error">' + esc(e.message) + "</div>";
  }
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  try {
    if (b.dataset.action === "logout") {
      sessionEpoch++;
      await api("/api/logout", { method: "POST", body: {} });
      modal.close();
      logs = [];
      loginPage();
    } else if (b.dataset.action === "add-member") addMember();
    else if (b.dataset.action === "reset-member-password") {
      openModal("SEND PASSWORD RESET?", "A reset link will go to this member’s approved email. You will not see their password.",
        `<div class="modal-actions"><button class="button ghost" data-action="close">Cancel</button><button class="button gold" data-action="confirm-member-reset" data-id="${esc(b.dataset.id)}">Send reset link</button></div>`);
    } else if (b.dataset.action === "confirm-member-reset") {
      await api("/api/roster/" + encodeURIComponent(b.dataset.id) + "/reset-password", { method: "POST", body: {} });
      modal.close();
      toast("Password reset email requested.");
    }
    else if (b.dataset.action === "deactivate-member") {
      openModal(
        "DEACTIVATE MEMBER?",
        "This blocks future portal access and keeps the review record.",
        `<div class="modal-actions"><button class="button ghost" data-action="close">Cancel</button><button class="button danger" data-action="confirm-deactivate" data-id="${esc(b.dataset.id)}">Deactivate</button></div>`,
      );
    } else if (b.dataset.action === "confirm-deactivate") {
      await api(
        "/api/roster/" + encodeURIComponent(b.dataset.id) + "/deactivate",
        { method: "POST", body: {} },
      );
      modal.close();
      await rosterPage();
    } else if (b.dataset.action === "connect-canvas") {
      const result = await api("/api/integrations/canvas/connect", {
        method: "POST",
        body: {},
      });
      location.assign(result.url);
    } else if (b.dataset.action === "disconnect-canvas") {
      await api("/api/integrations/canvas/disconnect", {
        method: "POST",
        body: {},
      });
      canvasConnected = false;
      setupPage();
      toast("Canvas disconnected. Saved submissions remain in your record.");
    }
  } catch (err) {
    toast(err.message);
  }
});
