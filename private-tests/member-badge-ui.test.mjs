import test from "node:test";
import assert from "node:assert/strict";
import { mountBadgeSettings } from "../web/badge-ui.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture({ demo = false } = {}) {
  const load = deferred(), save = deferred(), requests = [], views = [];
  const input = { value: "00123", disabled: false }, button = { disabled: false };
  const reload = { hidden: true, disabled: false }, classes = new Set();
  const feedback = { innerHTML: "", textContent: "", classList: { add: name => classes.add(name), remove: name => classes.delete(name) } };
  const form = { isConnected: true,
    querySelector: selector => selector === "input" ? input : selector === ".badge-feedback" ? feedback : reload,
    querySelectorAll: () => [input, button, reload] };
  let active = true;
  const container = { isConnected: true, set innerHTML(value) { views.push(value); },
    querySelector: selector => selector === "form" ? form : reload };
  const details = { badge: "00123", loginId: "KH-1234567890", version: "a".repeat(64) };
  const api = (path, options) => { requests.push({ path, options }); return options ? save.promise : load.promise; };
  const opened = mountBadgeSettings(container, { api, esc: value => String(value ?? ""), loading: message => message,
    isCurrent: () => active, demo });
  return { load, save, requests, views, input, button, reload, feedback, classes, form, container, details, opened,
    mount: async () => { load.resolve(details); await opened; }, leave: () => { active = false; },
    submit: () => form.onsubmit({ preventDefault() {} }) };
}

test("Badge form preserves text IDs and submits only badge/version once without email", async () => {
  const f = fixture(); await f.mount();
  assert.match(f.views.at(-1), /Portal ID: <code>KH-1234567890<\/code>/);
  assert.match(f.views.at(-1), /type="text" maxlength="32" autocomplete="off" autocapitalize="none"/);
  f.input.value = "00456";
  const saving = f.submit(); await f.submit();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1], { path: "/api/account/badge", options: { method: "POST", body: { badge: "00456", version: f.details.version } } });
  assert.equal(f.input.disabled, true);
  assert.match(f.feedback.innerHTML, /Saving badge/);
  f.save.resolve({ ...f.details, badge: "00456", version: "b".repeat(64) }); await saving;
  assert.equal(f.input.value, "00456");
  assert.equal(f.input.disabled, false);
  assert.match(f.feedback.textContent, /saved/);
});

test("Badge removal submits an empty string and keeps account ID explanation", async () => {
  const f = fixture(); await f.mount(); f.input.value = "";
  const saving = f.submit();
  f.save.resolve({ ...f.details, badge: "" }); await saving;
  assert.equal(f.requests[1].options.body.badge, "");
  assert.match(f.feedback.textContent, /removed.*email and portal ID still work/);
});

test("Badge conflict restores editing and offers a fresh read", async () => {
  const f = fixture(); await f.mount();
  const saving = f.submit(); f.save.reject(Object.assign(Error("Another member already uses this badge."), { status: 409 })); await saving;
  assert.match(f.feedback.textContent, /Another member/);
  assert.equal(f.reload.hidden, false);
  assert.equal(f.input.disabled, false);
  assert.ok(f.classes.has("error"));
  await f.reload.onclick();
  assert.equal(f.requests.at(-1).options, undefined);
});

test("Badge results cannot replace a different account or closed profile", async () => {
  const f = fixture(); f.leave(); await f.mount();
  assert.equal(f.views.length, 1);
  const g = fixture(); await g.mount();
  const saving = g.submit(); g.leave(); g.save.resolve({ ...g.details, badge: "other" }); await saving;
  assert.notEqual(g.input.value, "other");
  assert.equal(g.feedback.textContent, "");
});

test("Badge load failure is recoverable and demo has no account mutation controls", async () => {
  const f = fixture(); f.load.reject(Error("Unavailable")); await f.opened;
  assert.match(f.views.at(-1), /Unavailable.*Try again/);
  assert.equal(typeof f.reload.onclick, "function");
  const demo = fixture({ demo: true }); await demo.opened;
  assert.equal(demo.requests.length, 0);
  assert.match(demo.views.at(-1), /unavailable for demo and test accounts/);
  assert.doesNotMatch(demo.views.at(-1), /<form/);
});
