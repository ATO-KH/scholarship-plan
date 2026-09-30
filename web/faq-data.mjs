// Plain text FAQ content is shared by the chapter API and the fictional demo.
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
export function defaultFaqEntries() {
  return [
    { id: "faq-accounts", question: "How do I get an account or reset my password?", answer: "The Scholarship Chair manages member access. Once your chapter account is active, sign in with your email, badge number, or assigned portal ID. Ask the Chair for help with account setup or an email reset. Members who have saved their 16-word recovery key can also use it to reset a password." },
    { id: "faq-pending", question: "Why are my pending points missing from my total?", answer: "Pending points are estimates. Only points approved by the Scholarship Chair count toward your semester goal." },
    { id: "faq-privacy", question: "Who can see my submissions?", answer: "Members see their own submissions, points, and review notes. The Scholarship Chair can review member submissions and supporting evidence." },
    { id: "faq-noah", question: "What does Noah Knickerbocker do?", answer: "tbh idk" },
  ];
}
export function faqView(state) {
  return { entries: state.faqEntries ?? defaultFaqEntries(), version: state.faqRevision ?? "initial" };
}
export function validateFaqChange(input) {
  if (!input || Array.isArray(input) || typeof input.version !== "string" || input.version.length > 80)
    fail(422, "Reload the FAQ before making changes.");
  if (input.operation === "delete") {
    if (Object.keys(input).sort().join(",") !== "id,operation,version" ||
      typeof input.id !== "string" || !/^[a-z0-9-]{1,80}$/i.test(input.id))
      fail(422, "Choose an existing FAQ item to remove.");
    return { operation: "delete", id: input.id };
  }
  if (input.operation !== "upsert" || Object.keys(input).sort().join(",") !== "entry,operation,version" ||
    !input.entry || Array.isArray(input.entry) || Object.keys(input.entry).sort().join(",") !== "answer,id,question")
    fail(422, "Enter a question and answer.");
  const { id, question, answer } = input.entry;
  if ((id !== null && (typeof id !== "string" || !/^[a-z0-9-]{1,80}$/i.test(id))) ||
    typeof question !== "string" || !question.trim() || question.trim().length > 200 ||
    typeof answer !== "string" || !answer.trim() || answer.trim().length > 4000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(question + answer))
    fail(422, "Use a question up to 200 characters and an answer up to 4,000 characters.");
  return { operation: "upsert", entry: { id, question: question.trim(), answer: answer.trim() } };
}
export function applyFaqChange(entries, change, makeId) {
  if (change.operation === "delete") {
    if (!entries.some((entry) => entry.id === change.id)) fail(404, "FAQ item not found. Reload this page.");
    return entries.filter((entry) => entry.id !== change.id);
  }
  if (change.entry.id && !entries.some((entry) => entry.id === change.entry.id))
    fail(404, "FAQ item not found. Reload this page.");
  const key = (question) => question.toLowerCase().replace(/\s+/g, " ");
  if (entries.some((entry) => entry.id !== change.entry.id && key(entry.question) === key(change.entry.question)))
    fail(422, "That question already exists. Edit its answer instead.");
  if (!change.entry.id && entries.length >= 100) fail(422, "The FAQ already has 100 questions.");
  const entry = { ...change.entry, id: change.entry.id || makeId() };
  return change.entry.id ? entries.map((item) => item.id === entry.id ? entry : item) : [...entries, entry];
}
