import { pointAdjustmentView, applyPointAdjustment } from "../point-adjustment-data.mjs";
import { categoriesFor, categoryView, applyCategoryChange, categoryForSubmission } from "../category-data.mjs";
import { checkpointQuotaView, validateCheckpointQuotas } from "../checkpoint-data.mjs";
import { creditSummary } from "../credit-data.mjs";
import { profileView } from "../profile-data.mjs";
import { classView, classInput, classCredits, creditsManaged, approvedClassCredits, approveClassCredits, refreshPendingCreditEstimates, removalView, syllabusView, assignmentClass, submissionSyllabus } from "../syllabus-data.mjs";
// GitHub Pages demonstration only. Requests are simulated in this browser.
// Only sessionStorage contains fictional data; no server or persistent database is used.
import {
  TODAY,
  members,
  activities,
  multiplier,
  seed,
  totals,
  validateClaim,
} from "./demo-domain.mjs";
import { canvasAssignments, sampleAssignments } from "./demo-canvas.mjs";
import { faqView, validateFaqChange, applyFaqChange } from "../faq-data.mjs";
// Session storage belongs to this tab and is cleared when its session ends.
const storageKey = "ato-scholarship-demo-data";
async function read() {
  const value = sessionStorage.getItem(storageKey);
  return value ? JSON.parse(value) : null;
}
async function save(session) {
  sessionStorage.setItem(storageKey, JSON.stringify(session));
}
const json = (data, status = 200) =>
  new Response(JSON.stringify({ mode: "browser-demo", ...data }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
function sandboxSyllabusFile(file) {
  const message = "Choose a PDF, PNG, or JPEG syllabus under 1 MB for the sandbox.";
  if (!file || typeof file.name !== "string" || !file.name.trim() || file.name.length > 200 ||
      typeof file.dataUrl !== "string" || file.dataUrl.length > 1400000 ||
      !["application/pdf", "image/png", "image/jpeg"].includes(file.mime) ||
      !Number.isInteger(file.size) || file.size <= 0 || file.size > 1048576) fail(422, message);
  const match = file.dataUrl.match(/^data:(application\/pdf|image\/png|image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1] !== file.mime) fail(422, message);
  let bytes;
  try { bytes = atob(match[2]); } catch { fail(422, message); }
  if (bytes.length !== file.size || btoa(bytes) !== match[2]) fail(422, message);
  const signatures = {
    "application/pdf": [37, 80, 68, 70, 45],
    "image/png": [137, 80, 78, 71, 13, 10, 26, 10],
    "image/jpeg": [255, 216, 255],
  };
  if (!signatures[file.mime].every((byte, index) => bytes.charCodeAt(index) === byte)) fail(422, message);
  return { name: file.name.trim(), mime: file.mime, size: file.size, dataUrl: file.dataUrl };
}
function quotaMember(state, member) {
  if (member.role !== "member") return member;
  member = { ...member, tier: state.tierOverrides?.[member.id] ?? member.tier };
  const { checkpoints } = checkpointQuotaView(state);
  const checkpoint = checkpoints.find(entry => entry.date >= TODAY) || checkpoints.at(-1);
  return { ...member, creditsManaged: creditsManaged(state, member.id), credits: state.creditOverrides?.[member.id] ?? member.credits,
    goal: checkpoints.at(-1).targets[member.tier - 1],
    checkpoint: checkpoint.targets[member.tier - 1], checkpointDate: checkpoint.date };
}
// Keep the tab's read/validate/write operations ordered so two stale reviews
// cannot overwrite each other between sessionStorage reads.
let requests = Promise.resolve();
export function handle(req, path) {
  const response = requests.then(() => handleRequest(req, path));
  requests = response.catch(() => {});
  return response;
}
async function handleRequest(req, path) {
  try {
    if (!["GET", "POST"].includes(req.method)) fail(405, "Method not allowed.");
    const input = req.method === "POST" ? await req.json() : null;
    let session = await read();
    if (session && session.expires < Date.now()) session = null;
    if (path === "/api/demo/session" && req.method === "POST") {
      if (input.persona && !members.some((m) => m.id === input.persona))
        fail(400, "Unknown demo persona.");
      if (!session)
        session = {
          persona: input.persona || "alex",
          expires: Date.now() + 86400000,
          data: seed(),
        };
      else if (input.persona) session.persona = input.persona;
      if (!session.data.test2Seeded) {
        session.data.submissions.push(...seed().submissions.filter(item => item.owner === "test2"));
        session.data.test2Seeded = true;
      }
      await save(session);
      return json({
        user: quotaMember(session.data, members.find((m) => m.id === session.persona)),
        today: TODAY,
      });
    }
    if (!session) fail(401, "Start a demo session first.");
    if (
      req.headers.get("X-ATO-Expected-User") &&
      req.headers.get("X-ATO-Expected-User") !== session.persona
    )
      fail(
        409,
        "The demo account changed in another tab. Refresh before continuing.",
      );
    const sessionMembers = members.map(member => quotaMember(session.data, member));
    const state = session.data,
      user = sessionMembers.find((m) => m.id === session.persona);
    const chair = () => {
      if (user.role !== "chair")
        fail(403, "Only the Scholarship Chair can review submissions.");
    };
    const own = (id) => {
      const s = state.submissions.find((s) => s.id === id);
      if (!s || (user.role !== "chair" && s.owner !== user.id))
        fail(404, "Submission not found.");
      return s;
    };
    if (path === "/api/me" && req.method === "GET")
      return json({ user, today: TODAY });
    if (path === "/api/credit-requests" && req.method === "GET")
      return json({ credits: user.credits, requests: (state.creditRequests || []).filter(item => user.role === "chair" || item.owner === user.id).map(creditSummary) });
    if (path === "/api/credit-requests" && req.method === "POST") {
      if (user.role !== "member") fail(403, "Use a member account to submit.");
      fail(410, "Add credit hours to each class in My profile. The Scholarship Chair approves the class and its hours together.");
    }
    const creditRoute = path.match(/^\/api\/credit-requests\/([a-f0-9-]{36})\/(evidence|review)$/);
    if (creditRoute) {
      if (req.method === "POST" && creditRoute[2] === "review") {
        chair();
        fail(410, "Credit hours are now reviewed with each class. Use Classes to approve enrolled hours.");
      }
      const item = state.creditRequests?.find(item => item.id === creditRoute[1]);
      if (!item || (user.role !== "chair" && item.owner !== user.id)) fail(404, "Request not found.");
      if (req.method === "GET" && creditRoute[2] === "evidence") return json({ image: item.image });
    }
    if (path === "/api/profile/picture" && ["GET", "POST"].includes(req.method)) {
      if (user.role !== "member") fail(403, "Use a member account.");
      if (req.method === "POST") {
        if (input.image !== null && (typeof input.image !== "string" || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(input.image) || input.image.length > 1400000)) fail(422, "Choose a PNG or JPEG image under 1 MB.");
        state.profilePictures ||= {};
        if (input.image) state.profilePictures[user.id] = input.image;
        else delete state.profilePictures[user.id];
        await save(session);
      }
      return json({ image: state.profilePictures?.[user.id] || null });
    }
    if (path === "/api/point-categories" && ["GET", "POST"].includes(req.method)) {
      chair();
      if (req.method === "POST") {
        applyCategoryChange(state, input, () => crypto.randomUUID());
        await save(session);
      }
      return json(categoryView(state));
    }
    if (path === "/api/checkpoint-quotas" && ["GET", "POST"].includes(req.method)) {
      chair();
      if (req.method === "POST") {
        if (!input || Object.keys(input).sort().join(",") !== "targets,version" || typeof input.version !== "string") fail(422, "Provide checkpoint quotas and their version.");
        const targets = validateCheckpointQuotas(input.targets);
        if (input.version !== checkpointQuotaView(state).version) fail(409, "Checkpoint quotas changed. Reopen the editor before saving.");
        state.checkpointQuotas = targets;
        state.checkpointQuotaRevision = (state.checkpointQuotaRevision || 0) + 1;
        await save(session);
      }
      return json(checkpointQuotaView(state));
    }
    if (path === "/api/profile" && ["GET", "POST"].includes(req.method)) {
      if (user.role !== "member") fail(403, "Profiles are available to members only.");
      if (req.method === "POST") fail(422, "Add classes with a syllabus in My profile.");
      return json(profileView(state, user.id));
    }
    const memberClasses = () => {
      if (user.role !== "member") fail(403, "Classes are available to members only.");
    };
    const bumpProfile = (owner) => {
      state.memberProfiles ||= {};
      state.memberProfiles[owner] = { ...(state.memberProfiles[owner] || {}), version: crypto.randomUUID() };
    };
    if (path === "/api/classes" && req.method === "GET") {
      memberClasses();
      return json(classView(state, user.id, user.credits));
    }
    if (path === "/api/classes" && req.method === "POST") {
      memberClasses();
      const name = classInput(input), credits = classCredits(input), file = sandboxSyllabusFile(input.file);
      state.classRecords ||= [];
      state.syllabi ||= [];
      let course = input.classId ? state.classRecords.find(row => row.id === input.classId && row.owner === user.id && !row.archived) : null;
      if (input.classId && !course) fail(404, "Class not found.");
      if (course?.pendingRemoval) fail(409, "This class has a removal request awaiting Chair review.");
      if (course && input.version !== course.version) fail(409, "This class changed. Reload your classes before uploading.");
      if (state.classRecords.some(row => row.owner === user.id && !row.archived && row.id !== course?.id && row.name.toLowerCase() === name.toLowerCase()))
        fail(422, "This class is already in your profile. Replace its syllabus instead.");
      const existingClasses = classView(state, user.id, user.credits).classes;
      const legacy = existingClasses.find(row => !row.id && row.name.toLowerCase() === name.toLowerCase());
      if (!course && !legacy && existingClasses.length >= 20) fail(422, "Provide up to 20 classes.");
      if (legacy && input.version !== undefined && input.version !== legacy.version) fail(409, "Your classes changed. Reload before uploading.");
      const now = new Date().toISOString();
      if (!course) {
        course = { id: crypto.randomUUID(), owner: user.id, name, archived: false, createdAt: now };
        state.classRecords.push(course);
      }
      const item = { id: crypto.randomUUID(), classId: course.id, className: name, owner: user.id,
        credits, status: "pending", version: crypto.randomUUID(), fileName: file.name, mime: file.mime, file,
        reviewNote: "", createdAt: now, reviewedAt: null, reviewer: null };
      Object.assign(course, { name, syllabusId: item.id, version: crypto.randomUUID(), updatedAt: now });
      state.syllabi.push(item);
      bumpProfile(user.id);
      state.memberProfiles[user.id].courses = (state.memberProfiles[user.id].courses || []).filter(value => value.toLowerCase() !== name.toLowerCase());
      await save(session);
      const view = classView(state, user.id, user.credits);
      return json({ ...view, class: view.classes.find(row => row.id === course.id) }, 201);
    }
    if (path === "/api/classes/legacy/archive" && req.method === "POST") {
      memberClasses();
      const name = classInput(input);
      const legacy = classView(state, user.id, user.credits).classes.find(row => !row.id && row.name === name);
      if (!legacy) fail(404, "Class not found.");
      if (legacy.version !== input.version) fail(409, "Your classes changed. Reload before removing a class.");
      state.memberProfiles[user.id].courses = state.memberProfiles[user.id].courses.filter(course => course !== name);
      bumpProfile(user.id);
      await save(session);
      return json(classView(state, user.id, user.credits));
    }
    const classArchive = path.match(/^\/api\/classes\/([a-f0-9-]{36})\/archive$/);
    if (classArchive && req.method === "POST") {
      memberClasses();
      const course = state.classRecords?.find(row => row.id === classArchive[1] && row.owner === user.id && !row.archived);
      if (!course) fail(404, "Class not found.");
      if (course.version !== input.version) fail(409, "This class changed. Reload before removing it.");
      if (course.pendingRemoval) fail(409, "This class already has a removal request awaiting Chair review.");
      if (course.approvedCredits !== undefined && course.approvedCredits !== null)
        course.pendingRemoval = { version: crypto.randomUUID(), createdAt: new Date().toISOString() };
      else course.archived = true;
      Object.assign(course, { version: crypto.randomUUID(), updatedAt: new Date().toISOString() });
      bumpProfile(user.id);
      await save(session);
      return json(classView(state, user.id, user.credits));
    }
    const removalReview = path.match(/^\/api\/classes\/([^/]+)\/removal-review$/);
    if (removalReview && req.method === "POST") {
      chair();
      const note = typeof input.note === "string" ? input.note.trim() : "";
      if (!["approved", "denied"].includes(input.decision) || note.length > 1000 || (input.decision === "denied" && note.length < 5))
        fail(422, "Approve the removal or deny it with a reason of at least 5 characters.");
      const course = state.classRecords?.find(row => row.id === removalReview[1] && !row.archived);
      if (!course?.pendingRemoval || course.pendingRemoval.version !== input.version)
        fail(409, "This removal changed or was already reviewed. Reload the list.");
      const target = sessionMembers.find(row => row.id === course.owner && row.role === "member");
      if (!target) fail(404, "Active member not found.");
      if (input.decision === "approved") {
        course.archived = true;
        state.creditOverrides ||= {};
        state.creditOverrides[course.owner] = approvedClassCredits(state, course.owner);
        refreshPendingCreditEstimates(state, course.owner, multiplier({ credits: state.creditOverrides[course.owner] }));
      }
      delete course.pendingRemoval;
      Object.assign(course, { version: crypto.randomUUID(), updatedAt: new Date().toISOString(), removalReview: { decision: input.decision, note, reviewer: user.name, reviewedAt: new Date().toISOString() } });
      bumpProfile(course.owner);
      await save(session);
      return json({ classId: course.id, decision: input.decision, ...classView(state, course.owner, quotaMember(state, target).credits) });
    }
    if (path === "/api/syllabi" && req.method === "GET") {
      chair();
      const owners = new Map(sessionMembers.map(row => [row.id, row]));
      return json({ syllabi: (state.syllabi || []).map(item => ({ ...syllabusView(state, item, owners.get(item.owner)?.credits ?? null), memberName: owners.get(item.owner)?.name || "Member" })).filter(item => item.current).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        removals: (state.classRecords || []).filter(row => !row.archived && row.pendingRemoval).map(row => ({ ...removalView(state, row, owners.get(row.owner)?.credits ?? null), memberName: owners.get(row.owner)?.name || "Member" })) });
    }
    const syllabusRoute = path.match(/^\/api\/syllabi\/([a-f0-9-]{36})\/(evidence|review)$/);
    if (syllabusRoute) {
      const item = state.syllabi?.find(row => row.id === syllabusRoute[1]);
      if (!item || (user.role !== "chair" && item.owner !== user.id)) fail(404, "Syllabus not found.");
      if (syllabusRoute[2] === "evidence" && req.method === "GET")
        return json({ name: item.fileName, mime: item.mime, previewUrl: item.file.dataUrl, downloadUrl: item.file.dataUrl });
      if (syllabusRoute[2] === "review" && req.method === "POST") {
        chair();
        if (item.version !== input.version || item.status !== "pending" || !syllabusView(state, item).current || syllabusView(state, item).removalPending)
          fail(409, "This syllabus changed or has already been reviewed. Reload the list.");
        if (!["approved", "denied"].includes(input.decision)) fail(422, "Choose approve or deny.");
        const note = typeof input.note === "string" ? input.note.trim() : "";
        if (note.length > 1000 || (input.decision === "denied" && note.length < 5))
          fail(422, "Add a reason for a denial (5–1,000 characters).");
        const course = state.classRecords.find(row => row.id === item.classId && row.owner === item.owner);
        if (input.decision === "approved") {
          const total = approveClassCredits(state, course, item.credits);
          state.creditOverrides ||= {};
          state.creditOverrides[item.owner] = total;
          refreshPendingCreditEstimates(state, item.owner, multiplier({ credits: total }));
        }
        const now = new Date().toISOString();
        Object.assign(item, { status: input.decision, reviewNote: note, reviewer: user.name, reviewedAt: now, version: crypto.randomUUID() });
        Object.assign(course, { version: crypto.randomUUID(), updatedAt: now });
        bumpProfile(item.owner);
        await save(session);
        return json({ syllabus: syllabusView(state, item, quotaMember(state, sessionMembers.find(row => row.id === item.owner)).credits) });
      }
    }
    if (path === "/api/faq" && req.method === "GET") return json(faqView(state));
    if (path === "/api/faq" && req.method === "POST") {
      chair();
      const change = validateFaqChange(input);
      const view = faqView(state);
      if (input.version !== view.version) fail(409, "The FAQ changed. Reload the page before saving.");
      state.faqEntries = applyFaqChange(view.entries, change, () => crypto.randomUUID());
      state.faqRevision = crypto.randomUUID();
      await save(session);
      return json(faqView(state));
    }
    if (path === "/api/rules" && req.method === "GET")
      return json({
        activities: categoriesFor(state),
        categoryVersion: categoryView(state).version,
        today: TODAY,
        submissionWindowDays: 14,
        weeklyStudyHours: 5,
        weeklyMinorAssignments: categoriesFor(state).find(item => item.id === "minor")?.weeklyLimit ?? null,
        weekConvention: "Monday–Sunday (demo assumption)",
        checkpoints: checkpointQuotaView(state).checkpoints,
      });
    const academicRoute = path.match(/^\/api\/roster\/([^/]+)\/academic-settings$/);
    if (academicRoute && req.method === "POST") {
      chair();
      if (Object.keys(input).sort().join(",") !== "credits,tier" || !Number.isInteger(input.tier) || input.tier < 1 || input.tier > 5 || !Number.isFinite(input.credits) || input.credits < 0 || input.credits > 30)
        fail(422, "Choose a tier from 1–5 and enrolled credits from 0–30.");
      const target = sessionMembers.find(member => member.id === academicRoute[1] && member.role === "member");
      if (!target) fail(404, "Member not found.");
      if (creditsManaged(state, target.id) && target.credits !== input.credits)
        fail(409, "This member’s credit hours come from approved classes. Review their classes to change the total.");
      state.tierOverrides ||= {};
      state.creditOverrides ||= {};
      state.tierOverrides[target.id] = input.tier;
      state.creditOverrides[target.id] = input.credits;
      refreshPendingCreditEstimates(state, target.id, multiplier({ credits: input.credits }));
      await save(session);
      return json({ member: quotaMember(state, target) });
    }
    const adjustmentRoute = path.match(/^\/api\/members\/([^/]+)\/point-adjustments$/);
    if (adjustmentRoute && ["GET", "POST"].includes(req.method)) {
      if (req.method === "POST") chair();
      const target = sessionMembers.find(member => member.id === adjustmentRoute[1] && member.role === "member");
      if (!target || (user.role !== "chair" && target.id !== user.id)) fail(404, "Member not found.");
      if (req.method === "GET") return json(pointAdjustmentView(state, target));
      const result = applyPointAdjustment(state, target, input, user, crypto.randomUUID(), new Date().toISOString());
      await save(session);
      return json(result);
    }
    if (path === "/api/points" && req.method === "GET") {
      if (user.role !== "member")
        fail(400, "Choose a member view for individual points.");
      return json({ member: user.id, ...totals(state, user) });
    }
    if (path === "/api/members" && req.method === "GET") {
      chair();
      return json({
        members: sessionMembers
          .filter((m) => m.role === "member")
          .map((m) => ({ ...m, ...totals(state, m) })),
      });
    }
    if (path === "/api/submissions" && req.method === "GET")
      return json({
        submissions: state.submissions
          .filter((s) => user.role === "chair" || s.owner === user.id)
          .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
          .map((s) => ({
            ...s,
            memberName: members.find((m) => m.id === s.owner).name,
          })),
      });
    const make = (claim) => ({
      ...claim,
      id: "S-" + crypto.randomUUID().slice(0, 8).toUpperCase(),
      owner: user.id,
      status: "pending",
      awarded: 0,
      submittedAt: new Date().toISOString(),
      reviewNote: "",
      history: [
        { event: "Submitted for review", at: new Date().toISOString() },
      ],
    });
    if (path === "/api/submissions" && req.method === "POST") {
      if (user.role !== "member") fail(403, "Use a member account to submit.");
      let claim;
      try {
        const reference = assignmentClass(state, user.id, categoriesFor(state).find(item => item.id === input.activity), input);
        claim = { ...validateClaim({ ...input, ...reference }, state, user), ...reference };
      } catch (e) {
        fail(e.status || 422, e.message);
      }
      const item = make(claim);
      state.submissions.push(item);
      await save(session);
      return json({ submission: item, points: totals(state, user) }, 201);
    }
    if (
      path === "/api/integrations/canvas/assignments" &&
      req.method === "GET"
    ) {
      if (user.role !== "member")
        fail(403, "Canvas imports belong to the member.");
      return json({
        providerConnected: false,
        assignments: sampleAssignments(state, user.id),
        note: "Fictional Canvas-shaped data; no Canvas request was made.",
      });
    }
    if (path === "/api/integrations/canvas/import" && req.method === "POST") {
      if (user.role !== "member") fail(403, "Use a member account.");
      if (
        input.confirm !== true ||
        !Array.isArray(input.items) ||
        input.items.length < 1 ||
        input.items.length > 10
      )
        fail(422, "Select assignments and confirm the categories.");
      const added = [],
        skipped = [];
      for (const selected of input.items) {
        const a = canvasAssignments.find((a) => a.id === selected.assignmentId);
        if (!a) fail(422, "Unknown sample assignment.");
        if (!["major", "minor", "lab"].includes(selected.activity))
          fail(422, "Choose major, minor, or lab.");
        if (
          state.submissions.some(
            (s) =>
              s.owner === user.id &&
              s.canvasCourseId === a.course_id &&
              s.canvasAssignmentId === a.id &&
              s.status !== "denied",
          )
        ) {
          skipped.push(a.id);
          continue;
        }
        let claim;
        try {
          const reference = assignmentClass(state, user.id, categoriesFor(state).find(item => item.id === selected.activity), selected);
          claim = { ...validateClaim(
            {
              title: a.name,
              course: reference.course || a.course,
              date: a.submission.graded_at.slice(0, 10),
              activity: selected.activity,
              grade: (a.submission.score / a.points_possible) * 100,
              evidence: "sample",
              confirm: true,
              note: "Imported from fictional Canvas sample. Chair must verify classification.",
            },
            state,
            user,
          ), ...reference };
        } catch (e) {
          fail(422, a.name + ": " + e.message);
        }
        const item = {
          ...make(claim),
          source: "canvas-sample",
          canvasCourseId: a.course_id,
          canvasAssignmentId: a.id,
        };
        state.submissions.push(item);
        added.push(item);
      }
      await save(session);
      return json(
        {
          imported: added,
          skippedDuplicateAssignmentIds: skipped,
          points: totals(state, user),
        },
        201,
      );
    }
    const route = path.match(
      /^\/api\/submissions\/([^/]+)(?:\/(review|evidence))?$/,
    );
    if (route) {
      const item = own(route[1]);
      if (!route[2] && req.method === "GET")
        return json({
          submission: {
            ...item,
            syllabus: submissionSyllabus(state, item),
            memberName: members.find((m) => m.id === item.owner).name,
          },
        });
      if (route[2] === "evidence" && req.method === "GET")
        return json({
          evidence: {
            sample: true,
            syllabus: submissionSyllabus(state, item),
            submission: item.id,
            title: item.title,
            activity: categoryForSubmission(state, item)?.name || item.activity,
            course: item.course,
            date: item.date,
            grade: item.grade,
            hours: item.quantity,
            note: item.note,
            verification:
              "Fictional sample record; no real academic documentation was uploaded.",
          },
        });
      if (route[2] === "review" && req.method === "POST") {
        chair();
        if (item.status !== "pending")
          fail(409, "This submission has already been reviewed.");
        if (!["approved", "denied"].includes(input.decision))
          fail(422, "Choose approve or deny.");
        const note = String(input.note || "").trim(),
          points = input.points;
        if (note.length > 1000)
          fail(422, "Review note must be under 1,000 characters.");
        if (
          input.decision === "approved" &&
          (!Number.isInteger(points) || points < 0 || points > 10000)
        )
          fail(422, "Award a whole number from 0 to 10,000.");
        if (
          (input.decision === "denied" || points !== item.estimate) &&
          note.length < 5
        )
          fail(422, "Explain the denial or point adjustment.");
        item.status = input.decision;
        item.awarded = input.decision === "approved" ? points : 0;
        item.reviewNote = note;
        item.reviewer = user.name;
        item.reviewedAt = new Date().toISOString();
        item.history.push({
          event:
            input.decision === "approved"
              ? `Approved · ${points} points`
              : "Denied",
          by: user.name,
          at: item.reviewedAt,
          note,
        });
        await save(session);
        return json({
          submission: item,
          points: totals(
            state,
            members.find((m) => m.id === item.owner),
          ),
        });
      }
    }
    if (path === "/api/demo/reset" && req.method === "POST") {
      session.data = seed();
      await save(session);
      return json({ reset: true });
    }
    if (path === "/api/export" && req.method === "GET") {
      chair();
      const q = (v) =>
        '"' +
        String(/^[=+@\-\t\r]/.test(String(v)) ? "'" + v : (v ?? "")).replaceAll(
          '"',
          '""',
        ) +
        '"';
      const lines = [
        [
          "Submission",
          "Member",
          "Activity",
          "Title",
          "Date",
          "Status",
          "Approved points",
          "Review note",
        ],
        ...state.submissions.map((s) => [
          s.id,
          members.find((m) => m.id === s.owner).name,
          s.activity,
          s.title,
          s.date,
          s.status,
          s.awarded,
          s.reviewNote,
        ]),
      ];
      return new Response(lines.map((r) => r.map(q).join(",")).join("\r\n"), {
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      });
    }
    fail(404, "Demo API endpoint not found.");
  } catch (e) {
    if (e.name === "QuotaExceededError") return json({ error: "Sandbox storage is full. Reset this sandbox or choose a smaller file." }, 507);
    return json(
      {
        error: e.status
          ? e.message
          : "Browser demo storage is unavailable. Enable site storage and reload.",
      },
      e.status || 500,
    );
  }
}
