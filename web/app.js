"use strict";
let appConfig = { mode: "demo", providers: [], canvasConfigured: false },
  sessionEpoch = 0,
  csrfToken = null,
  canvasConnected = false,
  accountToken = null,
  accountLink = null,
  authLoadingStartedAt = null;
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
  rosterAccounts = [],
  rosterWorkspace = { epoch: null, tab: 'members', search: '', filter: 'active', page: 0 },
  rosterCandidates = [],
  filter = "all",
  logs = [],
  busy = false,
  modalRevision = 0,
  submissionPageIndex = 0,
  submissionSearch = "",
  submissionMember = "",
  submissionOrder = "oldest",
  submissionDraft = null;
const modal = $("#modal"),
  main = $("#main"),
  person = $("#persona");
function setAuthLoading(active, message) {
  if (active && authLoadingStartedAt === null) authLoadingStartedAt = performance.now();
  if (!active) authLoadingStartedAt = null;
  if (message) $("#auth-loading-message").textContent = message;
  document.body.classList.toggle("signing-in", active);
  document.querySelector(".workspace").inert = active;
  document.querySelector(".workspace").setAttribute("aria-busy", String(active));
}
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
let scoreCategory, categoryHint;
const activeActivities = () => rules.activities.filter(category => category.enabled !== false);
const activity = (id) => rules.activities.find((a) => a.id === id);
const submissionActivity = submission => submission.activitySnapshot || activity(submission.activity) || { name: "Previous category", proof: "See the submitted evidence." };
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("visible"), 4000);
}
async function api(path, { method = "GET", body, raw = false, headers = {} } = {}) {
  const start = performance.now();
  const sensitive = /^\/api\/(auth\/|account\/|admin\/tier-import)/.test(path);
  const epoch = sessionEpoch,
    owner = user?.id,
    csrf = csrfToken;
  const current = () =>
    epoch === sessionEpoch && owner === user?.id && csrf === csrfToken;
  const controller = new AbortController();
  const timeoutMs = /^\/api\/(auth|account)\//.test(path) ? 45_000 : 135_000;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let response, payload;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        ...(user ? { "X-ATO-Expected-User": user.id } : {}),
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        ...(method === "POST"
          ? { "Content-Type": "application/json", "X-ATO-Demo": "1" }
          : {}),
        ...headers,
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
      request: sensitive ? "[redacted]" : body ? redact(body) : null,
      response: sensitive ? "[redacted]" : redact(payload),
    });
    logs = logs.slice(0, 50);
    if (!response.ok)
      throw Object.assign(Error(payload.error || "Request failed."), {
        status: response.status,
      });
    return payload;
  } catch (e) {
    const error = timedOut
      ? Error("The request timed out and its result was not confirmed. Check the current status before trying again.")
      : e;
    if ((!response || timedOut) && current()) {
      logs.unshift({
        method,
        path,
        status: timedOut ? "Request timed out" : "Network error",
        ms: Math.round(performance.now() - start),
        time: new Date().toLocaleTimeString(),
        request: sensitive ? "[redacted]" : body ? redact(body) : null,
        response: { error: error.message },
      });
      logs = logs.slice(0, 50);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const loading = (message, compact = false) => window.atoLoading.markup(message, compact);
function heading(kicker, title, description, action = "") {
  const signedIn = Boolean(user);
  const titleMarkup = `<h1${signedIn ? ' class="sr-only"' : ""}>${title}</h1>`;
  if (signedIn) return `${titleMarkup}${action ? `<div class="page-actions">${action}</div>` : ""}`;
  return `<div class="page-heading${signedIn ? " page-heading-compact" : ""}"><div>${kicker ? `<p class="eyebrow">${kicker}</p>` : ""}${titleMarkup}${description ? `<p>${description}</p>` : ""}</div>${action}</div>`;
}
function newButton() {
  return '<button class="button gold" data-action="new">+ New submission</button>';
}
function shield() {
  return '<svg width="18" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z"/><path d="m8 12 3 3 5-6"/></svg>';
}
function updateNavOverflow() {
  const nav = $("#nav");
  const overflow = nav.scrollWidth > nav.clientWidth + 1;
  $("#nav-prev").hidden = !overflow || nav.scrollLeft < 2;
  $("#nav-next").hidden = !overflow || nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 2;
}
function navigation() {
  $(".term").textContent = rules?.semester?.name || appConfig.semester?.name || "Current semester";
  const chair = user.role === "chair",
    pending = submissions.filter((s) => s.status === "pending").length;
  const links = chair
    ? [
        ["queue", "Review queue", pending],
        ["members", "Member progress"],
        ["leaderboard", "Leaderboard"],
        ["syllabi", "Classes"],
        ["roster", "Chapter roster"],
        ["semester", "Semester settings"],
        ["audit", "Review history"],
        ["profile", "My profile"],
        ["earn", "Point rules"],
        ["faq", "FAQ"],
      ]
    : [
        ["overview", "Overview"],
        ["submissions", "My submissions"],
        ["leaderboard", "Leaderboard"],
        ["classes", "My classes"],
        ["profile", "My profile"],
        ["earn", "Ways to earn points"],
        ["faq", "FAQ"],
      ];
  const nav = $("#nav");
  const previousScroll = nav.scrollLeft;
  nav.innerHTML = links
    .map(
      ([id, name, count]) =>
        `<a href="#${id}" class="${route() === id ? "active" : ""}"${route() === id ? ' aria-current="page"' : ""}>${name}${count ? `<span class="nav-count">${count}</span>` : ""}</a>`,
    )
    .join("");
  nav.scrollLeft = previousScroll;
  updateNavOverflow();
  const selected = nav.querySelector("a.active");
  if (selected) {
    const navBox = nav.getBoundingClientRect();
    const selectedBox = selected.getBoundingClientRect();
    if (selectedBox.left < navBox.left)
      nav.scrollLeft -= navBox.left - selectedBox.left + 8;
    else if (selectedBox.right > navBox.right)
      nav.scrollLeft += selectedBox.right - navBox.right + 8;
  }
  updateNavOverflow();
  $("#header-person").innerHTML =
    `${esc(user.name)}<span>${chair ? "Scholarship chair" : "Member"}${isDemo() ? " · demo" : ""}</span>`;
  $(".account-button .avatar").textContent = user.initials;
  paintHeaderPicture();
  person.value = user.id;
  $(".portal-label").textContent = chair
    ? "CHAIR WORKSPACE"
    : "SCHOLARSHIP PORTAL";
}
function route() {
  let p =
    location.hash.slice(1) || (user?.role === "chair" ? "queue" : "overview");
  if (["canvas", "api", "setup"].includes(p)) p = user?.role === "chair" ? "queue" : "overview";
  if (p === "access") p = "faq";
  if (user?.role === "chair" && ["overview", "submissions", "calendar"].includes(p))
    p = "queue";
  if (user?.role === "chair" && p === "classes") p = "syllabi";
  if (
    user?.role === "member" &&
    ["queue", "members", "roster", "audit", "semester", "credit-review", "syllabi"].includes(p)
  )
    p = "overview";
  return p;
}
async function loadSubmissionList() {
  const owner = user?.id, epoch = sessionEpoch;
  const current = () => user?.id === owner && sessionEpoch === epoch;
  // A refresh must contain one consistent snapshot, including the calendar and
  // summary counts. Each transfer is bounded; a concurrent change restarts once.
  for (let attempt = 0; attempt < 2; attempt++) {
    const items = [];
    let cursor = null;
    try {
      do {
        if (!current()) throw Error("Account changed. Refresh this view.");
        const page = await api('/api/submissions' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
        if (!current()) throw Error("Account changed. Refresh this view.");
        items.push(...page.submissions);
        cursor = page.nextCursor;
      } while (cursor);
      return { submissions: items };
    } catch (error) {
      if (error.status !== 409 || attempt || !current()) throw error;
    }
  }
}
async function refresh() {
  const account = user, epoch = sessionEpoch;
  const [s, p, me] = await Promise.all([
    loadSubmissionList(),
    api(account.role === "chair" ? "/api/members" : "/api/points"),
    api("/api/me"),
  ]);
  if (user !== account || sessionEpoch !== epoch || me.user?.id !== account.id || me.user.role !== account.role) return;
  user = me.user;
  submissions = s.submissions;
  if (user.role === "chair") roster = p.members;
  else points = p;
  render();
}
function rows(items, chair = false) {
  if (!items.length)
    return `<div class="empty"><h3>${filter === "pending" ? "YOU’RE ALL CAUGHT UP." : "NO SUBMISSIONS HERE YET."}</h3><p>${chair ? "Try another status to see previous decisions." : "Submit an activity to start building your points."}</p>${chair ? "" : newButton()}</div>`;
  const pages = Math.max(1, Math.ceil(items.length / 50));
  submissionPageIndex = Math.min(submissionPageIndex, pages - 1);
  const page = items.slice(submissionPageIndex * 50, (submissionPageIndex + 1) * 50);
  const pagination = pages > 1 ? `<nav class="submission-pagination" aria-label="Submission pages"><button class="button ghost small" data-action="submissions-page" data-page="${submissionPageIndex - 1}" ${submissionPageIndex === 0 ? 'disabled' : ''}>Previous</button><span role="status">${submissionPageIndex * 50 + 1}–${Math.min(items.length, (submissionPageIndex + 1) * 50)} of ${items.length}</span><button class="button ghost small" data-action="submissions-page" data-page="${submissionPageIndex + 1}" ${submissionPageIndex === pages - 1 ? 'disabled' : ''}>Next</button></nav>` : '';
  return `<div class="table-wrap"><table class="submission-table"><thead><tr>${chair ? "<th>Member</th>" : ""}<th>Activity</th><th>Date</th><th>Status</th><th class="right">Points</th></tr></thead><tbody>${page.map((s) => `<tr class="submission-row" data-action="detail" data-id="${esc(s.id)}">${chair ? `<td class="submission-member"><strong>${esc(s.memberName)}</strong><small>${s.memberTier ? "Tier " + s.memberTier : "Member submission"}</small></td>` : ""}<td class="submission-main"><button class="submission-title" type="button" data-action="detail" data-id="${esc(s.id)}" aria-label="${chair && s.status === "pending" ? "Review" : "Open"} submission: ${esc(s.title)}${chair ? ` by ${esc(s.memberName)}` : ""}">${esc(s.title)}</button><small>${esc(submissionActivity(s).name)} · ${esc(s.course)}</small></td><td>${date(s.date)}</td><td>${status(s.status)}${chair && ["approved", "denied"].includes(s.status) ? `<button class="table-link submission-correct" type="button" data-action="correct-submission" data-id="${esc(s.id)}">Edit decision / points</button>` : ""}</td><td class="right"><strong>${s.status === "approved" ? "+" + s.awarded : s.status === "denied" ? "—" : money(s.estimate) + "*"}</strong></td></tr>`).join("")}</tbody></table></div>${pagination}`;
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
      "",
    ) +
    `<h2 class="overview-greeting">Hello, ${esc(user.name)}</h2><div id="leader-honor"></div><div class="page-actions overview-submit">${newButton()}</div><div class="overview-grid"><div class="overview-points-stack"><section class="points-panel"><p class="eyebrow">APPROVED POINTS</p><div class="points-number">${points.approved} <span>/ ${points.goal}</span></div><p>Semester goal · Tier ${user.tier}</p><p>${points.adjustmentPoints ? `${points.adjustmentPoints > 0 ? "+" : ""}${points.adjustmentPoints} manual adjustment · ` : ""}<button class="text-btn" data-action="adjust-points" data-id="${esc(user.id)}">Point details</button></p><div class="progress" role="progressbar" aria-label="Approved semester points" aria-valuenow="${points.approved}" aria-valuemin="0" aria-valuemax="${Math.max(points.goal, points.approved)}"><span class="progress-approved" style="width:${approvedWidth}%"></span>${points.pending > 0 && pendingWidth > 0 ? `<span class="progress-pending" aria-hidden="true" style="left:${approvedWidth}%;width:${pendingWidth}%"></span>` : ""}</div><div class="points-foot"><span class="points-foot-detail"><span>${remaining ? remaining + " points to your semester goal" : "Semester point goal reached"}</span>${points.pending > 0 ? `<span class="pending-count" aria-label="${money(points.pendingEstimate)} estimated points pending">${money(points.pendingEstimate)} pending</span>` : ""}</span><strong>${percent}%</strong></div></section><div class="stats-row overview-stats"><div class="mini-stat"><strong>${points.pending}</strong><span><b>Awaiting review</b>${money(points.pendingEstimate)} estimated points</span></div><div class="mini-stat"><strong>${points.approvedCount}</strong><span><b>Approved submissions</b>Counted toward your goal</span></div><div class="mini-stat"><strong>${money(points.multiplier)}×</strong><span><b>Credit-load multiplier</b>${user.creditsManaged ? esc(user.credits) : 'N/A'} credit hours${user.creditsManaged ? '' : ' · Awaiting class approval'}</span></div></div></div><section class="panel checkpoint calendar-trigger">${window.atoCheckpointCalendar(checkpointDate(), checkpoint)}</section></div><section class="panel recent"><div class="section-heading"><h2>RECENT SUBMISSIONS</h2><a href="#submissions">View all</a></div>${rows(submissions.slice(0, 4))}</section><p class="bottom-note">${shield()}Academic evidence stays private to you and the Chair.</p><p class="footnote">${isDemo() ? "Demo date" : "As of"}: ${esc(rules.today)}. *Pending estimates are not awarded points.</p>`;
  const calendarTrigger = main.querySelector(".calendar-trigger");
  let calendarOffset = 0;
  calendarTrigger.onclick = event => {
    const control = event.target.closest("[data-calendar-shift]");
    if (control) {
      calendarOffset = control.dataset.calendarShift === "today" ? 0 : calendarOffset + Number(control.dataset.calendarShift);
      const shift = control.dataset.calendarShift;
      calendarTrigger.innerHTML = window.atoCheckpointCalendar(checkpointDate(), checkpoint, undefined, calendarOffset);
      calendarTrigger.querySelector(`[data-calendar-shift="${shift}"]`).focus();
    } else if (event.target.closest(".mini-calendar-open")) openCalendar();
  };
  calendarTrigger.onkeydown = event => { if (event.target.classList.contains("mini-calendar-open") && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openCalendar(); } };
  window.atoCelebrate.goal(user.id + ":" + (rules.semester?.name || "semester"), points.approved, points.goal);
  loadLeaderHonor(main.querySelector('#leader-honor'));
  window.atoCelebrate.checkpoint({ memberId: user.id, role: user.role, approved: points.approved, today: rules.today, checkpoints: rules.checkpoints, semesterKey: rules.semester?.startDate || rules.semester?.name || 'semester' });
}
function leaderboardPage() {
  main.innerHTML = heading('', 'Leaderboard', '') + `<section class="panel leaderboard-panel"><h2>Chapter leaderboard</h2><p class="muted">Approved points this semester, highest first. Gold, silver and bronze mark the first three places; tied scores share a place. Pending submissions are excluded.</p><div id="leaderboard-content"></div></section>`;
  loadLeaderboard(main.querySelector('#leaderboard-content'));
}
async function loadLeaderboard(container) {
  const account = user;
  const isCurrent = () => user === account && route() === 'leaderboard' && container.isConnected;
  container.innerHTML = loading('Loading chapter points…', true);
  try {
    const { mountLeaderboard } = await import('/leaderboard-ui.mjs');
    if (isCurrent()) await mountLeaderboard(container, { api, esc, loading, isCurrent });
  } catch (error) {
    if (isCurrent()) container.innerHTML = `<p class="error">${esc(error.message)}</p><button class="button ghost" type="button">Try again</button>`;
    container.querySelector('button')?.addEventListener('click', () => loadLeaderboard(container));
  }
}
async function loadLeaderHonor(container) {
  const account = user;
  const isCurrent = () => user === account && account.role === 'member' && route() === 'overview' && container.isConnected;
  try {
    const { mountLeaderHonor } = await import('/leaderboard-ui.mjs');
    if (isCurrent()) await mountLeaderHonor(container, { api, esc, isCurrent });
  } catch { /* The overview remains usable if optional recognition is unavailable. */ }
}
function filters() {
  return `<div class="filters" aria-label="Filter submissions">${["all", "pending", "approved", "denied"].map((f) => `<button class="filter ${f === filter ? "active" : ""}" data-action="filter" data-value="${f}" aria-pressed="${f === filter}">${f === "all" ? "All submissions" : f === "pending" ? "Pending review" : f[0].toUpperCase() + f.slice(1)} <span>(${submissions.filter((s) => f === "all" || s.status === f).length})</span></button>`).join("")}</div>`;
}
function visibleSubmissions() {
  const query = submissionSearch.trim().toLocaleLowerCase();
  return submissions.filter(item => (filter === 'all' || item.status === filter) &&
    (user.role !== 'chair' || !submissionMember || item.owner === submissionMember) &&
    (!query || [item.title, item.course, item.memberName, submissionActivity(item).name].join(' ').toLocaleLowerCase().includes(query)))
    .sort((a, b) => {
      const direction = user.role === 'chair' && submissionOrder === 'oldest' ? 1 : -1;
      return direction * a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id);
    });
}
function submissionToolbar() {
  const chair = user.role === 'chair';
  const people = [...new Map(submissions.map(item => [item.owner, item.memberName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  return `<div class="submission-toolbar"><div class="field"><label for="submission-search">Search ${chair ? 'member, assignment or class' : 'assignment or class'}</label><input id="submission-search" type="search" value="${esc(submissionSearch)}" placeholder="Search submissions" autocomplete="off"></div>${chair ? `<div class="field"><label for="submission-member">Member</label><select id="submission-member"><option value="">All members</option>${people.map(([id, name]) => `<option value="${esc(id)}"${submissionMember === id ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></div><div class="field"><label for="submission-order">Review order</label><select id="submission-order"><option value="oldest"${submissionOrder === 'oldest' ? ' selected' : ''}>Oldest first</option><option value="newest"${submissionOrder === 'newest' ? ' selected' : ''}>Newest first</option></select></div>` : ''}</div><p id="submission-result-count" class="footnote" role="status" aria-live="polite"></p>`;
}
function paintSubmissionResults() {
  const destination = $('#submission-results');
  if (!destination) return;
  const visible = visibleSubmissions();
  destination.innerHTML = visible.length ? rows(visible, user.role === 'chair') :
    '<div class="empty"><h3>No matching submissions</h3><p>Try another search or status.</p><button class="button ghost" data-action="clear-submission-filters">Clear filters</button></div>';
  $('#submission-result-count').textContent = `${visible.length} ${visible.length === 1 ? 'submission' : 'submissions'} in this view`;
  const next = $('[data-action="review-next"]');
  if (next) next.disabled = !visible.some(item => item.status === 'pending');
}
function wireSubmissionToolbar() {
  $('#submission-search').oninput = event => { submissionSearch = event.target.value; submissionPageIndex = 0; paintSubmissionResults(); };
  if (user.role === 'chair') {
    $('#submission-member').onchange = event => { submissionMember = event.target.value; submissionPageIndex = 0; paintSubmissionResults(); };
    $('#submission-order').onchange = event => { submissionOrder = event.target.value; submissionPageIndex = 0; paintSubmissionResults(); };
  }
  paintSubmissionResults();
}
function submissionPage() {
  main.innerHTML =
    heading(
      "",
      "My submissions",
      "",
      newButton(),
    ) +
    filters() + submissionToolbar() +
    `<section class="panel recent" id="submission-results"></section><p class="footnote">*Estimates await chair approval. Denied submissions earn no points.</p>`;
  wireSubmissionToolbar();
}
function queue() {
  const pending = submissions.filter(item => item.status === 'pending');
  const approved = submissions.filter(item => item.status === 'approved');
  main.innerHTML = heading('', 'Review queue', '') +
    `<section class="panel review-workflow"><div><h2>Review assignments</h2><p>Work through pending submissions, with evidence beside each decision.</p></div><div class="heading-actions"><button class="button ghost" data-action="refresh-submissions">Refresh</button><a class="button ghost" href="#syllabi">Review classes</a><button class="button gold" data-action="review-next">Review next submission</button></div></section><div class="stats-row chair-stats"><div class="mini-stat"><strong>${pending.length}</strong><span><b>Awaiting review</b>${new Set(pending.map(item => item.owner)).size} members</span></div><div class="mini-stat"><strong>${approved.length}</strong><span><b>Approved this semester</b>${approved.reduce((sum, item) => sum + item.awarded, 0)} points awarded</span></div><div class="mini-stat"><strong>${roster.filter(member => member.approved < member.checkpoint).length}</strong><span><b>Below next checkpoint</b>${date(checkpointDate())}</span></div></div>${filters()}${submissionToolbar()}<section class="panel recent" id="submission-results"></section><p class="footnote">Whole-point awards are required. Explain denials or changes to the estimated points.</p>`;
  wireSubmissionToolbar();
}

function membersPage() {
  main.innerHTML =
    heading(
      "",
      "Member points",
      "Approved points and checkpoint targets for each member.",
    ) +
    `<section class="panel"><div class="table-wrap"><table><thead><tr><th>Member</th><th>Tier</th><th>Credits</th><th>Approved / goal</th><th>Pending</th><th>${date(checkpointDate())} target</th><th>Manage</th></tr></thead><tbody>${roster.map((m) => `<tr><td><div class="table-person"><span class="avatar">${m.initials}</span><div><strong>${esc(m.name)}</strong><small>${isDemo() ? "Fictional member" : esc(m.email || "")}</small></div></div></td><td>Tier ${m.tier}</td><td>${m.creditsManaged ? esc(m.credits) : 'N/A'} · ${money(m.multiplier)}×</td><td><strong>${m.approved} / ${m.goal}</strong><div class="member-progress"><span style="width:${Math.min(100, (m.approved / m.goal) * 100)}%"></span></div></td><td>${m.pending ? `<button class="table-link" data-action="review-member" data-id="${esc(m.id)}" aria-label="Review ${m.pending} pending submissions from ${esc(m.name)}">${m.pending} to review</button>` : "0"}</td><td><span class="status ${m.approved >= m.checkpoint ? "approved" : "pending"}">${Math.max(0, m.checkpoint - m.approved)} points to go</span></td><td><button class="table-link" data-action="edit-academic-settings" data-id="${esc(m.id)}" aria-label="Manage ${esc(m.name)}">Account settings</button><br><button class="table-link" data-action="manage-credits" data-id="${esc(m.id)}">Manage credits</button><br><button class="table-link" data-action="adjust-points" data-id="${esc(m.id)}" aria-label="Adjust points for ${esc(m.name)}">Adjust points</button></td></tr>`).join("")}</tbody></table></div></section><div class="notice" style="margin-top:24px">Point totals are separate from required study-night attendance. The portal does not determine disciplinary outcomes.</div>`;
}
async function openPointAdjustments(memberId) {
  const owner = user.id, epoch = sessionEpoch;
  openModal(user.role === "chair" ? "ADJUST POINTS" : "POINT DETAILS", "", '<div id="point-adjustments"></div>');
  const container = $("#point-adjustments");
  const current = () => container.isConnected && modal.open && user?.id === owner && sessionEpoch === epoch;
  container.innerHTML = loading("Loading point history…");
  try {
    const { mountPointAdjustments } = await import("/point-adjustment-ui.mjs");
    if (!current()) return;
    await mountPointAdjustments(container, { api, esc, loading, memberId,
      canEdit: user.role === "chair", isCurrent: current,
      onSaved: async view => {
        if (!current()) return;
        roster = roster.map(member => member.id === memberId ? { ...member, approved: view.approved } : member);
        rosterAccounts = rosterAccounts.map(member => member.id === memberId ? { ...member, approved: view.approved } : member);
        if (route() === 'roster') await renderRosterMembers(); else render();
      } });
  } catch (error) { if (current()) container.innerHTML = `<p class="error">${esc(error.message)}</p>`; }
}
async function openCheckpointQuotas() {
  if (user.role !== "chair") return;
  const owner = user.id;
  openModal("CHECKPOINT QUOTAS", "", '<div id="checkpoint-editor"></div>');
  const container = $("#checkpoint-editor");
  const current = () => container.isConnected && modal.open && user?.id === owner;
  try {
    const { mountCheckpointEditor } = await import("/checkpoint-ui.mjs");
    if (!current()) return;
    await mountCheckpointEditor(container, { api, esc, loading, isCurrent: current,
      onSaved: async () => {
        rules = await api("/api/rules");
        if (!current()) return;
        await refresh();
        if (current()) { modal.close(); toast("Checkpoint quotas saved."); }
      } });
  } catch (error) {
    if (current()) container.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}
async function openPointCategories() {
  if (user.role !== "chair") return;
  const owner = user.id;
  openModal("MANAGE POINT CATEGORIES", "", '<div id="category-manager"></div>');
  const container = $("#category-manager");
  const current = () => container.isConnected && modal.open && user?.id === owner;
  container.innerHTML = loading("Loading point categories…");
  try {
    const { mountCategoryManager } = await import("/category-ui.mjs");
    if (!current()) return;
    await mountCategoryManager(container, { api, esc, loading, isCurrent: current,
      onSaved: async () => {
        const nextRules = await api("/api/rules");
        if (!current()) return;
        rules = nextRules;
        await refresh();
      } });
  } catch (error) {
    if (current()) container.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}
function earnPage() {
  main.innerHTML =
    heading(
      "",
      "Point rules",
      "Point values, claim limits, and checkpoint targets.",
      user.role === "chair" ? '<button class="button ghost" data-action="manage-point-categories">Manage point categories</button><button class="button gold" data-action="edit-checkpoint-quotas">Edit checkpoint quotas</button>' : "",
    ) +
    `<div class="notice"><strong>Submit within 14 days.</strong> Include credible evidence. Never claim one activity twice.</div><div class="rules-grid">${activeActivities().map((a) => `<article class="rule-card"><div class="section-heading"><h3>${esc(a.name.toUpperCase())}</h3><span class="rule-points">${esc(a.points)} <small>PTS</small></span></div><p>Per ${esc(a.mode === "hourly" ? "hour" : a.unit)}. ${esc(a.proof)}</p>${categoryHint(a) ? `<p class="category-rule-hint">${esc(categoryHint(a))}</p>` : ""}</article>`).join("") || '<p class="empty">No point categories are available right now.</p>'}</div><div class="notice" style="margin-top:24px"><strong>Policy decisions still needed</strong><p>The chapter uses the page-5 GPA ranges: Tier 3 begins at 2.70, and Tier 4 covers 2.50–2.69. The plan prohibits fractional points without specifying rounding. The portal uses chair-assigned tiers and requires a note for any adjusted award.</p><p>The configured convention is Monday–Sunday weeks. Only explicit study categories share the study cap; assignment claim dates use the date entered. The chair must confirm these conventions and the end-of-semester closing date before launch.</p></div>`;
}
function applyClassReview(result) {
  if (result.results) { result.results.forEach(applyClassReview); return; }
  if (result.member) {
    roster = roster.map(member => member.id === result.member.id ? { ...member, ...result.member } : member);
    rosterAccounts = rosterAccounts.map(member => member.id === result.member.id ? { ...member, ...result.member } : member);
  }
  const estimates = new Map((result.pendingEstimates || []).map(item => [item.id, item.estimate]));
  submissions = submissions.map(item => estimates.has(item.id) && item.status === 'pending' ? { ...item, estimate: estimates.get(item.id) } : item);
  navigation();
}
async function syllabusReviewPage() {
  if (user.role !== "chair") return;
  const owner = user.id, epoch = sessionEpoch;
  main.innerHTML = heading("", "Classes", "") + `<section class="panel syllabus-shell">${loading("Loading classes…")}</section>`;
  const container = main.querySelector(".syllabus-shell");
  const isCurrent = () => user?.id === owner && sessionEpoch === epoch && route() === "syllabi" && container.isConnected;
  try {
    const { mountSyllabusQueue } = await import("/syllabus-ui.mjs");
    if (isCurrent()) await mountSyllabusQueue(container, { api, esc, loading, isCurrent, onReviewed: result => {
      if (user?.id === owner && sessionEpoch === epoch) applyClassReview(result);
    } });
  } catch (error) { if (isCurrent()) container.innerHTML = `<p class="error">${esc(error.message)}</p>`; }
}
async function manageMemberCredits(memberId) {
  if (user?.role !== 'chair') return;
  const member = rosterAccounts.find(row => row.id === memberId) || roster.find(row => row.id === memberId);
  if (!member) return;
  const owner = user.id, epoch = sessionEpoch;
  openModal('MANAGE CREDITS', esc(member.name), `<p class="notice info">Credit hours come from approved classes. Approve a pending class or correct an existing decision below.${member.creditsManaged ? '' : ' Starting hours show N/A until the first class is approved.'}</p><div id="member-class-reviews">${loading('Loading classes…')}</div>`);
  const container = $('#member-class-reviews');
  const isCurrent = () => user?.id === owner && sessionEpoch === epoch && modal.open && container.isConnected;
  try {
    const { mountSyllabusQueue } = await import('/syllabus-ui.mjs');
    if (isCurrent()) await mountSyllabusQueue(container, { api, esc, loading, isCurrent, ownerFilter: memberId, selectedFilter: 'all', onReviewed: result => {
      if (user?.id !== owner || sessionEpoch !== epoch) return;
      applyClassReview(result);
      if (route() === 'roster') renderRosterMembers();
      else if (route() === 'members') membersPage();
    } });
  } catch (error) { if (isCurrent()) container.innerHTML = `<p class="error">${esc(error.message)}</p>`; }
}

async function loadSubmissionSyllabus(container, submission) {
  const owner = user.id;
  const isCurrent = () => user?.id === owner && modal.open && container.isConnected;
  try {
    const { mountSubmissionSyllabus } = await import("/syllabus-ui.mjs");
    if (isCurrent()) mountSubmissionSyllabus(container, submission.syllabus, { api, esc, loading, isCurrent });
  } catch (error) { if (isCurrent()) container.innerHTML = `<p class="error">${esc(error.message)}</p>`; }
}
async function openCalendar() {
  if (user.role !== "member" || document.querySelector(".calendar-dialog")) return;
  const owner = user.id;
  const dialog = document.createElement("dialog");
  dialog.className = "calendar-dialog";
  dialog.setAttribute("aria-label", "My calendar");
  dialog.innerHTML = `<div class="calendar-dialog-heading"><h2>My calendar</h2><button type="button" class="button ghost small" aria-label="Close calendar">Close</button></div><section class="member-calendar-shell">${loading("Loading calendar…")}</section>`;
  document.body.append(dialog);
  dialog.querySelector("button").onclick = () => dialog.close();
  dialog.addEventListener("click", event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
  const container = dialog.querySelector(".member-calendar-shell");
  try {
    const { mountMemberCalendar } = await import("/member-calendar.mjs");
    if (!dialog.open || user?.id !== owner) return;
    mountMemberCalendar(container, { user, rules, points, submissions, esc, openSubmission: detail, fullscreen: false });
  } catch (error) { if (dialog.open) container.innerHTML = `<p class="error">${esc(error.message)}</p>`; }
}

let headerPictureCache = null, headerPictureEpoch = 0;
async function paintHeaderPicture(force = false) {
  const owner = user?.id, avatar = $(".account-button .avatar");
  if (!owner || !avatar || user.role !== "member") return;
  const paint = image => {
    if (user?.id !== owner) return;
    avatar.textContent = user.initials;
    if (image) { const img = document.createElement("img"); img.alt = "Your profile picture"; img.src = image; img.onerror = () => { if (user?.id === owner) avatar.textContent = user.initials; }; avatar.replaceChildren(img); }
  };
  if (!force && headerPictureCache?.owner === owner) { paint(headerPictureCache.image); return; }
  const epoch = ++headerPictureEpoch;
  headerPictureCache = {owner, image:null};
  try { const result = await api("/api/profile/picture"); if (user?.id === owner && epoch === headerPictureEpoch) { headerPictureCache = {owner,image:result.image}; paint(result.image); } } catch { /* Keep initials if the picture is unavailable. */ }
}
async function loadProfilePicture(container) {
  const owner = user.id;
  const isCurrent = () => user?.id === owner && container.isConnected;
  try {
    const { mountPicture } = await import("/picture-ui.mjs");
    if (isCurrent()) await mountPicture(container, { api, esc, loading, isCurrent, name: user.name, onSaved: () => paintHeaderPicture(true), config: appConfig });
  } catch (error) { if (isCurrent()) container.innerHTML = `<p class="error">${esc(error.message)}</p>`; }
}
function mountPasswordForm(container) {
  if (!appConfig.chapterAuth?.enabled || isDemo()) {
    container.innerHTML = '<h2>Change password</h2><p>Password changes are available for real chapter accounts. Public demo passwords stay unchanged.</p>';
    return;
  }
  container.innerHTML = `<h2>Change password</h2><form id="change-password-form"><div class="field"><label for="current-password">Current password</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required maxlength="1024"></div><div class="field"><label for="profile-new-password">New password</label><input id="profile-new-password" name="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="1024"><small>At least 12 characters.</small></div><div class="field"><label for="profile-confirm-password">Confirm new password</label><input id="profile-confirm-password" name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="1024"></div><p class="muted">Changing your password signs you out on all devices. Members save a new recovery key on their next sign-in.</p><div class="password-feedback" role="status" aria-live="polite"></div><button class="button gold" type="submit">Change password</button></form>`;
  const form = container.querySelector("form"), feedback = container.querySelector(".password-feedback");
  const owner = user.id, epoch = sessionEpoch;
  const sameAccount = () => user?.id === owner && sessionEpoch === epoch;
  let pending = false;
  form.onsubmit = async event => {
    event.preventDefault();
    if (pending || !sameAccount()) return;
    const body = Object.fromEntries(new FormData(form));
    if (body.newPassword !== body.confirmPassword) { feedback.textContent = "The new passwords do not match."; return; }
    pending = true;
    const controls = [...form.querySelectorAll("input,button")];
    controls.forEach(control => control.disabled = true);
    feedback.innerHTML = loading("Changing password…", true);
    try {
      await api("/api/account/password", {method:"POST",body});
      if (!sameAccount()) return;
      form.reset();
      rosterAccounts = []; rosterCandidates = [];
      loginPage();
      toast("Password changed. Sign in again using your new password.");
    } catch (error) {
      if (!sameAccount()) return;
      if (!error.status || error.status >= 500) {
        // A lost response can follow successful password replacement and session
        // revocation. Do not keep an apparently signed-in workspace on screen.
        rosterAccounts = []; rosterCandidates = [];
        loginPage();
        const message = `${error.message} Try signing in with your new password first. If it does not work, try your previous password or account recovery.`;
        const notice = $("#form-error");
        if (notice) notice.textContent = message;
        else toast(message);
      } else if (container.isConnected) feedback.textContent = error.message;
    } finally {
      pending = false;
      if (sameAccount() && container.isConnected) controls.forEach(control => control.disabled = false);
    }
  };
}
async function profilePage() {
  if (user.role === "chair") {
    main.innerHTML = heading("", "My profile", "") + '<section class="panel password-shell"></section>';
    mountPasswordForm(main.querySelector(".password-shell"));
    return;
  }
  const owner = user.id, epoch = sessionEpoch;
  main.innerHTML = heading("", "My profile", "") + `<div class="profile-layout">
    <div class="profile-column profile-account" role="group" aria-label="Account information"><section class="picture-shell panel">${loading("Loading profile picture…")}</section><section class="badge-shell panel">${loading("Loading badge details…", true)}</section></div>
    <div class="profile-column profile-academic" role="group" aria-label="Academic information"><section class="profile-shell panel">${loading("Loading profile…")}</section></div>
  </div>`;
  main.querySelector(".profile-account").insertAdjacentHTML("beforeend", '<section class="panel password-shell"></section>');
  mountPasswordForm(main.querySelector(".password-shell"));
  main.querySelector(".profile-account").insertAdjacentHTML("beforeend", '<section class="panel recovery-shell"></section>');
  mountRecoverySettings(main.querySelector('.recovery-shell'));
  const container = main.querySelector(".profile-shell");
  loadProfilePicture(main.querySelector(".picture-shell"));
  const badgeContainer = main.querySelector(".badge-shell");
  import("/badge-ui.mjs").then(({ mountBadgeSettings }) => {
    const isCurrent = () => user?.id === owner && sessionEpoch === epoch && route() === "profile";
    if (!isCurrent() || !badgeContainer.isConnected) return;
    return mountBadgeSettings(badgeContainer, { api, esc, loading, isCurrent,
      demo: isDemo() || !appConfig.chapterAuth?.enabled || user.email?.endsWith("@pilot.invalid") });
  }).catch(error => {
    if (user?.id === owner && sessionEpoch === epoch && badgeContainer.isConnected)
      badgeContainer.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p>`;
  });
  try {
    const { mountProfile } = await import("/profile-ui.mjs");
    if (user?.id !== owner || route() !== "profile" || !container.isConnected) return;
    await mountProfile(container, { api, esc, loading, config: appConfig, onSubmitAssignment: course => newSubmission({ classId: course.id }),
      isCurrent: () => user?.id === owner && route() === "profile" && container.isConnected });
  } catch (error) {
    if (container.isConnected) container.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}
async function classesPage() {
  if (user.role !== 'member') return;
  const owner = user.id, epoch = sessionEpoch;
  main.innerHTML = heading('', 'My classes', '', newButton()) + `<section class="panel profile-shell">${loading('Loading classes…')}</section>`;
  const container = main.querySelector('.profile-shell');
  const isCurrent = () => container.isConnected && user?.id === owner && sessionEpoch === epoch && route() === 'classes';
  try {
    const { mountProfile } = await import('/profile-ui.mjs');
    if (isCurrent()) await mountProfile(container, { api, esc, loading, config: appConfig, isCurrent,
      onSubmitAssignment: course => newSubmission({ classId: course.id }) });
  } catch (error) { if (isCurrent()) container.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p>`; }
}
async function loadCoursePicker(fields = {}, supplied = null) {
  const input = $("#course"), owner = user.id, epoch = sessionEpoch;
  const indicator = document.createElement("div");
  indicator.className = "course-loading";
  indicator.innerHTML = loading("Loading classes…", true);
  input.after(indicator);
  try {
    const data = supplied ? supplied.then(result => { if (result.error) throw result.error; return result.profile; }) : api('/api/classes');
    const [profile, { mountCoursePicker }] = await Promise.all([data, import("/profile-ui.mjs")]);
    if (input.isConnected && user?.id === owner && sessionEpoch === epoch) {
      mountCoursePicker(input, profile.classes, esc, { classesHref: '#classes', onChange: () => {
        updateSubmissionButtons(input.closest('form')); rememberSubmissionDraft(input.closest('form'), true);
      } });
      const category = activity($('#activity').value);
      if (category) updateSubmissionPrompts(category); else input.coursePicker.update(null);
      input.coursePicker.restore(fields);
      estimate();
      updateSubmissionButtons(input.closest('form'));
    }
  } catch {
    if (input.isConnected) {
      indicator.innerHTML = '<small>Classes could not load. Your form is still here.</small><button class="text-btn" type="button">Retry loading classes</button>';
      indicator.querySelector('button').onclick = () => { indicator.remove(); loadCoursePicker(fields); };
    }
    return;
  } finally {
    if (indicator.querySelector(".loading-state")) indicator.remove();
  }
}
async function faqPage() {
  const owner = user.id;
  main.innerHTML = heading("", "FAQ", "") + `<section class="faq-shell" aria-label="Frequently asked questions">${loading("Loading FAQ…")}</section>`;
  const container = main.querySelector(".faq-shell");
  try {
    const { mountFaq } = await import("/faq-ui.mjs");
    if (!container.isConnected || user?.id !== owner) return;
    await mountFaq({ container, user, api, demo: isDemo(),
      isCurrent: () => user?.id === owner && route() === "faq" });
  } catch (error) {
    if (container.isConnected) container.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p>`;
  }
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
      leaderboard: leaderboardPage,
      earn: earnPage,
      canvas: canvasPage,
      faq: faqPage,
      profile: profilePage,
      classes: classesPage,
      "credit-review": () => { location.hash = "syllabi"; },
      syllabi: syllabusReviewPage,
      api: apiPage,
      roster: rosterPage,
      semester: semesterPage,
      audit: auditPage,
    })[route()] || overview
  )();
}
function openModal(title, subtitle, body) {
  rememberSubmissionDraft();
  modalRevision++;
  modal.classList.remove('submission-review-dialog');
  $("#modal-content").innerHTML =
    `<div class="modal-heading"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ""}</div><button class="close" data-action="close" aria-label="Close dialog">×</button></div>${body}`;
  if (!modal.open) modal.showModal();
}
function mountRecoverySettings(container) {
  if (isDemo() || !appConfig.chapterAuth?.enabled) { container.remove(); return; }
  container.innerHTML = `<h2>Recovery key</h2><p>Lost your saved words? Replace your key here. Your previous key will stop working.</p><form><div class="field"><label for="recovery-current-password">Current password</label><input id="recovery-current-password" name="currentPassword" type="password" autocomplete="current-password" maxlength="1024" required></div><div class="recovery-feedback" role="status"></div><button class="button ghost" type="submit">Replace recovery key</button></form>`;
  const form = container.querySelector('form'), feedback = container.querySelector('.recovery-feedback');
  form.onsubmit = async event => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form)), button = form.querySelector('button');
    button.disabled = true; feedback.innerHTML = loading('Replacing recovery key…', true);
    try {
      const result = await api('/api/account/recovery-key', {method:'POST', body});
      if (!container.isConnected) return;
      form.reset(); feedback.textContent = '';
      showRecoveryKeyModal(result.recoveryKey, () => toast('New recovery key saved.'));
    } catch (error) { if (container.isConnected) feedback.textContent = error.message; }
    finally { button.disabled = false; }
  };
}
function recoveryKeyContent(key) {
  return `<div class="notice info"><strong>Save these 16 words now.</strong><p>Keep these words somewhere private so you can reset your password if you lose access to your email. The Scholarship Chair cannot see or retrieve it.</p></div><p class="recovery-key" aria-label="Your new 16-word recovery key">${esc(key)}</p><label class="recovery-confirm"><input type="checkbox" id="saved-recovery-key"> I saved this key in a private place.</label><div class="recovery-feedback" role="status" aria-live="polite"></div><div class="modal-actions"><button class="button ghost" id="recovery-key-replace" type="button">Get a new key</button><button class="button gold" id="recovery-key-done" type="button" disabled>Continue</button></div>`;
}
function showRecoveryKeyModal(key, onSaved) {
  openModal("YOUR RECOVERY KEY", "Shown once for this semester", recoveryKeyContent(key));
  modal.dataset.recoveryLocked = "1";
  modal.querySelector(".modal-heading .close").hidden = true;
  $("#saved-recovery-key").onchange = (event) => {
    $("#recovery-key-done").disabled = !event.target.checked;
  };
  const feedback = modal.querySelector('.recovery-feedback');
  let pending = false;
  $("#recovery-key-done").onclick = async () => {
    if (pending) return;
    pending = true;
    const controls = [...modal.querySelectorAll('button,input')];
    controls.forEach(control => control.disabled = true);
    feedback.innerHTML = loading('Saving recovery confirmation…', true);
    try {
      await api('/api/account/recovery-key/confirm', {method:'POST', body:{recoveryKey:key}});
      delete modal.dataset.recoveryLocked;
      modal.close();
      $('#modal-content').replaceChildren();
      onSaved?.();
    } catch (error) { feedback.textContent = error.message; }
    finally { pending = false; controls.forEach(control => control.disabled = false); }
  };
  $("#recovery-key-replace").onclick = async () => {
    if (pending) return;
    pending = true;
    feedback.innerHTML = loading('Getting a new key…', true);
    try {
      const result = await api('/api/account/recovery-key', {method:'POST', body:{}});
      showRecoveryKeyModal(result.recoveryKey, onSaved);
    } catch (error) { feedback.textContent = error.message; }
    finally { pending = false; }
  };
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
  return `<div class="activity-picker"><input id="activity-search" type="text" list="activity-types" required aria-describedby="activity-help" placeholder="Choose or type an activity" autocomplete="off"><datalist id="activity-types"></datalist><input id="activity" name="activity" type="hidden" value=""></div><small id="activity-help">Type to narrow the options, then choose an activity from the list.</small>`;
}
function wireActivityPicker() {
  const search = $("#activity-search"), selected = $("#activity");
  let rendered = selected.value;
  $('#activity-types').innerHTML = activeActivities().map(item => `<option value="${esc(item.name)}"></option>`).join('');
  function chooseActivity() {
    if (selected.value) rendered = selected.value;
    const match = activeActivities().find(item => item.name.toLowerCase() === search.value.trim().toLowerCase());
    selected.value = match?.id || '';
    search.setCustomValidity(match || !search.value ? '' : 'Choose an activity type from the suggestions.');
    $('#claim-form').dataset.dirty = 'true';
    // Typing a partial search must not discard the previous activity's grade.
    // Only an explicit different valid choice changes the requested fields.
    if (match && match.id !== rendered) { rendered = match.id; updateForm(); }
    else { estimate(); updateSubmissionButtons(); }
  }
  search.addEventListener('input', chooseActivity);
  search.addEventListener('change', chooseActivity);
}
function currentSubmissionDraft() {
  return submissionDraft?.owner === user?.id && submissionDraft.epoch === sessionEpoch &&
    submissionDraft.semester === JSON.stringify(rules?.semester) ? submissionDraft : null;
}
function rememberSubmissionDraft(form = $('#claim-form'), changed = false) {
  if (!form || form.dataset.submitted || form.dataset.saving || form.dataset.owner !== user?.id || Number(form.dataset.epoch) !== sessionEpoch) return;
  if (changed) form.dataset.dirty = 'true';
  if (!form.dataset.dirty) return;
  const values = Object.fromEntries(new FormData(form));
  const fields = {};
  for (const key of ['activity', 'title', 'course', 'classId', 'date', 'grade', 'quantity', 'note', 'evidence', 'confirm'])
    if (values[key] !== undefined) fields[key] = values[key];
  submissionDraft = { id: form.dataset.draftId, owner: user.id, epoch: sessionEpoch, semester: JSON.stringify(rules?.semester), fields,
    evidenceLabel: form.dataset.uploading ? form.dataset.previousEvidenceLabel || '' : form.querySelector('#upload-status')?.textContent || '' };
}
function updateSubmissionButtons(form = $('#claim-form')) {
  if (!form) return;
  const category = activity(form.querySelector('#activity').value);
  const blocked = !category || form.dataset.saving || form.dataset.uploading ||
    (category?.grade && !form.querySelector('#saved-course')?.value);
  form.querySelectorAll('button[type="submit"]').forEach(button => button.disabled = Boolean(blocked));
}
function restoreSubmissionFields(form, fields) {
  for (const key of ['title', 'date', 'grade', 'quantity', 'note', 'evidence']) {
    const field = form.elements.namedItem(key);
    if (field && fields[key] !== undefined) field.value = fields[key];
  }
  form.elements.namedItem('confirm').checked = fields.confirm === 'on';
}
async function newSubmission(prefill = {}) {
  if (user.role !== "member") return;
  if (busy) { toast('Your submission is still saving. Please wait a moment.'); return; }
  const account = user, epoch = sessionEpoch;
  const courseData = api('/api/classes').then(profile => ({ profile }), error => ({ error }));
  openModal("NEW SUBMISSION", "", `<div id="submission-loading">${loading("Loading submission form…")}</div>`);
  const pending = $("#submission-loading");
  const current = () => pending.isConnected && modal.open && user === account && sessionEpoch === epoch;
  try {
    const [nextRules, me, nextPoints] = await Promise.all([
      api("/api/rules"), api("/api/me"), api("/api/points"),
    ]);
    if (!current() || me.user?.id !== account.id || me.user.role !== "member") return;
    user = me.user;
    rules = nextRules;
    points = nextPoints;
  } catch (error) {
    if (current()) pending.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p>`;
    return;
  }
  if (!activeActivities().length) {
    openModal("NEW SUBMISSION", "", '<p>No point categories are available right now. Ask the Scholarship Chair to enable a category.</p><div class="modal-actions"><button class="button ghost" data-action="close">Close</button></div>');
    return;
  }
  const draft = prefill.fresh ? null : currentSubmissionDraft();
  const fields = draft ? draft.fields : prefill;
  const earliest = new Date(Date.parse(rules.today) - 14 * 86400000).toISOString().slice(0, 10);
  const minimumDate = rules.semester?.startDate && rules.semester.startDate > earliest ? rules.semester.startDate : earliest;
  const maximumDate = rules.semester?.endDate && rules.semester.endDate < rules.today ? rules.semester.endDate : rules.today;
  if (minimumDate > maximumDate || !isDemo() && rules.semester?.endDate && rules.today > rules.semester.endDate) {
    const message = rules.semester?.startDate > rules.today
      ? `Submissions open on ${rules.semester.startDate}.`
      : 'Submissions are closed for this semester.';
    openModal('NEW SUBMISSION', '', `<p class="notice">${esc(message)}</p><div class="modal-actions"><button class="button ghost" data-action="close">Close</button></div>`);
    return;
  }
  openModal(
    "NEW SUBMISSION",
    isDemo()
      ? "Add a fictional activity for the Scholarship Chair to review."
      : "Add an activity and evidence for the Scholarship Chair to review.",
    `<form id="claim-form" data-owner="${esc(user.id)}" data-epoch="${sessionEpoch}">${draft ? '<div class="notice info">Your unfinished submission was restored. <button class="text-btn" type="button" data-action="discard-submission-draft">Start over</button></div>' : ''}<p class="footnote">Choose an activity, add its details, then attach evidence. Drafts stay in this tab until you sign out or reload.</p><div class="form-grid"><div class="field span2"><label for="activity-search">Activity type</label>${activityPicker()}</div><div class="field span2"><label for="title">Assignment or activity title</label><input id="title" name="title" required maxlength="120" placeholder="e.g. Calculus II · Quiz 4"></div><div class="field"><label for="course">Course</label><input id="course" name="course" required maxlength="80" placeholder="e.g. MTH 2002"></div><div class="field"><label for="date">Activity date</label><input id="date" name="date" type="date" value="${rules.today}" min="${minimumDate}" max="${maximumDate}" required><small>${isDemo() ? "Demo date" : "Today"}: ${esc(rules.today)}.</small></div><div id="dynamic-field" class="field span2"></div></div><div class="preview-points"><div>Estimated points<small>Only awarded after chair approval · ${money(points.multiplier)}× credit multiplier</small></div><strong id="estimate">—</strong></div><div class="field"><label>Supporting evidence</label><p id="proof-hint" class="footnote"></p><div id="attachment" class="attachment"><p>${isDemo() ? "Upload a fictional sample file, or use the built-in evidence record." : "Upload a PDF, PNG, or JPEG, up to 5 MB. Only you and the chair can retrieve it."}</p><label for="evidence-file">Choose evidence file</label><input id="evidence-file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"><div id="upload-status" role="status" aria-live="polite"></div>${isDemo() ? '<button class="button ghost small" type="button" data-action="sample" style="margin-top:12px">Use built-in sample</button>' : ""}</div><input id="evidence" name="evidence" type="hidden" value=""></div><div class="field"><label for="note">Note for the chair <span class="muted">(optional)</span></label><textarea id="note" name="note" maxlength="1000" placeholder="Any details that help verify the activity."></textarea></div><label class="checkbox-line"><input type="checkbox" name="confirm" required><span>This is a new activity, and I have not claimed it under another category.</span></label><div id="form-error" role="alert"></div><div class="modal-actions"><button class="button ghost" type="button" data-action="close">Keep draft & close</button><button class="button ghost" type="submit" name="afterSubmit" value="another">Submit & add another</button><button class="button gold" type="submit">Submit for review</button></div></form>`,
  );
  wireActivityPicker();
  $("#evidence-file").addEventListener("change", uploadEvidence);
  const form = $('#claim-form');
  form.dataset.draftId = draft?.id || crypto.randomUUID();
  const initialCategory = activity(fields.activity);
  if (initialCategory) { $('#activity').value = initialCategory.id; $('#activity-search').value = initialCategory.name; }
  updateForm();
  restoreSubmissionFields(form, fields);
  if (draft) {
    form.dataset.dirty = 'true';
    if (fields.evidence) $('#upload-status').textContent = draft.evidenceLabel || 'Previously uploaded evidence attached.';
  }
  loadCoursePicker(fields, courseData);
  form.addEventListener('input', () => { estimate(); rememberSubmissionDraft(form, true); updateSubmissionButtons(form); });
  form.addEventListener('change', () => { rememberSubmissionDraft(form, true); updateSubmissionButtons(form); });
  form.addEventListener('submit', submitClaim);
  updateSubmissionButtons(form);
  if (initialCategory) $('#title').focus();
  else $('#activity-search').focus();
}
function updateSubmissionPrompts(a) {
  if (!a) return;
  const examples = {
    major: ["Assignment title", "Calculus II · Midterm 1"],
    minor: ["Assignment title", "Calculus II · Quiz 4"],
    lab: ["Lab report title", "Physics · Lab 3: Motion"],
    office: ["Office-hours session", "Calculus office hours 9/14"],
    tutoring: ["Tutoring / SI session", "Chemistry SI session 9/14"],
    partner: ["Study session", "Calculus study with Alex 9/14"],
    group: ["Group study session", "ATO calculus group study 9/14"],
    independent: ["Study session", "Physics independent study 9/14"],
    night: ["Study night", "Study night 9/14"],
    meeting: ["Meeting", "Scholarship meeting 9/14"],
    calendar: ["Calendar", "Fall semester academic calendar"],
  };
  const [label, example] = examples[a.id] || ["Activity title", a.name + " 9/14"];
  const title = $("#title"), course = $("#course"), field = course.closest(".field"), saved = $("#saved-course");
  document.querySelector('label[for="title"]').textContent = label;
  title.placeholder = "e.g. " + example;
  const noCourse = ["meeting", "calendar"].includes(a.id), optional = noCourse || a.id === "night";
  field.hidden = noCourse;
  field.querySelector("label").textContent = a.grade ? "Approved class" : optional ? "Subject studied (optional)" : "Course or subject";
  course.placeholder = a.study ? "e.g. Calculus or MTH 2002" : "e.g. MTH 2002";
  course.required = !optional;
  if (saved) { saved.required = !optional; saved.disabled = noCourse; }
  course.disabled = noCourse || !!(saved && saved.selectedIndex !== saved.options.length - 1);
  if (course.coursePicker) course.coursePicker.update(a);
  updateSubmissionButtons();
  $("#note").placeholder = a.id === "night" ? "Anything the chair should know about this study night" : a.id === "partner" || a.id === "group" ? "Names of the brothers you studied with and any relevant details" : a.id === "office" ? "Professor’s name and topics discussed" : "Any details that help the chair verify this activity";
}
function updateForm() {
  const a = activity($("#activity").value);
  if (!a) {
    $("#proof-hint").textContent = "Choose an activity type from the list.";
    $("#dynamic-field").innerHTML = "";
    $("#estimate").textContent = "—";
    return;
  }
  updateSubmissionPrompts(a);
  $("#proof-hint").textContent = a.proof.replace("A sample screenshot", "A screenshot");
  const grade = $('#grade')?.value || '', quantity = $('#quantity')?.value || '';
  $("#dynamic-field").innerHTML = a.grade
    ? `<label for="grade">Grade (%)</label><input id="grade" name="grade" type="number" inputmode="decimal" min="0" max="100" step="0.01" value="${esc(grade)}" placeholder="Enter your actual grade" required>`
    : a.hours
      ? `<label for="quantity">Hours completed</label><input id="quantity" name="quantity" type="number" inputmode="decimal" min="0.01" max="24" step="0.01" value="${esc(quantity)}" placeholder="Enter hours completed" required>`
      : "";
  estimate();
  updateSubmissionButtons();
}
function estimate() {
  const form = $("#claim-form");
  if (!form) return;
  const data = Object.fromEntries(new FormData(form)),
    a = activity(data.activity),
    g = data.grade,
    q = data.quantity ?? 1;
  if (!a || a.grade && (g === '' || g === undefined) || a.hours && (data.quantity === '' || data.quantity === undefined)) {
    $("#estimate").textContent = "—";
    return;
  }
  try {
    const { base } = scoreCategory(a, { grade: g, quantity: q });
    const total = Math.round(base * points.multiplier * 100) / 100;
    $("#estimate").textContent = money(total);
  } catch {
    $("#estimate").textContent = "—";
  }
}
async function submitClaim(e) {
  e.preventDefault();
  if (busy) return;
  const form = e.target, owner = user?.id, epoch = sessionEpoch;
  const current = () => form.isConnected && modal.open && user?.id === owner && sessionEpoch === epoch;
  if (!$('#activity').value) { formError('Choose an activity type.'); $('#activity-search').focus(); return; }
  if (form.dataset.uploading) { formError('Wait for the evidence upload to finish.'); return; }
  if (activity($('#activity').value)?.grade && !$('#saved-course')?.value) {
    formError('Choose a class with an approved syllabus. Add or check it in My classes.'); return;
  }
  if (!$('#evidence').value) { formError('Attach your supporting evidence before submitting.'); $('#evidence-file').focus(); return; }
  rememberSubmissionDraft(form, true);
  const data = Object.fromEntries(new FormData(form));
  const another = e.submitter?.value === 'another';
  data.categoryVersion = rules.categoryVersion;
  if (['night', 'meeting', 'calendar'].includes(data.activity) && !data.course?.trim()) data.course = activity(data.activity).name;
  if (data.evidence !== 'sample') data.evidenceId = data.evidence;
  data.confirm = data.confirm === 'on';
  if (data.grade !== undefined && data.grade !== '') data.grade = Number(data.grade);
  if (data.quantity !== undefined && data.quantity !== '') data.quantity = Number(data.quantity);
  busy = true;
  form.dataset.saving = 'true';
  const controls = [...form.querySelectorAll('button,input,select,textarea')].map(control => [control, control.disabled]);
  controls.forEach(([control]) => control.disabled = true);
  let next = null;
  try {
    const result = await api('/api/submissions', { method: 'POST', body: data });
    form.dataset.submitted = 'true';
    if (submissionDraft?.id === form.dataset.draftId) submissionDraft = null;
    if (!current()) return;
    submissions = [{ ...result.submission, memberName: user.name }, ...submissions.filter(item => item.id !== result.submission.id)];
    points = result.points;
    window.atoCelebrate.submission();
    filter = 'pending'; submissionSearch = ''; submissionPageIndex = 0;
    toast('Submission sent for review.');
    if (another) {
      next = { fresh: true, activity: data.activity, classId: data.classId, course: data.course, date: data.date };
      navigation();
    } else {
      modal.close();
      if (location.hash === '#submissions') render(); else location.hash = 'submissions';
    }
  } catch (error) { if (current()) formError(error.message); }
  finally {
    busy = false;
    delete form.dataset.saving;
    controls.forEach(([control, disabled]) => control.disabled = disabled);
    if (current()) updateSubmissionButtons(form);
  }
  if (next && current()) await newSubmission(next);
}

async function detail(id, correction = false) {
  const revision = ++modalRevision, owner = user?.id, epoch = sessionEpoch;
  const current = () => revision === modalRevision && user?.id === owner && sessionEpoch === epoch;
  try {
    const { submission: s } = await api(
      "/api/submissions/" + encodeURIComponent(id),
    );
    if (!current()) return;
    const a = submissionActivity(s),
      canReview = user.role === "chair" && (s.status === "pending" || correction && ["approved", "denied"].includes(s.status));
    correction = canReview && s.status !== "pending";
    const award = correction && s.status === "approved" ? s.awarded : s.estimate;
    openModal(
      correction ? "CORRECT SUBMISSION DECISION" : canReview ? "REVIEW SUBMISSION" : "SUBMISSION DETAILS",
      `${esc(s.id)} · ${esc(s.memberName)}`,
      `<div class="section-heading"><h3>${esc(s.title)}</h3>${status(s.status)}</div><dl class="details"><div><dt>Activity</dt><dd>${esc(a.name)}</dd></div><div><dt>Course</dt><dd>${esc(s.course)}</dd></div><div><dt>Activity date</dt><dd>${date(s.date)}, ${esc(s.date.slice(0, 4))}</dd></div><div><dt>${s.status === "approved" ? "Awarded points" : "Estimated points"}</dt><dd>${s.status === "approved" ? s.awarded : money(s.estimate)}${s.status === "pending" ? " · not yet awarded" : ""}</dd></div>${s.grade !== null ? `<div><dt>Grade</dt><dd>${s.grade}%</dd></div>` : ""}${a.hours ? `<div><dt>Hours</dt><dd>${s.quantity}</dd></div>` : ""}</dl>${s.source === "canvas-sample" ? '<div class="notice info"><strong>Canvas sample import</strong> Assignment category was selected by the member. Verify its individual course weight before approving.</div>' : ""}${a.grade || s.syllabus ? `<section id="submission-syllabus">${loading("Loading syllabus reference…", true)}</section>` : ""}<h3>SUPPORTING EVIDENCE</h3><div class="sample-file"><span class="file-symbol">▤</span><div><strong>${s.evidenceId ? "Private evidence file" : s.source === "canvas" ? "Canvas grade record" : "Fictional activity record"}</strong><small>${s.evidenceId ? "Private preview · owner and chair only" : s.source === "canvas" ? "Imported with this member’s authorization" : "Generated demo evidence"}</small></div><button class="table-link" style="margin-left:auto" data-action="evidence" data-id="${s.id}">Open</button></div><div id="evidence-preview"></div><p class="footnote" style="margin-top:12px">Required: ${esc(a.proof)}</p>${s.note ? `<div class="review-note"><strong>Member note</strong><br>${esc(s.note)}</div>` : ""}${canReview ? `<form id="review-form" data-id="${esc(s.id)}" data-version="${esc(s.reviewVersion)}" data-correction="${correction}"><div class="subtle-rule"></div>${correction ? `<p class="notice info">Current decision: ${esc(s.status)} · ${s.awarded} points. Saving replaces this award and updates the member’s total. A reason is required and the original decision stays in the history.</p>` : ""}<div class="field"><label for="award">Points to award</label><input id="award" name="points" type="number" min="0" max="10000" step="1" ${Number.isInteger(award) ? `value="${award}"` : 'placeholder="Enter a whole-point award"'}><small>Base ${money(s.base)} × credit multiplier = ${money(s.estimate)} estimated. ${Number.isInteger(s.estimate) ? "Explain any adjustment." : "Rounding is undefined in the plan. Record a whole-point decision and explain it."}</small></div><div class="field"><label for="review-note">Review note</label><textarea id="review-note" name="note" maxlength="1000" placeholder="${correction ? 'Required for every correction. Visible to the member.' : 'Required for a denial or point adjustment. Visible to the member.'}"></textarea></div><div id="form-error" role="alert"></div><div class="modal-actions"><button type="submit" name="decision" value="denied" formnovalidate class="button danger">${correction ? "Save denial" : "Deny submission"}</button><button type="submit" name="decision" value="approved" class="button gold">${correction ? "Save approval and points" : "Approve & award points"}</button></div></form>` : `${s.reviewNote ? `<div class="review-note" style="margin-top:18px"><strong>Chair’s note</strong><br>${esc(s.reviewNote)}</div>` : ""}<div class="history">${s.history.map((h) => `<p><strong>${esc(h.event)}</strong><small>${new Date(h.at).toLocaleString()}${h.by ? " · " + esc(h.by) : ""}</small>${h.note ? `<span>${esc(h.note)}</span>` : ""}</p>`).join("")}</div><div class="modal-actions">${user.role === "chair" && ["approved", "denied"].includes(s.status) ? `<button class="button gold" data-action="correct-submission" data-id="${esc(s.id)}">Correct decision / points</button>` : ""}<button class="button ghost" data-action="close">Close</button></div>`}`,
    );
    if (canReview) {
      modal.classList.add('submission-review-dialog');
      const form = $('#review-form');
      const details = document.createElement('div');
      details.className = 'submission-review-details';
      form.before(details);
      for (const child of [...form.parentElement.children])
        if (child !== form && child !== details && !child.classList.contains('modal-heading')) details.append(child);
      if (!correction) form.querySelector('.modal-actions').insertAdjacentHTML('beforebegin', '<label class="checkbox-line review-next-choice"><input type="checkbox" name="reviewNext" checked><span>Open the next pending submission after this decision</span></label>');
      form.addEventListener('submit', review);
      const title = $('#modal-content h2');
      title.tabIndex = -1; title.focus();
    }
    evidence(id);
    if (a.grade || s.syllabus) loadSubmissionSyllabus($("#submission-syllabus"), s);
  } catch (e) {
    if (current()) toast(e.message);
  }
}
async function review(e) {
  e.preventDefault();
  if (busy || e.target.dataset.reviewed) return;
  const decision = e.submitter.value, form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const owner = user?.id, epoch = sessionEpoch;
  const current = () => form.isConnected && modal.open && user?.id === owner && sessionEpoch === epoch;
  const continueReview = Boolean(form.querySelector?.('[name="reviewNext"]')?.checked);
  busy = true;
  form.querySelectorAll('button,input,textarea').forEach(control => control.disabled = true);
  try {
    const result = await api('/api/submissions/' + encodeURIComponent(form.dataset.id) + (form.dataset.correction === 'true' ? '/revise' : '/review'), {
      method: 'POST', body: { decision, version: form.dataset.version, points: data.points === '' ? null : Number(data.points), note: data.note },
    });
    if (!current()) return;
    form.dataset.reviewed = 'true';
    submissions = submissions.map(item => item.id === form.dataset.id ? { ...item, ...result.submission } : item);
    roster = roster.map(member => member.id === result.submission.owner ? { ...member, ...result.points } : member);
    render();
    const next = continueReview && visibleSubmissions().find(item => item.status === 'pending');
    toast(form.dataset.correction === 'true' ? 'Correction saved. Points and decision history updated.' : decision === 'approved' ? 'Approved. Points awarded.' : 'Denied. The member can see your reason.');
    if (next) {
      await detail(next.id);
      // A failed next-detail request must not leave the saved decision editable.
      if (current()) modal.close();
    }
    else { modal.close(); if (continueReview) toast('Decision saved. No pending submissions remain in this view.'); }
  } catch (error) {
    if (current()) {
      formError(error.message);
      if (error.status === 409) form.querySelector('#form-error').insertAdjacentHTML('beforeend', `<p><button class="button ghost" type="button" data-action="detail" data-id="${esc(form.dataset.id)}">Reload current details</button></p>`);
    }
  } finally {
    busy = false;
    if (!form.dataset.reviewed) form.querySelectorAll('button,input,textarea').forEach(control => control.disabled = false);
  }
}

async function evidence(id) {
  const destination = $("#evidence-preview");
  if (!destination) return;
  const revision = Symbol("evidence");
  destination.previewRevision = revision;
  const current = () => destination.isConnected && modal.open && destination.previewRevision === revision;
  destination.innerHTML = loading("Loading evidence…");
  try {
    const { evidence: e } = await api(
      "/api/submissions/" + encodeURIComponent(id) + "/evidence",
    );
    if (!current()) return;
    if (e.previewUrl || e.downloadUrl) {
      const { mountFilePreview } = await import("/file-preview-ui.mjs");
      if (!current()) return;
      mountFilePreview(destination, e, { loading, isCurrent: current, label: "Supporting evidence" });
    } else {
      destination.innerHTML = `<div class="evidence-sheet"><div class="sample-stamp">${e.sample === false ? "CANVAS RECORD" : "FICTIONAL SAMPLE"}</div><h3>${esc(e.title)}</h3><p>${esc(e.course)} · ${esc(e.date)}</p><p><strong>${e.grade !== null && e.grade !== undefined ? "Grade: " + esc(e.grade) + "%" : esc(e.activity || "")}</strong></p><p class="muted">${esc(e.verification || "Imported record")}</p></div>`;
    }
  } catch (error) {
    if (!current()) return;
    destination.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p><button class="button ghost" type="button">Retry evidence preview</button>`;
    destination.querySelector("button").onclick = () => evidence(id);
  }
}

async function switchUser(id) {
  sessionEpoch++;
  submissionDraft = null;
  submissionSearch = "";
  submissionMember = "";
  submissionPageIndex = 0;
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
    main.innerHTML = loading("Loading the selected demo account…");
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
  if (b?.dataset.action === "adjust-points") { await openPointAdjustments(b.dataset.id); return; }
  if (b?.dataset.action === "manage-point-categories") { await openPointCategories(); return; }
  if (b?.dataset.action === "edit-checkpoint-quotas") { await openCheckpointQuotas(); return; }
  if (!b) return;
  const action = b.dataset.action;
  if (action === "account" && !isDemo()) {
    openModal(
      "YOUR ACCOUNT",
      esc(user.name),
      `<p>${esc(user.email || "")}</p><p>${user.role === "chair" ? "Scholarship Chair office account" : "Chapter member"}</p>${user.role === "chair" && appConfig.chapterAuth?.enabled ? `<p class="muted">${appConfig.chapterAuth.emailReady ? "At a Chair transition, ask the portal operator to update the office password and end the outgoing Chair’s access." : "The chapter inbox is not connected for password resets yet. Contact the portal administrator if this office account needs recovery."}</p>` : ""}<div class="modal-actions"><button class="button ghost" data-action="logout">Sign out</button><button class="button gold" data-action="close">Close</button></div>`,
    );
    return;
  }
  try {
    if (action === "new") newSubmission();
    else if (action === "close") modal.close();
    else if (action === 'discard-submission-draft') {
      const form = $('#claim-form');
      if (form) form.dataset.submitted = 'true';
      submissionDraft = null;
      await newSubmission({ fresh: true });
    }
    else if (action === 'refresh-submissions') {
      b.disabled = true;
      try { await refresh(); } finally { b.disabled = false; }
    }
    else if (action === 'review-member') {
      submissionMember = b.dataset.id; submissionSearch = ''; submissionPageIndex = 0; filter = 'pending';
      if (location.hash === '#queue') render(); else location.hash = 'queue';
    }
    else if (action === 'review-next') {
      const next = visibleSubmissions().find(item => item.status === 'pending');
      if (next) await detail(next.id);
    }
    else if (action === 'clear-submission-filters') {
      submissionSearch = ''; submissionMember = ''; submissionPageIndex = 0; filter = 'all'; render();
    }
    else if (action === "detail") await detail(b.dataset.id);
    else if (action === "evidence") await evidence(b.dataset.id);
    else if (action === "submissions-page") {
      submissionPageIndex = Math.max(0, Number(b.dataset.page) || 0);
      paintSubmissionResults();
      main.querySelector('.submission-table')?.scrollIntoView({ block: 'start' });
    } else if (action === "filter") {
      submissionPageIndex = 0;
      filter = b.dataset.value;
      render();
    } else if (action === "sample") {
      $("#evidence").value = "sample";
      $("#attachment").innerHTML =
        '<div class="sample-file"><span>▤</span><div><strong>Sample evidence attached</strong><small>Fictional activity record · previewable by the chair</small></div></div>';
      rememberSubmissionDraft($('#claim-form'), true);
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
    }
  } catch (err) {
    toast(err.message);
  }
}
document.addEventListener("click", handleAction);
person.addEventListener("change", () => switchUser(person.value));
window.addEventListener("hashchange", render);
$("#nav").addEventListener("scroll", updateNavOverflow);
window.addEventListener("resize", updateNavOverflow);
document.fonts?.ready.then(updateNavOverflow);
for (const [button, direction] of [["#nav-prev", -1], ["#nav-next", 1]]) {
  $(button).addEventListener("click", () => {
    const nav = $("#nav");
    nav.scrollBy({
      left: direction * Math.max(180, nav.clientWidth * .7),
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  });
}
modal.addEventListener("close", () => { rememberSubmissionDraft(); modalRevision++; });
modal.addEventListener("click", (e) => {
  if (e.target === modal && !modal.dataset.recoveryLocked) { const box = modal.getBoundingClientRect(); if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) modal.close(); }
});
modal.addEventListener("cancel", (event) => {
  if (modal.dataset.recoveryLocked) event.preventDefault();
});
async function init(sessionFromLogin = null) {
  const initEpoch = sessionEpoch;
  setAuthLoading(true, sessionFromLogin ? "Signing in…" : "Checking sign-in…");
  const startupReady = window.atoLoading.minimumStartup(authLoadingStartedAt);
  try {
    const accountPath = location.pathname.startsWith("/account/");
    const sessionTask = !sessionFromLogin && !accountPath
      ? api("/api/session").then((result) => ({ result }), (error) => ({ error }))
      : null;
    if (!sessionFromLogin) appConfig = await api("/api/config");
    if (initEpoch !== sessionEpoch) return;
    if (appConfig.chapterAuth?.enabled && location.pathname.startsWith("/account/")) {
      const fragment = new URLSearchParams(location.hash.slice(1));
      accountToken = fragment.get("access_token");
      accountLink = fragment.get('token_hash') ? { tokenHash: fragment.get('token_hash'), type: fragment.get('type') } : null;
      history.replaceState(null, "", location.pathname);
      await startupReady;
      if (initEpoch !== sessionEpoch) return;
      accountSetupPage();
      return;
    }
    const requested = new URL(location.href).searchParams.get("view");
    let result;
    const sessionOutcome = sessionFromLogin
      ? { result: sessionFromLogin }
      : await (sessionTask || api("/api/session").then((value) => ({ result: value }), (error) => ({ error })));
    if (sessionOutcome.error) {
      const e = sessionOutcome.error;
      if (e.status !== 401) throw e;
      if (!isDemo()) {
        await startupReady;
        if (initEpoch !== sessionEpoch) return;
        loginPage();
        return;
      }
      result = await api("/api/demo/session", { method: "POST", body: {} });
    } else result = sessionOutcome.result;
    if (initEpoch !== sessionEpoch) return;
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
    if (!isDemo() && user.role === 'member' && (result.recoveryKey || result.recoveryKeyPending)) {
      const key = result.recoveryKey || (await api('/api/account/recovery-key', {method:'POST', body:{}})).recoveryKey;
      await startupReady;
      if (initEpoch !== sessionEpoch) return;
      document.body.classList.remove('portal-loading');
      setAuthLoading(false);
      showRecoveryKeyModal(key, () => init({...result, recoveryKey:null, recoveryKeyPending:false}));
      return;
    }
    appConfig.semester = result.semester || appConfig.semester;
    rules = null;
    submissions = [];
    roster = [];
    points = {};
    document.body.classList.remove("signed-out");
    document.querySelector(".account-button").hidden = false;
    csrfToken = result.csrfToken;
    canvasConnected = Boolean(result.canvasConnected);
    const clean = new URL(location.href);
    clean.searchParams.delete("view");
    history.replaceState(null, "", clean);
    filter = user.role === "chair" ? "pending" : "all";
    document.querySelector(".demo-bar").hidden = !isDemo();
    document.querySelector(".demo-bar > span").innerHTML = isDemo()
      ? "<strong>PRIVATE EDITION · DEMO</strong> Fictional data · real backend · identity not connected"
      : "<strong>CHAPTER SCHOLARSHIP PORTAL</strong> Signed-in members · confidential academic records";
    document.querySelector(".sidebar-bottom").style.display = isDemo()
      ? ""
      : "none";
    document.querySelector('[data-action="reset"]').hidden = !isDemo();
    setAuthLoading(true, `Loading your ${user.role === "chair" ? "Chair workspace" : "member dashboard"}…`);
    main.replaceChildren();
    const [nextRules, nextSubmissions, nextSummary, categoryData, categoryUI] = await Promise.all([
      api("/api/rules"),
      loadSubmissionList(),
      api(user.role === "chair" ? "/api/members" : "/api/points"),
      import("/category-data.mjs"),
      import("/category-ui.mjs"),
    ]);
    await startupReady;
    if (initEpoch !== sessionEpoch) return;
    scoreCategory = categoryData.scoreCategory;
    categoryHint = categoryUI.categoryHint;
    rules = nextRules;
    submissions = nextSubmissions.submissions;
    if (user.role === "chair") roster = nextSummary.members;
    else points = nextSummary;
    document.body.classList.remove("portal-loading");
    setAuthLoading(false);
    render();
  } catch (e) {
    await startupReady;
    if (initEpoch !== sessionEpoch) return;
    document.body.classList.remove("portal-loading");
    setAuthLoading(false);
    document.body.classList.add("signed-out");
    user = null;
    csrfToken = null;
    document.querySelector(".account-button").hidden = true;
    $("#nav").innerHTML = "";
    main.innerHTML =
      heading(
        "",
        "Service unavailable",
        "The service could not load your account.",
      ) +
      `<div class="error">${esc(e.message)}</div><button class="button gold" id="retry">Try again</button>`;
    $("#retry").onclick = () => init();
  }
}
function loginPage() {
  document.body.classList.remove("portal-loading");
  setAuthLoading(false);
  document.body.classList.add("signed-out");
  sessionEpoch++;
  submissionDraft = null;
  submissionSearch = "";
  submissionMember = "";
  submissionPageIndex = 0;
  logs = [];
  submissions = [];
  roster = [];
  points = {};
  canvasConnected = false;
  modal.close();
  delete modal.dataset.recoveryLocked;
  $('#modal-content').replaceChildren();
  user = null;
  csrfToken = null;
  $(".term").textContent = appConfig.semester?.name || "Current semester";
  document.querySelector(".account-button").hidden = true;
  $("#nav").innerHTML = "";
  document.querySelector(".sidebar-bottom").style.display = "none";
  document.querySelector('[data-action="reset"]').hidden = true;
  document.querySelector(".demo-bar").hidden = true;
  document.querySelector(".demo-bar > span").innerHTML =
    "<strong>CHAPTER PORTAL</strong> Approved chapter membership required";
  if (appConfig.chapterAuth?.enabled) {
    main.innerHTML = heading("", "Sign in", "Use your chapter account.") +
      `<section class="panel login-panel"><h2>Chapter account sign-in</h2><p>Members can use an approved email, badge number, or assigned portal ID. The Scholarship Chair uses the chapter office account.</p><form id="chapter-login"><div class="field"><label for="login-id">Email, badge number, or portal ID</label><input id="login-id" name="identifier" autocomplete="username" required maxlength="254"></div><div class="field"><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required></div><div id="form-error" role="alert"></div><button class="button gold" type="submit" ${appConfig.chapterAuth.configured ? "" : "disabled"}>Sign in</button></form><button class="text-btn" id="forgot-password" type="button" ${appConfig.chapterAuth.configured ? "" : "disabled"}>Forgot password?</button>${appConfig.chapterAuth.configured ? "" : '<p class="footnote">Chapter accounts are being set up. Please check back soon.</p>'}</section>`;
    let loginPending = false;
    $("#chapter-login").onsubmit = async (event) => {
      event.preventDefault();
      if (loginPending) return;
      loginPending = true;
      const submit = event.target.querySelector('button[type="submit"]');
      submit.disabled = true;
      $("#form-error").textContent = "";
      const values = Object.fromEntries(new FormData(event.target));
      setAuthLoading(true, "Signing in…");
      try {
        // Public sandbox credentials never create a chapter-authenticated session.
        if (["test1", "test2"].includes(values.identifier.trim().toLowerCase())) {
          if (values.password !== "1234") throw Error("Invalid sign-in details.");
          location.assign("/demo/?account=" + values.identifier.trim().toLowerCase());
          return;
        }
        const signedIn = await api("/api/auth/login", { method: "POST", body: values });
        await init(signedIn);
      } catch (error) {
        setAuthLoading(false);
        if (!$("#form-error")) loginPage();
        $("#form-error").textContent = error.message;
      } finally {
        loginPending = false;
        if (submit.isConnected) submit.disabled = false;
      }
    };
    $("#forgot-password").onclick = () => {
      const panel = $(".login-panel");
      const emailReady = appConfig.chapterAuth?.emailReady;
      panel.innerHTML = `<h2>Recover your account</h2><p>Members can use their 16-word recovery key to set a new password.</p><button class="button gold" id="use-recovery-key" type="button">Use recovery key</button>${emailReady ? '<p class="footnote">Or request a link at your approved email.</p><form id="reset-request"><div class="field"><label for="reset-id">Email, badge number, or portal ID</label><input id="reset-id" name="identifier" autocomplete="username" required maxlength="254"></div><div id="form-error" role="alert"></div><button class="button ghost" type="submit">Request email reset</button></form>' : '<p class="footnote">Email resets are not available yet. If you do not have your key, contact the portal administrator. The Scholarship Chair office account must also use the administrator until chapter email is ready.</p>'}<button class="text-btn" id="back-login" type="button">Back to sign in</button>`;
      $("#back-login").onclick = loginPage;
      $("#use-recovery-key").onclick = () => {
        panel.innerHTML = `<h2>Use your recovery key</h2><p>Enter the 16 words you saved after setting your password or signing in for a new semester.</p><form id="key-recovery"><div class="field"><label for="recovery-id">Email, badge number, or portal ID</label><input id="recovery-id" name="identifier" autocomplete="username" maxlength="254" required></div><div class="field"><label for="recovery-words">16-word recovery key</label><textarea id="recovery-words" name="recoveryKey" rows="4" autocomplete="off" spellcheck="false" required maxlength="256"></textarea></div><div class="field"><label for="recovery-password">New password</label><input id="recovery-password" name="password" type="password" autocomplete="new-password" minlength="12" required></div><div class="field"><label for="recovery-confirm-password">Confirm new password</label><input id="recovery-confirm-password" name="confirm" type="password" autocomplete="new-password" minlength="12" required></div><div id="form-error" role="alert"></div><button class="button gold" type="submit">Reset password</button></form><button class="text-btn" id="back-login" type="button">Back to sign in</button>`;
        $("#back-login").onclick = loginPage;
        $("#key-recovery").onsubmit = async (event) => {
          event.preventDefault();
          const values = Object.fromEntries(new FormData(event.target));
          if (values.password !== values.confirm) {
            $("#form-error").textContent = "Passwords do not match.";
            return;
          }
          delete values.confirm;
          if (event.target.dataset.pending) return;
          event.target.dataset.pending = 'true';
          setAuthLoading(true, 'Resetting password…');
          try {
            const result = await api("/api/auth/recover-key", { method: "POST", body: values });
            panel.innerHTML = `<h2>Password changed</h2><p>${esc(result.message)}</p><button class="button gold" id="back-login" type="button">Sign in</button>`;
            $('#back-login').onclick = loginPage;
          } catch (error) { if ($('#form-error')) $('#form-error').textContent = error.message; }
          finally { delete event.target.dataset.pending; setAuthLoading(false); }
        };
      };
      if (!emailReady) return;
      $("#reset-request").onsubmit = async (event) => {
        event.preventDefault();
        if (event.target.dataset.pending) return;
        event.target.dataset.pending = 'true';
        setAuthLoading(true, 'Requesting reset link…');
        try {
          const result = await api("/api/auth/request-reset", { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
          panel.innerHTML = `<h2>Check your email</h2><p>${esc(result.message)}</p><button class="button ghost" id="back-login" type="button">Back to sign in</button>`;
          $("#back-login").onclick = loginPage;
        } catch (error) { if ($('#form-error')) $('#form-error').textContent = error.message; }
        finally { delete event.target.dataset.pending; setAuthLoading(false); }
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
    `<section class="panel login-panel"><h2>University sign-in</h2><p>Your university verifies your identity. The chapter roster determines access to the portal.</p>${appConfig.providers.map((p) => `<a class="button ${p.configured ? "gold" : "ghost"}" style="display:flex;margin:12px 0" ${p.configured ? `href="/auth/${p.id}"` : 'aria-disabled="true"'}>Continue with ${esc(p.name)}${p.configured ? "" : " · not configured"}</a>`).join("")}<p class="footnote">If your account is not on the roster, the chair must bind your verified identity before access is granted. This portal never asks for your university password.</p></section>`;
}



function accountSetupPage() {
  document.body.classList.remove("portal-loading");
  setAuthLoading(false);
  document.body.classList.add("signed-out");
  user = null;
  csrfToken = null;
  document.querySelector(".account-button").hidden = true;
  $("#nav").innerHTML = "";
  document.querySelector(".sidebar-bottom").style.display = "none";
  document.querySelector('[data-action="reset"]').hidden = true;
  main.innerHTML = heading("", "Set your password", "This link can be used only for account setup or recovery.") +
    `<section class="panel login-panel">${accountToken || accountLink ? '<form id="account-setup"><div class="field"><label for="new-password">New password</label><input id="new-password" name="password" type="password" autocomplete="new-password" minlength="12" required></div><div class="field"><label for="confirm-password">Confirm password</label><input id="confirm-password" name="confirm" type="password" autocomplete="new-password" minlength="12" required></div><div id="form-error" role="alert"></div><button class="button gold" type="submit">Save password</button></form>' : '<p>This link is incomplete, expired, or already used. Open your latest email, or go to Sign in → Forgot password to request a new link.</p><a class="button ghost" href="/">Go to sign in</a>'}</section>`;
  if (!accountToken && !accountLink) return;
  let setupPending = false;
  $("#account-setup").onsubmit = async (event) => {
    event.preventDefault();
    if (setupPending) return;
    const values = Object.fromEntries(new FormData(event.target));
    if (values.password !== values.confirm) {
      $("#form-error").textContent = "Passwords do not match.";
      return;
    }
    setupPending = true;
    setAuthLoading(true, "Saving your password…");
    try {
      await api("/api/auth/complete", { method: "POST", body: { ...(accountLink || { accessToken: accountToken }), password: values.password } });
      setAuthLoading(false);
      accountToken = null;
      accountLink = null;
      history.replaceState(null, "", "/");
      const continueToLogin = () => {
        loginPage();
        toast("Password saved. Sign in to continue.");
      };
      continueToLogin();
    } catch (error) { $("#form-error").textContent = error.message; }
    finally { setupPending = false; setAuthLoading(false); }
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
if (new URLSearchParams(location.search).get("preview") === "spinner") {
  $("#auth-loading-message").textContent = "Animation preview";
  const previewAnimation = new URLSearchParams(location.search).get("animation");
  if (["spin", "sequence"].includes(previewAnimation)) {
    $("#auth-loading .auth-cross").setAttribute("animation", previewAnimation);
  }
  const link = document.createElement("a");
  link.href = "/";
  link.className = "text-btn";
  link.textContent = "Open portal";
  $("#auth-loading .auth-loading-content").append(link);
  customElements.whenDefined("ato-loading-cross").then(() => {
    const cross = $("#auth-loading .auth-cross");
    const controls = document.createElement("div");
    controls.className = "spinner-preview-controls";
    controls.innerHTML = '<select aria-label="Loading animation"><option value="sequence">Clockwise arm sequence</option><option value="spin">Spin (preview only)</option></select><button type="button" class="button ghost">Pause animation</button><input type="range" min="0" max="2600" step="1" value="0" aria-label="Animation position">';
    const selector = controls.querySelector("select");
    const button = controls.querySelector("button");
    const slider = controls.querySelector("input");
    const updateDuration = () => { slider.max = String(cross.duration); };
    cross.addEventListener("animationchange", updateDuration);
    updateDuration();
    selector.value = cross.getAttribute("animation") || "sequence";
    selector.onchange = () => {
      cross.setAnimation(selector.value);
      slider.value = "0";
      button.textContent = "Pause animation";
    };
    button.onclick = () => {
      if (cross.paused) {
        cross.restart();
        slider.value = "0";
        button.textContent = "Pause animation";
      } else {
        cross.pauseAt();
        slider.value = String(Math.round(cross.elapsed));
        button.textContent = "Replay animation";
      }
    };
    slider.oninput = () => {
      cross.pauseAt(Number(slider.value));
      button.textContent = "Replay animation";
    };
    link.before(controls);
  });
} else init();

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
    attachment = form.querySelector("#upload-status"),
    owner = user.id, epoch = sessionEpoch,
    file = input.files[0] && (input.files[0].type ? input.files[0] : new File([input.files[0]], input.files[0].name, {type: /\.pdf$/i.test(input.files[0].name) ? "application/pdf" : /\.png$/i.test(input.files[0].name) ? "image/png" : /\.jpe?g$/i.test(input.files[0].name) ? "image/jpeg" : ""}));
  const current = () =>
    form.isConnected && user?.id === owner && sessionEpoch === epoch && $("#claim-form") === form;
  if (!file) return;
  input.value = ""; // Selecting the same file again must fire change after a failed upload.
  formError("");
  if (file.size > 5 * 1024 * 1024) {
    formError("Choose a file no larger than 5 MB.");
    return;
  }
  if (!["application/pdf", "image/png", "image/jpeg"].includes(file.type)) {
    formError("Choose a PDF, PNG, or JPEG. For an iPhone HEIC photo, export it as JPEG first.");
    return;
  }
  const previous = { evidence: hidden.value, html: attachment.innerHTML };
  form.dataset.previousEvidenceLabel = attachment.textContent || '';
  form.dataset.uploading = 'true';
  updateSubmissionButtons(form);
  input.disabled = true;
  attachment.innerHTML = loading("Uploading evidence…", true);
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
    delete form.dataset.uploading;
    rememberSubmissionDraft(form, true);
    toast("Evidence uploaded. Submit the form to attach it to your claim.");
  } catch (err) {
    if (current()) {
      hidden.value = previous.evidence;
      attachment.innerHTML = previous.html || '<p class="muted">No verified attachment selected.</p>';
      delete form.dataset.uploading;
      rememberSubmissionDraft(form, true);
      formError(err.message);
    }
  } finally {
    if (current()) {
      delete form.dataset.uploading;
      delete form.dataset.previousEvidenceLabel;
      updateSubmissionButtons(form);
      input.disabled = false;
    }
  }
}
async function renderRosterMembers() {
  const container = $('#roster-table');
  if (!container?.isConnected) return;
  const { mountRosterMembers } = await import('/roster-ui.mjs');
  if (container.isConnected) mountRosterMembers(container, rosterAccounts, { esc, state: rosterWorkspace, chapterAuth: appConfig.chapterAuth?.enabled, currentUserId: user.id });
}
async function rosterPage() {
  const owner = user?.id, epoch = sessionEpoch;
  if (rosterWorkspace.epoch !== epoch) rosterWorkspace = { epoch, tab: 'members', search: '', filter: 'active', page: 0 };
  if (rosterWorkspace.tab === 'invitations' && !appConfig.chapterAuth?.enabled) rosterWorkspace.tab = 'members';
  const tabs = [['members', 'Members'], ...(appConfig.chapterAuth?.enabled ? [['invitations', 'Invitations']] : []), ['source', 'Roster sheet']];
  main.innerHTML = heading('', 'Roster', 'Find a member, adjust points, manage class credits, or follow up on invitations.', '<button class="button ghost" data-action="import-gpa-tiers">Import GPA tiers</button><button class="button gold" data-action="add-member">Add member</button>') +
    `<nav class="roster-tabs" aria-label="Roster sections">${tabs.map(([id, name]) => `<button type="button" class="button ghost" data-roster-tab="${id}" aria-pressed="${rosterWorkspace.tab === id}">${name}</button>`).join('')}</nav><section class="panel" id="roster-workspace"></section>`;
  const shell = $('#roster-workspace');
  const current = () => shell.isConnected && user?.id === owner && sessionEpoch === epoch;
  let load = 0;
  const select = async tab => {
    const revision = ++load;
    rosterWorkspace.tab = tab;
    main.querySelectorAll('[data-roster-tab]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.rosterTab === tab)));
    if (tab === 'invitations') { shell.innerHTML = `<div id="invitation-status">${loading('Checking invitation status…')}</div>`; await loadInvitationStatus(); return; }
    if (tab === 'source') {
      shell.innerHTML = `<div id="roster-sync">${loading('Checking roster sheet…')}</div>${appConfig.chapterAuth?.enabled ? '<details class="roster-office-note"><summary>Chair transition and pilot accounts</summary><p>The Scholarship Chair account belongs to the office. Transfer its chapter inbox and reset its password when the chair changes.</p><button class="button ghost" data-action="create-pilot-accounts">Create pilot accounts</button></details>' : ''}`;
      await loadRosterSync(); return;
    }
    shell.innerHTML = `<div id="roster-table">${loading('Loading members…')}</div>`;
    try {
      const result = await api('/api/roster');
      if (!current() || revision !== load) return;
      rosterAccounts = result.members;
      await renderRosterMembers();
    } catch (error) { if (current() && revision === load) shell.innerHTML = `<p class="error">${esc(error.message)}</p><button class="button ghost" data-retry-roster type="button">Retry</button>`; shell.querySelector('[data-retry-roster]')?.addEventListener('click', () => select('members')); }
  };
  main.querySelectorAll('[data-roster-tab]').forEach(button => button.onclick = () => select(button.dataset.rosterTab));
  await select(rosterWorkspace.tab);
}

let invitationStatusLoad = 0;
function mountInvitationSelection(panel, invitations) {
  const selected = new Set(), selectAll = panel.querySelector('[data-select-ready]');
  const pending = panel.querySelector('[data-select-pending]'), expired = panel.querySelector('[data-select-expired]');
  const clear = panel.querySelector('[data-clear-ready]'), review = panel.querySelector('[data-review-invitations]');
  const boxes = [...panel.querySelectorAll('[data-select-invitation]')];
  const visibleBoxes = () => boxes.filter(box => !box.closest('[data-prepared-index]').hidden);
  const update = () => {
    const shown = visibleBoxes(), narrowed = panel.querySelector('#prepared-search').value.trim() || panel.querySelector('#prepared-status').value !== 'all';
    selectAll.disabled = !shown.some(box => invitations[Number(box.dataset.selectInvitation)].canInviteFromRoster);
    selectAll.textContent = narrowed
      ? 'Select all shown unsent' : 'Select all unsent';
    if (pending) { pending.disabled = !shown.length; pending.textContent = narrowed ? 'Select shown not accepted' : 'Select all not accepted'; }
    if (expired) { expired.disabled = !shown.some(box => invitations[Number(box.dataset.selectInvitation)].status === 'expired'); expired.textContent = narrowed ? 'Select shown expired' : 'Select all expired'; }
    clear.disabled = review.disabled = selected.size === 0;
    const hidden = boxes.filter(box => box.checked && box.closest('[data-prepared-index]').hidden).length;
    panel.querySelector('[data-selected-count]').textContent = `${selected.size} selected${hidden ? ` (${hidden} hidden by filters)` : ''}`;
    review.textContent = selected.size ? `Review ${selected.size} emails…` : 'Send / resend invitations…';
  };
  boxes.forEach(box => box.onchange = () => {
    const index = Number(box.dataset.selectInvitation);
    if (box.checked) selected.add(index); else selected.delete(index);
    update();
  });
  const select = predicate => { visibleBoxes().forEach(box => { const index = Number(box.dataset.selectInvitation); if (predicate(invitations[index])) { box.checked = true; selected.add(index); } }); update(); };
  selectAll.onclick = () => select(item => item.canInviteFromRoster);
  if (pending) pending.onclick = () => select(() => true);
  if (expired) expired.onclick = () => select(item => item.status === 'expired');
  clear.onclick = () => { selected.clear(); boxes.forEach(box => { box.checked = false; }); update(); };
  review.onclick = () => reviewBulkInvitations([...selected].map(index => invitations[index]), panel);
  update();
  return update;
}
function reviewBulkInvitations(recipients, sourcePanel) {
  const owner = user?.id, epoch = sessionEpoch, page = location.hash;
  // Snapshot the reviewed send type and version. A resend cannot replay after
  // a lost response, and the server rechecks acceptance for every recipient.
  const selected = recipients.filter(item => item.status !== 'accepted' && (item.canInviteFromRoster || item.canResendPending))
    .map(item => ({ name: item.name, email: item.email, status: item.status, version: item.version,
      operation: item.canInviteFromRoster ? 'invite-roster' : 'resend-pending' }));
  if (!selected.length || user?.role !== 'chair') return;
  const resendCount = selected.filter(item => item.operation === 'resend-pending').length;
  openModal('REVIEW INVITATION EMAILS', '', `<p><strong>${selected.length - resendCount} first invitations · ${resendCount} resends</strong></p><p>Each selected member receives a personal setup link valid for seven days. Members who have already accepted are skipped when their status is checked.</p>${resendCount ? '<p class="notice info">Resending can replace an earlier link. Recipients should use the newest email. A previous delivery marked uncertain may already be in their inbox.</p>' : ''}<p class="muted">Accounts are created automatically when needed. Existing account settings and imported tiers are kept; new accounts show N/A credit hours until classes are approved and use the imported tier, or Tier 1 if none is assigned. New members always use Tier 1.</p><div class="invitation-batch-list"><ul>${selected.map((item, index) => `<li><div><strong>${esc(item.name)}</strong><small>${esc(item.email)}</small><small>${item.operation === 'invite-roster' ? 'First invitation' : item.status === 'expired' ? 'Resend expired link' : item.status === 'delivery_unknown' ? 'Resend · previous delivery uncertain' : 'Resend · not yet accepted'}</small></div><span data-batch-result="${index}">Not sent</span></li>`).join('')}</ul></div><p class="muted">Keep this page open while sending. Closing this window stops the remaining emails; an email already being sent may still arrive. Sending pauses if the email service reaches its limit. There are no automatic retries.</p><form id="invitation-batch-form"><label class="checkbox-line"><input id="invitation-batch-confirm" type="checkbox" required><span>Send these ${selected.length} invitation emails now.</span></label><div class="invitation-feedback" role="status" aria-live="polite"></div><div class="modal-actions"><button class="button ghost" data-batch-stop type="button">Cancel</button><button class="button gold" type="submit">Send ${selected.length} emails</button></div></form>`);
  const form = $('#invitation-batch-form'), feedback = form.querySelector('.invitation-feedback');
  const confirmation = form.querySelector('#invitation-batch-confirm'), submit = form.querySelector('[type="submit"]');
  const stop = form.querySelector('[data-batch-stop]');
  let stopped = false, sending = false, finished = false, accepted = 0, skipped = 0;
  const sameSession = () => user?.id === owner && user?.role === 'chair' && sessionEpoch === epoch;
  const current = () => sameSession() && form.isConnected && modal.open && sourcePanel.isConnected && location.hash === page;
  stop.onclick = () => {
    stopped = true;
    if (!sending) { modal.close(); return; }
    stop.disabled = true;
    stop.textContent = 'Stopping…';
    feedback.innerHTML = loading('Stopping after the current email…', true);
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (sending || finished || stopped || !current() || !confirmation.checked) return;
    sending = true;
    confirmation.disabled = submit.disabled = true;
    stop.textContent = 'Stop remaining';
    let problem = '';
    try {
      for (let index = 0; index < selected.length; index++) {
        if (!current() || stopped) break;
        const item = selected[index], outcome = $('#modal-content').querySelector(`[data-batch-result="${index}"]`);
        feedback.innerHTML = loading(`Sending ${index + 1} of ${selected.length}…`, true);
        outcome.textContent = 'Sending…';
        try {
          const result = await api(`/api/admin/invitations/${encodeURIComponent(item.email)}/${item.operation}`,
            {method:'POST', body:item.operation === 'resend-pending' ? {version:item.version} : {}});
          if (!current()) return;
          if (result.skipped && result.invitation?.status === 'accepted') {
            skipped++;
            outcome.textContent = 'Already accepted · skipped';
          } else if (result.invitation?.status !== 'sent') {
            outcome.textContent = 'Needs checking';
            problem = 'The email result needs checking. The remaining invitations were not sent. Refresh account status before continuing.';
            break;
          } else {
            accepted++;
            outcome.textContent = 'Sent · awaiting acceptance';
          }
        } catch (error) {
          if (!current()) return;
          outcome.textContent = 'Needs checking';
          problem = `${error.message} The remaining invitations were not sent. Refresh account status before continuing.`;
          break;
        }
        // Sequential requests avoid a burst; provider limits can still stop a batch.
        if (index < selected.length - 1 && !stopped && current()) await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } finally {
      sending = false;
      finished = true;
      if (current()) {
        feedback.textContent = `${accepted} of ${selected.length} accepted by the email service. ${skipped ? `${skipped} already accepted and skipped. ` : ''}${problem || (stopped ? 'Remaining invitations were not sent.' : 'Recipients should check their inbox and spam folder.')} Inbox delivery is not verified.`;
        stop.disabled = false;
        stop.textContent = 'Done';
      }
      // Status persists on the server, including ambiguous delivery. Never retry it here.
      if (sameSession() && sourcePanel.isConnected && location.hash === page) await rosterPage();
    }
  };
}
async function correctInvitationAddress(item, sourcePanel) {
  const owner = user?.id, epoch = sessionEpoch;
  openModal('CORRECT INVITATION EMAIL', esc(item.name), `<form id="correct-invitation-email"><p>Current address: <strong>${esc(item.email)}</strong></p><div class="field"><label for="corrected-email">Correct email address</label><input id="corrected-email" name="email" type="email" required maxlength="254" autocomplete="off" value="${esc(item.email)}"></div><p class="notice info">Points, classes, and review history stay with this member. Existing portal sessions and old account links will no longer grant access. After saving, send a fresh invitation to the corrected address.</p><p class="footnote">The correction stays in the portal when the sheet refreshes. The member must still be eligible on the roster. Saving this correction does not send an email.</p><p class="invitation-feedback" role="status" aria-live="polite"></p><div class="modal-actions"><button class="button ghost" data-action="close" type="button">Cancel</button><button class="button gold" type="submit">Save corrected email</button></div></form>`);
  const form = $('#correct-invitation-email');
  const current = () => user?.id === owner && sessionEpoch === epoch;
  form.onsubmit = async event => {
    event.preventDefault();
    if (form.dataset.pending || !current() || !form.isConnected || !modal.open) return;
    const email = form.elements.email.value.trim().toLowerCase(), feedback = form.querySelector('.invitation-feedback');
    if (email === item.email) { feedback.textContent = 'Enter a different email address.'; return; }
    form.dataset.pending = 'true';
    form.querySelectorAll('button,input').forEach(control => control.disabled = true);
    feedback.innerHTML = loading('Saving corrected address…', true);
    try {
      const result = await api(`/api/admin/invitations/${encodeURIComponent(item.email)}/correct-email`, { method: 'POST', body: { email, version: item.emailVersion } });
      if (!current()) return;
      for (const rows of [roster, rosterAccounts]) {
        const member = rows.find(row => row.id === result.memberId);
        if (member) member.email = result.email;
      }
      if (form.isConnected && modal.open) { modal.close(); toast(result.message); }
      if (sourcePanel.isConnected) {
        if (loadInvitationStatus.view?.epoch === epoch) { loadInvitationStatus.view.search = result.email; loadInvitationStatus.view.status = 'all'; }
        await loadInvitationStatus();
      }
    } catch (error) {
      if (!current() || !form.isConnected) return;
      feedback.textContent = error.message;
      if (error.status === 409 || !error.status) {
        feedback.textContent += ' Close this window and refresh invitation status before trying again.';
        form.querySelector('[data-action="close"]').disabled = false;
      } else {
        delete form.dataset.pending;
        form.querySelectorAll('button,input').forEach(control => control.disabled = false);
      }
    }
  };
  form.elements.email.focus(); form.elements.email.select();
}
async function loadInvitationStatus() {
  const panel = $('#invitation-status'), revision = ++invitationStatusLoad;
  if (!panel?.isConnected) return;
  const current = () => panel.isConnected && revision === invitationStatusLoad;
  const labels = {unprepared:'Not invited', untracked:'Check setup', preparing:'Preparing account', ready:'Not invited', sending:'Sending', sent:'Awaiting acceptance', accepted:'Accepted', expired:'Expired', delivery_unknown:'Delivery uncertain', failed:'Needs attention'};
  const view = loadInvitationStatus.view?.epoch === sessionEpoch ? loadInvitationStatus.view : (loadInvitationStatus.view = { epoch: sessionEpoch, search: '', status: 'all' });
  try {
    const {invitations, emailReady, checkedAt, statusWarning, rosterFresh} = await api('/api/admin/invitations');
    if (!current()) return;
    const count = status => invitations.filter(item => item.status === status).length;
    const ready = invitations.filter(item => item.canInviteFromRoster).length;
    panel.innerHTML = `<div class="section-heading"><h2>Invitations</h2><button class="button ghost small" data-refresh-invitations type="button">Refresh status</button></div><div class="invitation-summary"><span><strong>${count('accepted')}</strong> Accepted</span><span><strong>${count('sent')}</strong> Awaiting acceptance</span><span><strong>${count('expired')}</strong> Expired</span><span><strong>${ready}</strong> Ready for first invite</span></div><p class="muted">Links last seven days. Accepted means the member verified their email through account setup; it does not track email opens.${checkedAt ? ` Status checked ${esc(new Date(checkedAt).toLocaleString())}.` : ''}</p>${statusWarning ? `<p class="notice">${esc(statusWarning)}</p>` : ''}${rosterFresh === false ? '<p class="notice">Refresh the roster to check who can receive invitations. <button class="table-link" type="button" data-refresh-invitation-roster>Refresh roster now</button></p>' : ''}${emailReady ? '' : '<p class="notice info">Email sending is not enabled. You can still check and repair account setup without sending anything.</p>'}${invitations.length ? `<div class="invitation-filters"><div class="field"><label for="prepared-search">Find a recipient</label><input id="prepared-search" type="search" placeholder="Name or email" value="${esc(view.search)}"></div><div class="field"><label for="prepared-status">Invitation status</label><select id="prepared-status"><option value="all">All recipients</option><option value="not-accepted">Not yet accepted</option><option value="ready">Not invited</option><option value="sent">Awaiting acceptance</option><option value="expired">Expired</option><option value="accepted">Accepted</option><option value="attention">Needs attention</option></select></div></div><div class="invitation-bulk-actions"><button class="button ghost" data-select-pending type="button" ${emailReady ? '' : 'disabled'}>Select all not accepted</button><button class="button ghost" data-select-expired type="button" ${emailReady ? '' : 'disabled'}>Select all expired</button><button class="text-btn" data-select-ready type="button" ${emailReady ? '' : 'disabled'}>Select all unsent</button><button class="text-btn" data-clear-ready type="button" disabled>Clear selection</button><span class="muted" data-selected-count role="status">0 selected</span><button class="button gold" data-review-invitations type="button" disabled>Send / resend invitations…</button></div><p class="footnote">Selection applies to the visible, eligible recipients. Review the recipient list before sending.</p><div class="table-wrap"><table class="invitation-table"><thead><tr><th>Select</th><th>Recipient</th><th>Status</th><th>Link / acceptance date</th><th>Actions</th></tr></thead><tbody>${invitations.map((item,index) => `<tr data-prepared-index="${index}"><td>${(item.canInviteFromRoster || item.canResendPending) && item.status !== 'accepted' && emailReady ? `<label class="invitation-select"><input type="checkbox" data-select-invitation="${index}" aria-label="Select ${esc(item.name)} (${esc(item.email)})"></label>` : '—'}</td><td><strong>${esc(item.name)}</strong><small>${esc(item.email)}</small>${item.sourceEmail ? `<small>Corrected from sheet: ${esc(item.sourceEmail)}</small>` : ''}</td><td><span class="status ${item.status === 'accepted' ? 'approved' : item.status === 'expired' ? 'denied' : 'pending'}">${esc(labels[item.status] || item.status)}</span><small>${esc(item.message || '')}</small></td><td>${item.acceptedAt ? `Accepted ${esc(new Date(item.acceptedAt).toLocaleString())}` : item.expiresAt ? `${item.status === 'expired' ? 'Expired' : 'Expires'} ${esc(new Date(item.expiresAt).toLocaleString())}` : 'No confirmed active link'}${item.lastSentAt ? `<small>Last sent ${esc(new Date(item.lastSentAt).toLocaleString())}</small>` : ''}</td><td>${(item.canInviteFromRoster || item.canResendPending) && item.status !== 'accepted' && emailReady ? `<button class="table-link" data-invitation-index="${index}" data-operation="email">${item.canInviteFromRoster ? 'Review invitation' : 'Review resend'}</button>` : item.retryAt > Date.now() ? `<small>Available after ${esc(new Date(item.retryAt).toLocaleString())}. Refresh then.</small>` : ''}${item.canReconcile && ["untracked", "failed", "delivery_unknown"].includes(item.status) ? `<button class="table-link" data-invitation-index="${index}" data-operation="reconcile">Check account setup</button>` : ''}${item.canCorrectEmail ? `<button class="table-link" data-invitation-index="${index}" data-operation="correct-email">Correct email</button>` : ''}${item.memberId ? `<button class="table-link" data-action="edit-academic-settings" data-id="${esc(item.memberId)}">Account settings</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p>No eligible recipients are available. Refresh the sheet in the Roster sheet tab.</p>'}`;
    panel.querySelector('[data-refresh-invitations]').onclick = loadInvitationStatus;
    const refreshRoster = panel.querySelector('[data-refresh-invitation-roster]');
    if (refreshRoster) refreshRoster.onclick = async () => {
      refreshRoster.disabled = true;
      try { await api('/api/admin/roster-sync', {method:'POST',body:{}}); if (current()) await loadInvitationStatus(); }
      catch (error) { if (current()) { toast(error.message); refreshRoster.disabled = false; } }
    };
    const updateSelection = invitations.length ? mountInvitationSelection(panel, invitations) : () => {};
    const search = panel.querySelector('#prepared-search'), status = panel.querySelector('#prepared-status');
    if (search && status) {
      status.value = view.status;
      const filter = () => {
        view.search = search.value; view.status = status.value;
        panel.querySelectorAll('[data-prepared-index]').forEach(row => {
          const item = invitations[Number(row.dataset.preparedIndex)];
          row.hidden = !`${item.name} ${item.email}`.toLowerCase().includes(search.value.trim().toLowerCase()) ||
            (status.value !== 'all' && (status.value === 'attention' ? !['untracked', 'failed', 'delivery_unknown'].includes(item.status) : status.value === 'not-accepted' ? item.status === 'accepted' : status.value === 'ready' ? !item.canInviteFromRoster : item.status !== status.value));
        }); updateSelection();
      };
      search.oninput = status.onchange = filter; filter();
    }
    panel.querySelectorAll('[data-invitation-index]').forEach(button => button.onclick = () => {
      const item = invitations[Number(button.dataset.invitationIndex)];
      if (button.dataset.operation === 'email') { reviewBulkInvitations([item], panel); return; }
      if (button.dataset.operation === 'correct-email') { correctInvitationAddress(item, panel); return; }
      openModal('CHECK ACCOUNT SETUP?', '', `<p>Check and repair the portal account connection for <strong>${esc(item.email)}</strong>. This does not send an email or change an existing password.</p><form id="invitation-action-form"><div class="invitation-feedback" role="status"></div><div class="modal-actions"><button class="button ghost" data-action="close" type="button">Cancel</button><button class="button gold" type="submit">Check account setup</button></div></form>`);
      const form = $('#invitation-action-form'), owner = user?.id, epoch = sessionEpoch;
      form.onsubmit = async event => {
        event.preventDefault();
        if (form.dataset.pending) return;
        form.dataset.pending = 'true';
        form.querySelectorAll('button').forEach(control => control.disabled = true);
        const feedback = form.querySelector('.invitation-feedback');
        feedback.innerHTML = loading('Checking account…', true);
        try {
          const result = await api(`/api/admin/invitations/${encodeURIComponent(item.email)}/reconcile`, {method:'POST',body:{}});
          if (user?.id !== owner || sessionEpoch !== epoch) return;
          if (form.isConnected && modal.open) { modal.close(); toast(result.message); }
          await loadInvitationStatus();
        } catch (error) {
          if (user?.id !== owner || sessionEpoch !== epoch || !form.isConnected) return;
          feedback.textContent = `${error.message} Close this window and refresh status before trying again.`;
          form.querySelector('[data-action="close"]').disabled = false;
          loadInvitationStatus();
        }
      };
    });
  } catch (error) {
    if (current()) {
      panel.innerHTML = `<h2>Invitation status</h2><p class="error">${esc(error.message)}</p><button class="button ghost" type="button">Try again</button>`;
      panel.querySelector('button').onclick = loadInvitationStatus;
    }
  }
}

async function loadRosterSync() {
  const panel = $("#roster-sync");
  rosterCandidates = [];
  try {
    const result = await api("/api/admin/roster-sync");
    if (!panel.isConnected) return;
    const emailMode = result.mode === "public_email_csv";
    const candidates = emailMode && result.fresh ? (result.candidates || []) : [];
    rosterCandidates = candidates.filter((entry) => entry.accountStatus === "not_invited");
    const needsAttention = candidates.filter((entry) => ["inactive", "missing_sign_in"].includes(entry.accountStatus)).length;
    const description = emailMode
      ? "The portal reads active and new-member names and university emails from the chapter sheet. The Chair can invite everyone together without preparing each account; the sheet is never edited by this portal."
      : "Copy each Portal Member ID below into the sheet, then use TRUE or FALSE in its Active column. Chapter sign-in identifies the member; the sheet controls continuing access.";
    const count = result.fetchedAt
      ? `Last successful refresh: ${esc(new Date(result.fetchedAt).toLocaleString())}. ${result.activeCount} eligible ${emailMode ? `members (${result.newMemberCount || 0} new)` : "IDs"}.`
      : "Connect the sheet in the hosting settings to enable automatic eligibility checks.";
    const candidateList = emailMode && result.fresh
      ? `<div class="section-heading" style="margin-top:22px"><h3>MEMBERS WITHOUT ACCOUNTS</h3><span class="muted">${rosterCandidates.length} of ${result.activeCount} eligible members</span></div>${rosterCandidates.length
        ? `<p class="muted">Individual setup is optional. Use the Invitations tab to invite everyone as listed, or edit a person here first.</p><div class="invitation-filters"><div class="field"><label for="invite-search">Find roster entry</label><input id="invite-search" type="search" placeholder="Name or email"></div><div class="field"><label for="invite-membership">Membership</label><select id="invite-membership"><option value="all">All eligible members</option><option value="new_member">New members</option><option value="active">Active members</option></select></div></div><p id="invite-visible-count" class="muted"></p><div class="table-wrap"><table class="roster-candidate-table"><thead><tr><th>Member</th><th>Status</th><th>University email</th><th>Tier</th><th></th></tr></thead><tbody>${rosterCandidates.map((entry, index) => `<tr data-candidate-index="${index}"><td><strong>${esc(entry.name)}</strong></td><td>${entry.membership === "new_member" ? "New member" : "Active"}</td><td>${esc(entry.email)}</td><td>${entry.assignedTier ? `Tier ${entry.assignedTier}` : "Tier 1 until adjusted"}</td><td><button class="table-link" data-action="invite-roster-member" data-index="${index}">Edit / prepare account</button></td></tr>`).join("")}</tbody></table></div>`
        : '<p class="muted">Every eligible roster entry already has an account.</p>'}${needsAttention ? `<p class="muted">${needsAttention} existing ${needsAttention === 1 ? "account needs" : "accounts need"} attention in the Members tab.</p>` : ""}${appConfig.chapterAuth?.emailReady ? "" : '<p class="muted">Email delivery must be configured before invitations can be sent.</p>'}`
      : "";
    panel.innerHTML = `<div class="section-heading"><h2>ROSTER SHEET</h2><span class="status ${result.fresh ? "approved" : "pending"}">${result.fresh ? "Up to date" : result.required ? "Refresh required" : "Not connected"}</span></div><p>${description}</p><p class="muted">${count} Members need a successful refresh at least every 15 minutes. Chair access remains available for recovery.</p>${result.lastError ? `<p class="error">${esc(result.lastError)}</p>` : ""}<button class="button ghost" id="sync-roster" ${result.configured ? "" : "disabled"}>Refresh roster now</button>${candidateList}`;
    const search = panel.querySelector("#invite-search"), membership = panel.querySelector("#invite-membership");
    if (search && membership) {
      const filterRecipients = () => {
        let visible = 0;
        panel.querySelectorAll("[data-candidate-index]").forEach(row => {
          const entry = rosterCandidates[Number(row.dataset.candidateIndex)];
          const matches = `${entry.name} ${entry.email}`.toLowerCase().includes(search.value.trim().toLowerCase()) &&
            (membership.value === "all" || (entry.membership === "new_member" ? "new_member" : "active") === membership.value);
          row.hidden = !matches;
          if (matches) visible++;
        });
        panel.querySelector("#invite-visible-count").textContent = `${visible} recipients shown`;
      };
      search.oninput = membership.onchange = filterRecipients;
      filterRecipients();
    }

    $("#sync-roster").onclick = async (event) => {
      event.target.disabled = true;
      try {
        await api("/api/admin/roster-sync", { method: "POST", body: {} });
        toast("Roster eligibility updated.");
      } catch (error) {
        toast(error.message);
      }
      await loadRosterSync();
      if (appConfig.chapterAuth?.enabled && $("#invitation-status")) await loadInvitationStatus();
    };
  } catch (error) {
    if (panel.isConnected)
      panel.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

function mountCurrentSemesterSettings(container, view) {
  const owner = user.id, epoch = sessionEpoch;
  const fields = [['startDate', 'Semester start'], ['checkpoint1', 'First checkpoint'], ['checkpoint2', 'Second checkpoint'], ['checkpoint3', 'Third checkpoint'], ['targetDate', 'Final point target'], ['endDate', 'Submissions close']];
  const values = { ...view.semester, ...Object.fromEntries(view.semester.checkpointDates.map((date, i) => ['checkpoint' + (i + 1), date])) };
  container.innerHTML = `<h2>EDIT CURRENT SEMESTER</h2><p>Update dates or the semester name. Existing points, classes, evidence and accounts stay in place.</p><form><div class="form-grid"><div class="field span2"><label for="current-semester-name">Semester name</label><input id="current-semester-name" name="name" maxlength="80" required value="${esc(values.name)}"></div>${fields.map(([id, label]) => `<div class="field"><label for="current-semester-${id}">${label}</label><input id="current-semester-${id}" name="${id}" type="date" required value="${esc(values[id] || '')}"></div>`).join('')}</div><p class="semester-settings-feedback" role="status"></p><button class="button gold" type="submit">Save semester settings</button></form><hr class="subtle-rule">`;
  const form = container.querySelector('form'), feedback = container.querySelector('.semester-settings-feedback');
  const current = () => container.isConnected && user?.id === owner && sessionEpoch === epoch;
  let pending = false;
  form.onsubmit = async event => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    const values = Object.fromEntries(new FormData(form));
    const semester = { name: values.name, startDate: values.startDate, targetDate: values.targetDate, endDate: values.endDate, checkpointDates: [values.checkpoint1, values.checkpoint2, values.checkpoint3] };
    const controls = [...form.querySelectorAll('input,button')];
    controls.forEach(control => control.disabled = true);
    feedback.innerHTML = loading('Saving semester settings…', true);
    try {
      const saved = await api('/api/semester', { method: 'POST', body: { semester, version: view.version } });
      if (!current()) return;
      view = saved;
      await updateSemesterState();
      toast('Semester settings saved. Existing records were kept.');
    } catch (error) { if (current()) feedback.textContent = error.message; }
    finally { pending = false; controls.forEach(control => control.disabled = false); }
  };
}

async function semesterPage() {
  const owner = user.id;
  main.innerHTML =
    heading(
      "",
      "Semester settings",
      "Edit the semester calendar, or review a reset before starting the next semester.",
    ) +
    `<div class="page-actions"><button class="button ghost" data-action="edit-checkpoint-quotas">Edit checkpoint quotas</button></div><section class="panel" id="semester-panel">${loading("Loading semester…")}</section>`;
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
    panel.innerHTML = `<section id="current-semester-settings"></section>${reset.status === "completed" ? '<div class="notice info">Cleanup completed. The new semester is active.</div>' : ""}<h2>${esc(active?.name || "Current semester")}</h2><p>Starting a new semester permanently removes submissions, point awards, uploaded evidence, and academic review history from the live portal. Accounts, university identity links, and roster settings stay in place.</p><p class="muted">Separately retained backups expire under the hosting provider’s retention policy. This action cannot be undone in the portal.</p><form id="semester-form"><div class="form-grid"><div class="field span2"><label for="semester-name">New semester name</label><input id="semester-name" name="name" required maxlength="80" placeholder="Spring 2027"></div>${[
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
      )}</div><p class="muted">Member tier assignments stay the same. Checkpoint quotas return to the standard plan values; edit them for the new semester under Point rules. Enter the chapter’s approved dates below.</p><button class="button danger" type="submit">Review semester reset</button><p id="semester-error" role="alert"></p></form>`;
    mountCurrentSemesterSettings(panel.querySelector("#current-semester-settings"), result);
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
          `<p><strong>${preview.counts.submissions}</strong> submissions and <strong>${preview.counts.evidence}</strong> evidence records will be deleted. <strong>${preview.counts.accounts}</strong> member accounts will remain. Custom checkpoint quotas will return to the standard plan values.</p><p>Next semester: <strong>${esc(semester.name)}</strong>, ${esc(semester.startDate)} to ${esc(semester.endDate)}.</p><p class="muted">${esc(preview.backupNotice)}</p><form id="confirm-semester-form"><div class="field"><label for="semester-confirm">Type DELETE SEMESTER to confirm</label><input id="semester-confirm" autocomplete="off" required></div><div id="form-error" role="alert"></div><div class="modal-actions"><button class="button ghost" type="button" data-action="close">Cancel</button><button class="button danger" type="submit">Delete semester records</button></div></form>`,
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
  submissionDraft = null;
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
function addMember(prefill = {}) {
  if (appConfig.chapterAuth?.enabled) {
    openModal("PREPARE MEMBER ACCOUNT", "Save the account now. Send its setup link separately when ready.",
      `<form id="roster-form"><div class="form-grid"><div class="field"><label for="member-name">Name</label><input id="member-name" name="name" required maxlength="100" value="${esc(prefill.name || "")}"></div><div class="field"><label for="member-email">Email for account setup</label><input id="member-email" name="email" type="email" required value="${esc(prefill.email || "")}"></div><div class="field"><label for="member-badge">Badge number (optional)</label><input id="member-badge" name="badge" maxlength="32" value="${esc(prefill.badge || "")}"><small>Use a chapter badge number, not a university 900 number. New members receive a portal sign-in ID automatically.</small></div><div class="field"><label for="member-tier">Assigned tier</label><select id="member-tier" name="tier"${prefill.membership === "new_member" ? " disabled" : ""}>${[1, 2, 3, 4, 5].map((t) => `<option value="${t}"${Number(prefill.membership === "new_member" ? 1 : prefill.assignedTier) === t ? " selected" : ""}>${t}</option>`).join("")}</select><small>${prefill.membership === "new_member" ? "New members use Tier 1." : prefill.assignedTier ? "From the Chair's reviewed GPA import." : "Use the page-5 GPA ranges."}</small></div><div class="field"><label for="member-credits">Enrolled credits</label><input id="member-credits" name="credits" type="text" readonly value="N/A" aria-describedby="starting-hours-help"><small id="starting-hours-help">Hours appear after class approval.</small></div></div><div id="form-error" role="alert"></div><div class="modal-actions"><button class="button ghost" type="button" data-action="close">Cancel</button><button class="button gold" type="submit">Save without sending email</button></div></form>`);
    $("#roster-form").onsubmit = async (event) => {
      event.preventDefault();
      const form = event.target, owner = user?.id, epoch = sessionEpoch;
      if (form.dataset.pending) return;
      const body = Object.fromEntries(new FormData(form));
      body.tier = prefill.membership === "new_member" ? 1 : Number(body.tier);
      body.credits = Number.isFinite(prefill.credits) ? prefill.credits : 15;
      form.dataset.pending = "true";
      const controls = [...form.querySelectorAll("input,select,button")];
      const disabled = controls.map(control => control.disabled);
      controls.forEach(control => control.disabled = true);
      form.querySelector("#form-error").innerHTML = loading("Preparing account…", true);
      try {
        const result = await api("/api/admin/invitations/prepare", { method: "POST", body });
        if (user?.id !== owner || sessionEpoch !== epoch) return;
        if (!form.isConnected || !modal.open) return;
        modal.close();
        await rosterPage();
        toast(result.message || "Account saved. No email sent.");
      } catch (error) {
        if (user?.id !== owner || sessionEpoch !== epoch || !form.isConnected) return;
        form.querySelector("#form-error").textContent = error.message;
        delete form.dataset.pending;
        controls.forEach((control, index) => control.disabled = disabled[index]);
        loadInvitationStatus();
      }
    };
    return;
  }
  openModal(
    "ADD A CHAPTER MEMBER",
    "Use the stable identity ID verified by the university provider.",
    `<form id="roster-form"><div class="form-grid"><div class="field"><label for="member-name">Name</label><input id="member-name" name="name" required maxlength="120"></div><div class="field"><label for="member-email">Contact email</label><input id="member-email" name="email" type="email" required></div><div class="field"><label for="member-provider">Identity provider</label><input id="member-provider" value="Microsoft" disabled><input type="hidden" name="provider" value="microsoft"></div><div class="field"><label for="member-tier">Assigned tier</label><select id="member-tier" name="tier">${[1, 2, 3, 4, 5].map((t) => `<option>${t}</option>`).join("")}</select></div><div class="field span2"><label for="member-subject">Verified identity ID</label><input id="member-subject" name="subject" required maxlength="300"><small>Use the verified Microsoft tenant ID and directory object ID: tenant:oid:object-id. An email address or badge number is not an identity ID.</small></div><div class="field"><label for="member-credits">Enrolled credits</label><input id="member-credits" name="credits" type="text" readonly value="N/A"></div></div><div id="form-error" role="alert"></div><div class="modal-actions"><button class="button ghost" type="button" data-action="close">Cancel</button><button class="button gold" type="submit">Add member</button></div></form>`,
  );
  $("#roster-form").onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.tier = Number(body.tier);
    body.credits = 15;
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
async function editMemberAccount(member) {
  if (user?.role !== "chair") return;
  if (!appConfig.chapterAuth?.enabled || isDemo()) return editAcademicSettings(member);
  const owner = user.id, epoch = sessionEpoch;
  let cancelled = false;
  const current = () => !cancelled && modal.open && user?.id === owner && sessionEpoch === epoch;
  openModal("MANAGE MEMBER", "", loading("Loading account details…"));
  modal.addEventListener("close", () => { cancelled = true; }, { once: true });
  try {
    const details = await api(`/api/roster/${encodeURIComponent(member.id)}/account-settings`);
    if (!current()) return;
    const saved = details.member;
    rosterAccounts = [...rosterAccounts.filter(entry => entry.id !== saved.id), saved];
    openModal("MANAGE MEMBER", "Save account changes without sending an email.",
      `<form id="member-account-form"><div class="form-grid"><div class="field"><label for="account-member-name">Name</label><input id="account-member-name" name="name" required maxlength="100" value="${esc(saved.name)}"></div><div class="field"><label for="account-member-email">Account email</label><input id="account-member-email" type="email" readonly value="${esc(saved.email)}"><small>To fix a typo, use Roster → Invitations → Correct email, then send a fresh invitation.</small></div><div class="field"><label for="account-member-badge">Badge number (optional)</label><input id="account-member-badge" name="badge" maxlength="32" value="${esc(details.badge || "")}"><small>Chapter badge number, not the university 900 number. Portal ID: ${esc(details.loginId || "—")}.</small></div><div class="field"><label for="account-member-tier">Assigned tier</label><select id="account-member-tier" name="tier"${details.membership === "new_member" ? " disabled" : ""}>${[1, 2, 3, 4, 5].map(tier => `<option value="${tier}"${saved.tier === tier ? " selected" : ""}>Tier ${tier} · ${rules.checkpoints.at(-1).targets[tier - 1]}-point goal</option>`).join("")}</select>${details.membership === "new_member" ? "<small>New members use Tier 1.</small>" : ""}</div><div class="field"><label for="account-member-credits">Enrolled credits</label><input id="account-member-credits" name="credits" type="text" readonly value="${details.creditsManaged ? esc(saved.credits) : "N/A"}"><small>${details.creditsManaged ? "Total from approved classes. Review their classes to change it." : "Hours appear after class approval. Use Manage class credits below."}</small></div></div><p><button class="table-link" type="button" data-action="adjust-points" data-id="${esc(saved.id)}">Adjust approved points</button> · <button class="table-link" type="button" data-action="manage-credits" data-id="${esc(saved.id)}">Manage class credits</button></p><div id="form-error" role="alert"></div><div class="modal-actions"><button type="button" class="button ghost" data-action="close">Cancel</button><button type="submit" class="button gold">Save changes</button></div></form>`);
    const form = $("#member-account-form");
    form.onsubmit = async event => {
      event.preventDefault();
      if (form.dataset.pending) return;
      const body = { name: $("#account-member-name").value, badge: $("#account-member-badge").value,
        tier: Number($("#account-member-tier").value), credits: saved.credits, version: details.version };
      const controls = [...form.querySelectorAll("input,select,button")];
      const disabled = controls.map(control => control.disabled);
      form.dataset.pending = "true";
      controls.forEach(control => control.disabled = true);
      form.querySelector("#form-error").innerHTML = loading("Saving account…", true);
      try {
        await api(`/api/roster/${encodeURIComponent(saved.id)}/account-settings`, { method: "POST", body });
        if (!current() || !form.isConnected) return;
        modal.close();
        await refresh();
        if (location.hash === "#roster") await rosterPage(); else render();
        toast("Member updated. No email sent.");
      } catch (error) {
        if (!current() || !form.isConnected) return;
        form.querySelector("#form-error").textContent = error.message;
        delete form.dataset.pending;
        controls.forEach((control, index) => control.disabled = disabled[index]);
      }
    };
  } catch (error) { if (current()) formError(error.message); }
}
function editAcademicSettings(member) {
  if (user?.role !== "chair") return;
  openModal(
    "MANAGE MEMBER",
    `Manage ${esc(member.name)}. Tier changes update point targets; previously awarded points stay unchanged.`,
    `<form id="academic-settings-form"><div class="form-grid"><div class="field"><label for="academic-tier">Assigned tier</label><select id="academic-tier" name="tier">${[1, 2, 3, 4, 5].map((tier) => `<option value="${tier}"${member.tier === tier ? " selected" : ""}>Tier ${tier} · ${rules.checkpoints.at(-1).targets[tier - 1]}-point goal</option>`).join("")}</select></div><div class="field"><label for="academic-credits">Enrolled credits</label><input id="academic-credits" name="credits" type="text" readonly value="${member.creditsManaged ? esc(member.credits) : "N/A"}">${member.creditsManaged ? '<small>Total from approved classes. Review class changes in the Classes tab.</small>' : '<small>Hours appear after class approval. Use Manage credits to review classes.</small>'}</div></div><p><button type="button" class="table-link" data-action="adjust-points" data-id="${esc(member.id)}">Adjust approved points</button></p><p class="footnote">Use the page-5 GPA ranges: 3.50+ Tier 1, 3.00–3.49 Tier 2, 2.70–2.99 Tier 3, 2.50–2.69 Tier 4, below 2.50 Tier 5. New members use Tier 1.</p><div id="form-error" role="alert"></div><div class="modal-actions"><button class="button ghost" type="button" data-action="close">Cancel</button><button class="button gold" type="submit">Save changes</button></div></form>`,
  );
  $("#academic-settings-form").onsubmit = async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    try {
      await api("/api/roster/" + encodeURIComponent(member.id) + "/academic-settings", {
        method: "POST",
        body: { tier: Number(values.tier), credits: member.credits },
      });
      modal.close();
      await refresh();
      if (location.hash === "#roster") await rosterPage();
      else render();
      toast("Member settings updated.");
    } catch (error) { formError(error.message); }
  };
}
function createPilotAccounts() {
  if (user?.role !== "chair") return;
  openModal("CREATE PILOT ACCOUNTS", "Three real member accounts for testing", `<p>Creates Glazebrook, Marshall, and Ross with separate random passwords and 30-day access. Their submissions persist and appear in your review queue. No emails are sent. Save the passwords shown after creation; they are displayed once.</p><form id="pilot-create-form"><label class="checkbox-line"><input type="checkbox" required><span>Create these three member-only pilot accounts.</span></label><div id="form-error" role="alert"></div><div class="modal-actions"><button class="button ghost" type="button" data-action="close">Cancel</button><button class="button gold" type="submit">Create accounts</button></div></form>`);
  $("#pilot-create-form").onsubmit = async event => {
    event.preventDefault();
    const button = event.target.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const result = await api("/api/admin/pilot-accounts", {method:"POST", body:{confirm:"CREATE THREE PILOT ACCOUNTS"}});
      openModal("SAVE PILOT PASSWORDS", "These passwords will not be shown again.", `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Password</th><th>Tier</th></tr></thead><tbody>${result.accounts.map(account=>`<tr><td>${esc(account.name)}</td><td><code>${esc(account.username)}</code></td><td><code>${esc(account.password)}</code></td><td>${account.tier}</td></tr>`).join("")}</tbody></table></div><p>Access expires ${esc(new Date(result.accounts[0].expiresAt).toLocaleDateString())}. Use the normal login page. Each account can save its recovery key on first login.</p><div class="modal-actions"><button class="button gold" data-action="close">I saved the passwords</button></div>`);
      await rosterPage();
    } catch(error) { formError(error.message); button.disabled = false; }
  };
}
async function openTierImport() {
  if (user?.role !== "chair") return;
  const owner = user.id, epoch = sessionEpoch;
  let sheet = null, rows = [], targets = [], cancelled = false, fileVersion = 0, sheetVersion = 0;
  let workbook = null, workbookAbort = null;
  const current = () => !cancelled && modal.open && user?.id === owner && sessionEpoch === epoch;
  modal.classList.add("tier-import-dialog");
  openModal("IMPORT GPA TIERS", "Scholarship Chair only", loading("Loading the eligible roster…"));
  modal.addEventListener("close", () => {
    cancelled = true;
    workbookAbort?.abort();
    workbook?.close();
    workbook = null;
    sheet = null;
    rows = [];
    targets = [];
    modal.classList.remove("tier-import-dialog");
    $("#modal-content").replaceChildren();
  }, { once: true });
  try {
    const [view, helpers] = await Promise.all([
      api("/api/admin/tier-import"), import("/gpa-import.mjs"),
    ]);
    if (!current()) return;
    const { readGpaSheet, gpaColumnChoices, detectGpaMapping, mapGpaSheet, suggestTarget, nameKey, reviewedTierAssignments } = helpers;
    targets = view.targets.filter((entry) => entry.accountStatus !== "inactive");
    const targetByEmail = new Map(targets.map((entry) => [entry.email, entry]));
    const rosterIdIssues = targets.filter(entry => entry.schoolIdIssue);
    const fields = [["gpa", "GPA column"], ["schoolId", "900 number column"],
      ["first", "First name"], ["last", "Last name"], ["full", "Full name"], ["email", "Email (optional)"]];
    const columnField = ([key, label]) => `<div class="field" data-gpa-field="${key}"><label for="gpa-column-${key}">${label}</label><select id="gpa-column-${key}"${["gpa", "schoolId"].includes(key) ? ` aria-describedby="gpa-column-${key}-hint"` : ""}></select>${["gpa", "schoolId"].includes(key) ? `<small id="gpa-column-${key}-hint"></small>` : ""}</div>`;
    openModal("IMPORT GPA TIERS", "Choose the sheet layout, preview the results, then apply",
      `<p class="footnote">Choose an Excel workbook or CSV file. GPA and 900 numbers stay in this import session; only the reviewed tiers are saved.</p>${rosterIdIssues.length ? `<div class="notice info"><strong>${rosterIdIssues.length} roster ${rosterIdIssues.length === 1 ? "entry needs" : "entries need"} a student ID correction</strong><p>Other members can still be imported. Correct these rows in the roster, refresh it, and reopen the import.</p><ul>${rosterIdIssues.map(entry => `<li>${esc(entry.name)}: ${esc(entry.schoolIdIssue)}</li>`).join("")}</ul></div>` : ""}<div class="field"><label for="gpa-csv">GPA spreadsheet</label><input id="gpa-csv" type="file" accept=".xlsx,.xls,.xlx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"><small>Excel (.xlsx or .xls), up to 5 MB; CSV, up to 1 MB. Google Sheets: File → Download → Microsoft Excel (.xlsx).</small></div><div id="gpa-worksheet-field" class="field" hidden><label for="gpa-worksheet">Worksheet</label><select id="gpa-worksheet"></select><small>Select the worksheet containing this semester’s GPA list.</small></div><section id="gpa-layout" class="import-layout" hidden><h3>CHOOSE COLUMNS</h3><p class="footnote">Select the GPA and 900 number columns using their spreadsheet letters or header names.</p><div class="form-grid">${fields.slice(0, 2).map(columnField).join("")}<div class="field"><label for="gpa-header-row">Header row</label><input id="gpa-header-row" type="number" min="0" max="1000" value="1"><small>Use 0 if the sheet has no header.</small></div><div class="field"><label for="gpa-first-row">First member row</label><input id="gpa-first-row" type="number" min="1" max="1100" value="2"></div><div class="field span2"><label for="gpa-name-mode">Names are stored as</label><select id="gpa-name-mode"><option value="split">Separate first and last names</option><option value="full">One full-name column</option></select></div>${fields.slice(2).map(columnField).join("")}</div><div id="gpa-layout-sample" class="import-layout-sample"></div><div class="heading-actions"><button class="button ghost small" id="detect-gpa-columns" type="button">Match header names</button><button class="button ghost small" id="save-gpa-layout" type="button">Save layout for next time</button><button class="button gold small" id="preview-gpa-tiers" type="button">Preview tiers</button></div></section><div id="gpa-import-preview"></div><p id="gpa-import-status" role="status"></p><label id="gpa-confirm-label" class="recovery-confirm" hidden><input type="checkbox" id="gpa-confirm"> I checked the member matches and proposed tiers.</label><div id="form-error" role="alert"></div><div class="modal-actions"><button class="button ghost" type="button" data-action="close">Cancel</button><button class="button gold" type="button" id="apply-gpa-tiers" disabled>Apply reviewed tiers</button></div>`);
    const layout = $("#gpa-layout"), preview = $("#gpa-import-preview"), statusLine = $("#gpa-import-status"),
      apply = $("#apply-gpa-tiers"), fileInput = $("#gpa-csv"), confirmed = $("#gpa-confirm");
    const clearError = () => { $("#form-error").textContent = ""; };
    function readMapping() {
      return { headerRow: Number($("#gpa-header-row").value), firstDataRow: Number($("#gpa-first-row").value),
        nameMode: $("#gpa-name-mode").value,
        columns: Object.fromEntries(fields.map(([key]) => [key, Number($("#gpa-column-" + key).value)])) };
    }
    function updateColumnOptions(columns) {
      const headerRow = Number($("#gpa-header-row").value);
      const choices = gpaColumnChoices(sheet, headerRow);
      for (const [key] of fields) {
        const selector = $("#gpa-column-" + key), selected = columns?.[key] ?? Number(selector.value || -1);
        selector.innerHTML = `<option value="-1">${["schoolId", "email"].includes(key) ? "Not in this sheet" : "Choose a column"}</option>` +
          choices.map(({ value, label }) => `<option value="${value}">${esc(label)}</option>`).join("");
        selector.value = selected >= 0 && selected < sheet.columnCount ? String(selected) : "-1";
      }
    }
    function showLayout(mapping) {
      $("#gpa-header-row").value = mapping.headerRow;
      $("#gpa-first-row").value = mapping.firstDataRow;
      $("#gpa-name-mode").value = mapping.nameMode;
      updateColumnOptions(mapping.columns);
      updateLayoutSample();
    }
    function updateLayoutSample() {
      const mapping = readMapping();
      for (const key of ["first", "last", "full"])
        $(`[data-gpa-field="${key}"]`).hidden = mapping.nameMode === "full" ? key !== "full" : key === "full";
      const shown = fields.filter(([key]) => (mapping.nameMode === "full" ? !["first", "last"].includes(key) : key !== "full") && mapping.columns[key] >= 0);
      const start = Math.max(0, mapping.firstDataRow - 1);
      for (const key of ["gpa", "schoolId"]) {
        const column = mapping.columns[key], sample = sheet.rows[start]?.[column]?.trim();
        $("#gpa-column-" + key + "-hint").textContent = column < 0 ?
          key === "gpa" ? "Required. Use the previous-semester GPA." : "Optional. Members can also be matched by name or email." :
          sample ? `Row ${start + 1}: ${sample}` : `Row ${start + 1} is blank in this column. Check the first member row below.`;
      }
      $("#gpa-layout-sample").innerHTML = shown.length ?
        `<p class="footnote">Sample from the selected columns</p><div class="table-wrap"><table><thead><tr><th>Row</th>${shown.map(([, label]) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${sheet.rows.slice(start, start + 3).map((cells, index) => `<tr><td>${start + index + 1}</td>${shown.map(([key]) => `<td>${esc(cells[mapping.columns[key]] || "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : "";
    }
    function invalidatePreview() {
      rows = [];
      preview.replaceChildren();
      confirmed.checked = false;
      $("#gpa-confirm-label").hidden = true;
      apply.disabled = true;
      statusLine.textContent = "Choose the columns, then preview tiers.";
    }
    function selectedTier(item) {
      return targetByEmail.get(item.email)?.membership === "new_member" ? 1 : item.row.tier;
    }
    function updateApply() {
      try { reviewedTierAssignments(rows, targets); apply.disabled = !confirmed.checked; }
      catch { apply.disabled = true; }
    }
    function renderPreview() {
      const selected = rows.filter((item) => item.email && item.email !== "skip");
      const duplicate = new Set(selected.map((item) => item.email)).size !== selected.length;
      const unresolved = rows.filter((item) => !item.email).length;
      const invalid = selected.filter((item) => !selectedTier(item)).length;
      const skipped = rows.filter((item) => item.email === "skip").length;
      const invalidIds = rows.filter((item) => item.email !== "skip" && item.row.schoolIdIssue).length;
      statusLine.textContent = `${selected.length} selected · ${unresolved} need a match · ${skipped} skipped${duplicate ? " · duplicate member selected" : ""}${invalid ? ` · ${invalid} invalid GPA` : ""}${invalidIds ? ` · ${invalidIds} 900 numbers need correction or skipping` : ""}.`;
      $("#gpa-confirm-label").hidden = false;
      preview.innerHTML = `<p class="footnote">Page 5: 3.50+ → Tier 1 · 3.00–3.49 → Tier 2 · 2.70–2.99 → Tier 3 · 2.50–2.69 → Tier 4 · below 2.50 → Tier 5. New members use Tier 1.</p><div class="table-wrap tier-import-table"><table><thead><tr><th>Sheet row</th><th>GPA</th><th>Roster match</th><th>Tier change</th></tr></thead><tbody>${rows.map((item, index) => {
        const target = targetByEmail.get(item.email);
        let note = "Choose a roster member or skip this row";
        if (target) {
          const numberMatches = item.row.schoolId && target.schoolId === item.row.schoolId;
          const nameMatches = nameKey(target.name) === nameKey(item.row.name);
          note = item.row.schoolId ? numberMatches ? nameMatches ? "900 and name match" : "900 matches; review the different name" : "Selected member's 900 differs—review this match" : nameMatches ? "Name match; no 900 supplied" : "Names differ—review this match";
        }
        if (item.row.schoolIdIssue) note = item.row.schoolIdIssue;
        const oldTier = target?.currentTier ?? target?.stagedTier;
        return `<tr><td><strong>${esc(item.row.name || `Row ${item.row.line}`)}</strong><small>Row ${item.row.line}${item.row.schoolId ? ` · 900 ending ${esc(item.row.schoolId.slice(-4))}` : ""}</small><small>${esc(note)}</small></td><td>${esc(item.row.gpa || "—")}</td><td><label class="sr-only" for="gpa-match-${index}">Roster match for ${esc(item.row.name || `row ${item.row.line}`)}</label><select id="gpa-match-${index}" class="gpa-match" data-index="${index}"><option value=""${!item.email ? " selected" : ""}>Choose member</option><option value="skip"${item.email === "skip" ? " selected" : ""}>Skip this row</option>${targets.map((entry) => `<option value="${esc(entry.email)}"${item.email === entry.email ? " selected" : ""}${entry.schoolIdIssue ? " disabled" : ""}>${esc(entry.name)} · ${esc(entry.email)}${entry.schoolIdIssue ? " · Fix roster ID first" : ""}</option>`).join("")}</select>${target?.membership === "new_member" ? '<small>New member · Tier 1</small>' : ""}</td><td>${item.email === "skip" ? "Skipped" : item.row.schoolIdIssue ? "Correct student ID" : !target ? "Choose member" : selectedTier(item) ? `${oldTier ? `Tier ${oldTier}` : "Unassigned"} → Tier ${selectedTier(item)}` : "Check GPA"}</td></tr>`;
      }).join("")}</tbody></table></div>`;
      updateApply();
    }
    const worksheetField = $("#gpa-worksheet-field"), worksheetSelect = $("#gpa-worksheet");
    function loadSheet(parsed, useSavedMapping = false) {
      sheet = parsed;
      layout.hidden = false;
      const mapping = useSavedMapping && view.mapping;
      showLayout(mapping || detectGpaMapping(sheet));
      clearError();
      statusLine.textContent = `${sheet.rows.length} sheet rows read. ${mapping ? "Saved column choices loaded; check them for this sheet." : "Choose or check the GPA and 900 number columns."} Preview tiers before applying.${sheet.warnings?.length ? ` ${sheet.warnings.join(" ")}` : ""}`;
    }
    async function selectWorksheet(useSavedMapping = false) {
      const version = fileVersion, revision = ++sheetVersion, source = workbook;
      invalidatePreview();
      clearError();
      sheet = null;
      layout.hidden = true;
      statusLine.innerHTML = loading("Reading the worksheet in this browser…", true);
      try {
        const parsed = await source.readSheet(Number(worksheetSelect.value));
        if (!current() || version !== fileVersion || revision !== sheetVersion) return;
        loadSheet(parsed, useSavedMapping);
      } catch (error) {
        if (current() && version === fileVersion && revision === sheetVersion) {
          statusLine.textContent = "";
          formError(error.message);
        }
      }
    }
    worksheetSelect.onchange = () => selectWorksheet(false);
    fileInput.onchange = async () => {
      const version = ++fileVersion;
      ++sheetVersion;
      workbookAbort?.abort();
      workbook?.close();
      workbook = null;
      invalidatePreview();
      clearError();
      sheet = null;
      layout.hidden = true;
      worksheetField.hidden = true;
      worksheetSelect.replaceChildren();
      statusLine.innerHTML = loading("Reading the spreadsheet in this browser…", true);
      try {
        const file = fileInput.files?.[0];
        if (!file) throw Error("Choose an Excel workbook or CSV file.");
        const extension = (file.name || "gpa.csv").split(".").at(-1).toLowerCase();
        if (extension === "csv") {
          if (file.size > 1_000_000) throw Error("Choose a CSV file under 1 MB.");
          const parsed = readGpaSheet(await file.text());
          if (!current() || version !== fileVersion) return;
          loadSheet(parsed, true);
        } else if (["xlsx", "xls", "xlx"].includes(extension)) {
          if (file.size > 5 * 1024 * 1024) throw Error("Choose an Excel workbook under 5 MB.");
          const { openGpaWorkbook } = await import("/gpa-workbook.mjs");
          if (!current() || version !== fileVersion) return;
          workbookAbort = new AbortController();
          const opened = await openGpaWorkbook(file, { signal: workbookAbort.signal });
          if (!current() || version !== fileVersion) { opened.close(); return; }
          workbook = opened;
          worksheetSelect.innerHTML = workbook.sheets.map((entry, index) =>
            `<option value="${index}">${esc(entry.name)}${entry.hidden ? " (hidden)" : ""}</option>`).join("");
          worksheetSelect.value = String(Math.max(0, workbook.sheets.findIndex(entry => !entry.hidden)));
          worksheetField.hidden = false;
          await selectWorksheet(true);
        } else throw Error("Choose an Excel (.xlsx or .xls) workbook or a CSV file.");
      } catch (error) {
        if (current() && version === fileVersion) { statusLine.textContent = ""; formError(error.message); }
      } finally { if (current() && version === fileVersion) fileInput.value = ""; }
    };
    layout.onchange = (event) => {
      if (!sheet) return;
      if (event.target.id === "gpa-header-row") updateColumnOptions(readMapping().columns);
      updateLayoutSample();
      invalidatePreview();
      clearError();
    };
    $("#detect-gpa-columns").onclick = () => {
      const mapping = detectGpaMapping(sheet, Number($("#gpa-header-row").value));
      mapping.firstDataRow = Number($("#gpa-first-row").value);
      showLayout(mapping);
      invalidatePreview();
      clearError();
    };
    $("#save-gpa-layout").onclick = async (event) => {
      const button = event.target;
      button.disabled = true;
      try {
        const mapping = readMapping();
        mapGpaSheet(sheet, mapping);
        await api("/api/admin/tier-import/settings", { method: "POST", body: { mapping } });
        if (!current()) return;
        view.mapping = mapping;
        clearError();
        toast("Sheet layout saved. No GPA data was saved.");
      } catch (error) { if (current()) formError(error.message); }
      finally { if (current()) button.disabled = false; }
    };
    $("#preview-gpa-tiers").onclick = () => {
      try {
        rows = mapGpaSheet(sheet, readMapping()).map((row) => ({ row, email: suggestTarget(row, targets) }));
        confirmed.checked = false;
        clearError();
        renderPreview();
      } catch (error) { invalidatePreview(); formError(error.message); }
    };
    preview.onchange = (event) => {
      const selector = event.target.closest(".gpa-match");
      if (!selector) return;
      const index = Number(selector.dataset.index);
      rows[index].email = selector.value;
      confirmed.checked = false;
      renderPreview();
      $("#gpa-match-" + index).focus();
    };
    confirmed.onchange = updateApply;
    apply.onclick = async () => {
      apply.disabled = true;
      try {
        if (!confirmed.checked) throw Error("Check the member matches and proposed tiers before applying.");
        const assignments = reviewedTierAssignments(rows, targets);
        const result = await api("/api/admin/tier-import", {
          method: "POST", body: { snapshot: view.snapshot, assignments },
        });
        if (!current()) return;
        modal.close();
        await rosterPage();
        toast(`${result.updated} member tiers updated; ${result.staged} saved for later invitations.`);
      } catch (error) { if (current()) { formError(error.message); updateApply(); } }
    };
  } catch (error) {
    if (current()) openModal("GPA IMPORT UNAVAILABLE", "", `<p class="error">${esc(error.message)}</p><div class="modal-actions"><button class="button ghost" data-action="close">Close</button></div>`);
  }
}

async function auditPage() {
  main.innerHTML =
    heading(
      "",
      "Review history",
      "Decisions, membership changes, and evidence access.",
    ) +
    `<section class="panel" id="audit-table">${loading("Loading review history…")}</section>`;
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
      if (b.disabled) return;
      b.disabled = true;
      sessionEpoch++;
      submissionDraft = null;
      submissionSearch = "";
      submissionMember = "";
      submissionPageIndex = 0;
      modal.close();
      setAuthLoading(true, "Signing out…");
      try {
        // Finish server revocation independently of stale in-flight view requests.
        const response = await fetch("/api/logout", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "", "X-ATO-Expected-User": user?.id || "", "X-ATO-Demo": "1" },
          body: "{}", signal: AbortSignal.timeout(20000),
        });
        if (!response.ok && response.status !== 401) {
          const result = await response.json();
          throw Error(result.error || "Sign-out failed. Please try again.");
        }
        logs = []; rosterAccounts = []; rosterCandidates = [];
        location.replace("/");
      } catch (error) {
        setAuthLoading(false);
        b.disabled = false;
        throw error;
      }
    } else if (b.dataset.action === "add-member") addMember();
    else if (b.dataset.action === "create-pilot-accounts") createPilotAccounts();
    else if (b.dataset.action === "import-gpa-tiers") await openTierImport();
    else if (b.dataset.action === "invite-roster-member") {
      const entry = rosterCandidates[Number(b.dataset.index)];
      if (entry) addMember(entry);
    }
    else if (b.dataset.action === "correct-submission") await detail(b.dataset.id, true);
    else if (b.dataset.action === "manage-credits") await manageMemberCredits(b.dataset.id);
    else if (b.dataset.action === "edit-academic-settings") {
      const member = rosterAccounts.find((entry) => entry.id === b.dataset.id) || roster.find((entry) => entry.id === b.dataset.id) ||
        (appConfig.chapterAuth?.enabled ? { id: b.dataset.id, role: 'member', active: true } : null);
      if (member?.role === "member" && member.active !== false && member.active !== 0)
        await editMemberAccount(member);
    }
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
      render();
      toast("Canvas disconnected. Saved submissions remain in your record.");
    }
  } catch (err) {
    toast(err.message);
  }
});
