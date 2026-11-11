import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { Window } from 'happy-dom';

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const loading = await readFile(new URL('../web/loading-ui.js', import.meta.url), 'utf8');
const extract = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('startup minimum accounts for time already spent signing in and skips extra delay for reduced motion', async () => {
  const timers = [], context = { window: {}, performance: { now: () => 1000 }, matchMedia: () => ({ matches: false }),
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); }, document: { querySelector: () => null } };
  runInNewContext(loading, context);
  const minimum = context.window.atoLoading.minimumStartup(0);
  assert.equal(timers[0].delay, 1500, 'the total minimum is 2.5 seconds, not another 2.5 seconds after sign-in');
  timers[0].callback(); await minimum;
  context.performance.now = () => 4000;
  await context.window.atoLoading.minimumStartup(0);
  assert.equal(timers.length, 1, 'a slow request needs no artificial extra delay');
  context.matchMedia = () => ({ matches: true });
  await context.window.atoLoading.minimumStartup();
  assert.equal(timers.length, 1);
  assert.match(context.window.atoLoading.markup('Loading'), /animation="sequence"/);
});

function fixture(t) {
  const w = new Window({ url: 'https://portal.example.test/' });
  t.after(() => w.happyDOM.close());
  w.document.body.className = 'portal-loading';
  w.document.body.innerHTML = '<div id="auth-loading"><p id="auth-loading-message"></p></div><div class="demo-bar"><span></span></div><button class="account-button"></button><button data-action="reset"></button><div class="workspace"><div class="sidebar-bottom"></div><nav id="nav"></nav><main id="main"></main></div>';
  const minimum = deferred(), data = deferred();
  Object.assign(w, { sessionEpoch: 1, authLoadingStartedAt: null, appConfig: {}, requests: [], renders: 0,
    user: null, csrfToken: null, rules: null, submissions: [], roster: [], points: {}, canvasConnected: false,
    atoLoading: { minimumStartup: () => minimum.promise },
    isDemo: () => false, heading: () => '', esc: value => value,
    loadSubmissionList: async () => ({ submissions: [] }),
    render: () => { w.renders++; w.document.querySelector('#main').textContent = 'Ready dashboard'; },
    $: selector => w.document.querySelector(selector),
    api: async path => {
      w.requests.push(path);
      if (path === '/api/config') return { mode: 'production', chapterAuth: { enabled: true } };
      if (path === '/api/session') return { user: { id: 'member', role: 'member' }, csrfToken: 'fictional' };
      if (path === '/api/rules') return data.promise;
      if (path === '/api/points') return { approved: 0 };
      throw Error(`Unexpected path ${path}`);
    },
  });
  const init = extract('async function init(', '\nfunction loginPage()')
    .replace('import("/category-data.mjs")', 'Promise.resolve({scoreCategory: () => {}})')
    .replace('import("/category-ui.mjs")', 'Promise.resolve({categoryHint: () => {}})');
  w.eval(extract('function setAuthLoading(', '\nconst money =') + '\n' + init);
  return { w, minimum, data, workspace: w.document.querySelector('.workspace') };
}

test('one branded screen covers fast dashboard requests until the minimum completes', async t => {
  const { w, minimum, data, workspace } = fixture(t);
  const pending = w.init(); data.resolve({ today: '2026-11-10' }); await tick();
  assert.equal(w.renders, 0);
  assert.equal(workspace.inert, true);
  assert.equal(w.document.querySelector('.workspace-loading'), null, 'no second spinner handoff');
  assert.equal(w.document.body.classList.contains('signing-in'), true);
  minimum.resolve(); await pending;
  assert.equal(w.renders, 1);
  assert.equal(workspace.inert, false);
  assert.equal(w.document.body.classList.contains('portal-loading'), false);
  assert.equal(w.document.body.classList.contains('signing-in'), false);
});

test('slow dashboard requests keep the same loading screen after the minimum, then reveal ready content', async t => {
  const { w, minimum, data, workspace } = fixture(t);
  const pending = w.init(); minimum.resolve(); await tick();
  assert.equal(w.renders, 0);
  assert.equal(workspace.inert, true);
  assert.match(w.document.querySelector('#auth-loading-message').textContent, /Loading your member dashboard/);
  data.resolve({ today: '2026-11-10' }); await pending;
  assert.equal(w.renders, 1);
  assert.equal(workspace.inert, false);
});

test('a session change during the minimum cannot reveal the former account', async t => {
  const { w, minimum, data } = fixture(t);
  const pending = w.init(); data.resolve({ today: '2026-11-10' }); await tick();
  w.sessionEpoch++;
  w.user = { id: 'different-account', role: 'member' };
  minimum.resolve(); await pending;
  assert.equal(w.renders, 0);
  assert.equal(w.user.id, 'different-account');
});

test('startup failures leave a usable retry screen instead of a stuck overlay', async t => {
  const { w, minimum, data, workspace } = fixture(t);
  const pending = w.init(); await tick();
  data.reject(Error('Fictional service interruption')); minimum.resolve(); await pending;
  assert.equal(workspace.inert, false);
  assert.equal(w.document.body.classList.contains('signing-in'), false);
  assert.match(w.document.querySelector('#main').textContent, /Fictional service interruption/);
  assert.ok(w.document.querySelector('#retry'));
  assert.equal(w.user, null);
});
