import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { mountCoursePicker } from '../web/profile-ui.mjs';
import { mountSyllabusQueue } from '../web/syllabus-ui.mjs';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const extract = (start, end) => {
  const index = source.indexOf(start), finish = source.indexOf(end, index);
  assert.ok(index >= 0 && finish > index);
  return source.slice(index, finish);
};
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function fixture(t) {
  const w = new Window({ url: 'https://portal.example.test/' });
  const previous = { document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  globalThis.document = w.document;
  globalThis.MutationObserver = w.MutationObserver;
  t.after(async () => { await w.happyDOM.close(); Object.assign(globalThis, previous); });
  w.document.body.innerHTML = '<main id="main"></main><dialog id="modal"><div id="modal-content"></div></dialog>';
  Object.assign(w, {
    user: { id: 'member', name: 'Fictional Member', role: 'member', credits: 15 }, sessionEpoch: 1,
    rules: { today: '2026-11-09', semester: { name: 'Fall 2026', startDate: '2026-09-01', endDate: '2026-12-15' }, categoryVersion: 'categories-v1',
      activities: [{ id: 'minor', name: 'Quiz', grade: true, proof: 'Grade evidence' }, { id: 'independent', name: 'Study', hours: true, proof: 'Study evidence' }] },
    points: { multiplier: 1 }, submissions: [], roster: [], filter: 'all', submissionSearch: '', submissionMember: '', submissionOrder: 'oldest',
    submissionPageIndex: 0, submissionDraft: null, modalRevision: 0, busy: false, esc, money: String,
    isDemo: () => true, loading: () => 'Loading', toast: message => w.messages.push(message),
    messages: [], requests: [], atoCelebrate: { submission() {} }, render() {}, navigation() {},
    date: String, status: String, evidence() {}, loadSubmissionSyllabus() {},
    activity: id => w.rules.activities.find(item => item.id === id), activeActivities: () => w.rules.activities,
    submissionActivity: item => item.activitySnapshot || w.activity(item.activity) || { name: '' },
    scoreCategory: (category, data) => ({ base: category.grade ? Number(data.grade) / 20 : Number(data.quantity) }),
    $: selector => w.document.querySelector(selector),
    formError: message => { w.document.querySelector('#form-error').textContent = message; },
  });
  w.modal = w.$('#modal');
  w.classes = [{ id: 'math', name: 'Calculus', status: 'approved' }, { id: 'history', name: 'History', status: 'approved' }, { id: 'pending', name: 'Chemistry', status: 'pending' }];
  w.api = async (path, options) => {
    w.requests.push({ path, options });
    if (options?.method === 'POST') return w.save(path, options.body);
    return { '/api/rules': w.rules, '/api/me': { user: w.user }, '/api/points': w.points, '/api/classes': { classes: w.classes } }[path];
  };
  w.openModal = (title, subtitle, html) => {
    w.rememberSubmissionDraft?.();
    w.$('#modal-content').innerHTML = `<div class="modal-heading"><h2>${title}</h2></div>${html}`;
    w.modal.open = true; w.modalRevision++;
  };
  w.eval([
    extract('function currentSubmissionDraft()', 'async function newSubmission('),
    extract('async function newSubmission(', '\nfunction updateSubmissionPrompts('),
    extract('function updateSubmissionPrompts(', '\nasync function submitClaim('),
    extract('async function submitClaim(', '\nasync function detail('),
    extract('async function detail(', '\nasync function review('),
    extract('async function review(', '\nasync function evidence('),
    extract('function visibleSubmissions()', '\nfunction submissionToolbar('),
    extract('function activityPicker()', '\nfunction wireActivityPicker('),
    extract('function wireActivityPicker()', '\nfunction currentSubmissionDraft('),
  ].join('\n'));
  w.uploadEvidence = () => {};
  w.loadCoursePicker = async (fields, supplied) => {
    const { profile } = await supplied;
    const input = w.$('#course');
    mountCoursePicker(input, profile.classes, esc, { classesHref: '#classes', onChange: () => w.updateSubmissionButtons() });
    input.coursePicker.update(w.activity(w.$('#activity').value));
    input.coursePicker.restore(fields);
    w.updateSubmissionButtons(); w.estimate();
  };
  const fill = (selector, value) => { const input = w.$(selector); input.value = value; input.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const category = id => { w.$('#activity').value = id; w.$('#activity-search').value = w.activity(id).name; w.updateForm(); };
  const complete = () => {
    category('minor'); fill('#title', 'Quiz 4'); fill('#grade', '97'); fill('#note', 'Fictional note');
    const select = w.$('#saved-course'); select.value = 'math'; select.dispatchEvent(new w.Event('change', { bubbles: true }));
    w.$('#evidence').value = 'sample'; w.$('[name="confirm"]').checked = true;
    w.rememberSubmissionDraft(w.$('#claim-form'), true);
  };
  return { w, fill, category, complete, open: async fields => { await w.newSubmission(fields); await tick(); },
    send: another => w.submitClaim({ preventDefault() {}, target: w.$('#claim-form'), submitter: { value: another ? 'another' : '' } }) };
}

test('class shortcut preserves the selected approved class but never invents an activity or grade', async t => {
  const f = fixture(t); await f.open({ classId: 'history' });
  assert.equal(f.w.$('#activity').value, '');
  f.category('minor');
  assert.equal(f.w.$('#saved-course').value, 'history');
  assert.equal(f.w.$('#grade').value, '');
  assert.equal(f.w.$('#estimate').textContent, '—');
  assert.equal(f.w.$('#date').min, '2026-10-26');
});

test('closing and reopening restores a draft, but a new session cannot inherit it', async t => {
  const f = fixture(t); await f.open(); f.complete();
  f.w.rememberSubmissionDraft(); f.w.modal.close();
  await f.open();
  assert.equal(f.w.$('#title').value, 'Quiz 4');
  assert.equal(f.w.$('#grade').value, '97');
  assert.equal(f.w.$('#saved-course').value, 'math');
  assert.equal(f.w.$('#evidence').value, 'sample');
  assert.equal(f.w.$('[name="confirm"]').checked, true);
  f.w.sessionEpoch++;
  await f.open();
  assert.equal(f.w.$('#title').value, '');
  assert.equal(f.w.$('#evidence').value, '');
});

test('a resumed draft cannot silently select another class after its original approval is withdrawn', async t => {
  const f = fixture(t); await f.open(); f.complete(); f.w.rememberSubmissionDraft();
  f.w.classes = [{ id: 'math', name: 'Calculus', status: 'pending' }, { id: 'history', name: 'History', status: 'approved' }];
  await f.open();
  assert.equal(f.w.$('#saved-course').value, '');
  assert.ok([...f.w.$('#claim-form').querySelectorAll('button[type="submit"]')].every(button => button.disabled));
  assert.equal(f.w.$('#title').value, 'Quiz 4');
});

test('closed semester explains the boundary before a member fills in a claim', async t => {
  const f = fixture(t); f.w.isDemo = () => false; f.w.rules.semester.endDate = '2026-11-08';
  await f.open();
  assert.equal(f.w.$('#claim-form'), null);
  assert.match(f.w.$('#modal-content').textContent, /closed for this semester/);
});

test('the shared class picker unlocks submit after a choice even without a production callback', t => {
  const { w } = fixture(t);
  w.$('#main').innerHTML = '<form><div class="field"><label for="course">Course</label><input id="course" name="course"></div><button type="submit">Submit</button></form>';
  const input = w.$('#course'), submit = w.$('button');
  mountCoursePicker(input, w.classes, esc);
  input.coursePicker.update({ grade: true }); assert.equal(submit.disabled, true);
  const select = w.$('#saved-course'); select.value = 'history'; select.dispatchEvent(new w.Event('change'));
  assert.equal(submit.disabled, false);
  input.closest('form').dataset.uploading = 'true';
  select.dispatchEvent(new w.Event('change')); assert.equal(submit.disabled, true);
});

test('submit and add another saves once and carries only reusable context into a fresh form', async t => {
  const f = fixture(t); await f.open(); f.complete();
  const save = deferred(); f.w.save = () => save.promise;
  const work = f.send(true); await f.send(true);
  assert.equal(f.w.requests.filter(call => call.options?.method === 'POST').length, 1);
  save.resolve({ submission: { id: 'saved-1', owner: 'member', title: 'Quiz 4', activity: 'minor', status: 'pending' }, points: { multiplier: 1, pending: 1 } });
  await work; await tick();
  assert.equal(f.w.submissions[0].id, 'saved-1');
  assert.equal(f.w.points.pending, 1);
  assert.equal(f.w.$('#activity').value, 'minor');
  assert.equal(f.w.$('#saved-course').value, 'math');
  for (const selector of ['#title', '#grade', '#note', '#evidence']) assert.equal(f.w.$(selector).value, '');
  assert.equal(f.w.$('[name="confirm"]').checked, false);
  assert.equal(f.w.submissionDraft, null);
});

test('a failed submission preserves input and attachment and unlocks the form for correction', async t => {
  const f = fixture(t); await f.open(); f.complete();
  f.w.save = async () => { throw Error('This category changed. Reopen the current rules.'); };
  await f.send(false);
  assert.equal(f.w.$('#title').value, 'Quiz 4');
  assert.equal(f.w.$('#evidence').value, 'sample');
  assert.equal(f.w.$('#title').disabled, false);
  assert.match(f.w.$('#form-error').textContent, /category changed/);
  assert.equal(f.w.currentSubmissionDraft().fields.title, 'Quiz 4');
});

test('queue search, member selection, status and review order work together', t => {
  const { w } = fixture(t); w.user.role = 'chair'; w.filter = 'pending'; w.submissionMember = 'one'; w.submissionSearch = 'math';
  w.submissions = [
    { id: 'new', owner: 'one', memberName: 'One', title: 'Math quiz', status: 'pending', submittedAt: '2026-11-09' },
    { id: 'other', owner: 'two', memberName: 'Two', title: 'Math quiz', status: 'pending', submittedAt: '2026-11-01' },
    { id: 'old', owner: 'one', memberName: 'One', title: 'Math test', status: 'pending', submittedAt: '2026-11-02' },
    { id: 'done', owner: 'one', memberName: 'One', title: 'Math quiz', status: 'approved', submittedAt: '2026-11-01' },
  ];
  assert.deepEqual(Array.from(w.visibleSubmissions(), item => item.id), ['old', 'new']);
  w.submissionOrder = 'newest';
  assert.deepEqual(Array.from(w.visibleSubmissions(), item => item.id), ['new', 'old']);
});

function chairReview(w) {
  w.user.role = 'chair'; w.filter = 'pending'; w.submissionMember = 'one';
  w.submissions = [
    { id: 'current', owner: 'one', status: 'pending', submittedAt: '2026-11-01' },
    { id: 'other-member', owner: 'two', status: 'pending', submittedAt: '2026-11-02' },
    { id: 'next', owner: 'one', status: 'pending', submittedAt: '2026-11-03' },
  ];
  w.roster = [{ id: 'one', approved: 0, pending: 2 }];
  w.openModal('', '', '<form id="review-form" data-id="current" data-version="current-version"><input name="points" value="5"><textarea name="note">Verified</textarea><input type="checkbox" name="reviewNext" checked><div id="form-error"></div><button type="submit">Approve</button></form>');
  const form = w.$('#review-form');
  return { form, send: () => w.review({ preventDefault() {}, target: form, submitter: { value: 'approved' } }),
    result: { submission: { id: 'current', owner: 'one', status: 'approved', awarded: 5 }, points: { approved: 5, pending: 1 } } };
}

test('chair detail places evidence and the decision together and focuses the new review heading', async t => {
  const { w } = fixture(t); w.user.role = 'chair';
  w.api = async () => ({ submission: { id: 'one', owner: 'member', memberName: 'Member', activity: 'minor',
    title: 'Quiz', status: 'pending', course: 'Calculus', date: '2026-11-09', estimate: 5, base: 5, grade: 95,
    evidenceId: 'proof', reviewVersion: 'v1' } });
  await w.detail('one');
  assert.ok(w.$('.submission-review-details #evidence-preview'));
  assert.ok(w.$('#modal-content > #review-form'));
  assert.equal(w.$('#review-form').dataset.version, 'v1');
  assert.equal(w.document.activeElement, w.$('#modal-content h2'));
  assert.equal(w.$('[name="reviewNext"]').checked, true);
});

test('chair review saves once and advances within the selected member queue without reloading the list', async t => {
  const { w } = fixture(t), review = chairReview(w), saved = deferred(), opened = [];
  w.save = async (path, body) => { assert.equal(body.version, 'current-version'); return saved.promise; };
  w.detail = async id => { opened.push(id); w.openModal('', '', '<p>Next assignment</p>'); };
  const work = review.send(); await review.send();
  assert.ok([...review.form.querySelectorAll('input,textarea,button')].every(control => control.disabled));
  saved.resolve(review.result); await work;
  assert.deepEqual(opened, ['next']);
  assert.deepEqual(w.requests.map(item => item.path), ['/api/submissions/current/review']);
  assert.equal(w.roster[0].approved, 5);
  assert.equal(w.roster[0].pending, 1);
  assert.equal(w.modal.open, true);
});

test('a saved review cannot be sent again if the next detail is unavailable', async t => {
  const { w } = fixture(t), review = chairReview(w);
  w.save = async () => review.result;
  w.detail = async () => w.toast('Next assignment could not load.');
  await review.send(); await review.send();
  assert.equal(w.requests.length, 1);
  assert.equal(w.modal.open, false);
  assert.equal(w.submissions[0].status, 'approved');
  assert.equal(review.form.querySelector('button').disabled, true);
});

test('conflicting chair review keeps the decision note and offers current details without advancing', async t => {
  const { w } = fixture(t), review = chairReview(w);
  w.save = async () => { throw Object.assign(Error('This submission changed. Reload it.'), { status: 409 }); };
  w.detail = assert.fail;
  await review.send();
  assert.equal(w.modal.open, true);
  assert.equal(review.form.querySelector('textarea').value, 'Verified');
  assert.equal(review.form.querySelector('button[type="submit"]').disabled, false);
  assert.equal(review.form.querySelector('[data-action="detail"]').dataset.id, 'current');
  assert.equal(w.submissions[0].status, 'pending');
});

test('finishing the filtered review queue does not jump to a different member', async t => {
  const { w } = fixture(t), review = chairReview(w);
  w.submissions = w.submissions.filter(item => item.id !== 'next');
  w.save = async () => review.result; w.detail = assert.fail;
  await review.send();
  assert.equal(w.modal.open, false);
  assert.match(w.messages.at(-1), /No pending submissions remain in this view/);
});

test('class review search and status switches filter loaded results without repeated requests', async t => {
  const { w } = fixture(t), container = w.document.createElement('section'); w.document.body.append(container);
  let requests = 0;
  await mountSyllabusQueue(container, { api: async () => { requests++; return { syllabi: [
    { id: 'one', className: 'Calculus', memberName: 'Member One', credits: 3, status: 'pending' },
    { id: 'two', className: 'Chemistry', memberName: 'Member Two', credits: 3, status: 'approved' },
  ] }; }, esc, loading: () => 'loading', isCurrent: () => container.isConnected });
  assert.equal(container.querySelectorAll('details').length, 1);
  const status = container.querySelector('select'); status.value = 'all'; status.dispatchEvent(new w.Event('change'));
  assert.equal(container.querySelectorAll('details').length, 2);
  const search = container.querySelector('input[type="search"]'); search.value = 'member two'; search.dispatchEvent(new w.Event('input'));
  assert.equal(container.querySelectorAll('details').length, 1);
  assert.match(container.querySelector('summary').textContent, /Chemistry/);
  assert.equal(requests, 1);
});

test('class decisions preserve the search and open the next pending class after saving', async t => {
  const { w } = fixture(t), container = w.document.createElement('section'); w.document.body.append(container);
  let decisions = 0, refreshed = 0;
  const saved = deferred();
  let items = [
    { id: 'one', classId: 'one', className: 'Calculus', memberName: 'Member One', credits: 3, version: 'v1' },
    { id: 'two', classId: 'two', className: 'History', memberName: 'Member One', credits: 3, version: 'v2' },
    { id: 'three', classId: 'three', className: 'Chemistry', memberName: 'Member Two', credits: 3, version: 'v3' },
  ];
  await mountSyllabusQueue(container, { api: async (path, options) => {
    if (!options) return { syllabi: [], removals: items };
    decisions++; assert.equal(options.body.version, 'v1');
    await saved.promise; items = items.filter(item => item.id !== 'one'); return {};
  }, esc, loading: () => 'loading', isCurrent: () => container.isConnected, search: 'Member One', onReviewed: async () => { refreshed++; } });
  const form = container.querySelector('form');
  const event = { preventDefault() {}, submitter: { value: 'approved' } };
  const work = form.onsubmit(event); await form.onsubmit(event);
  assert.equal(container.querySelector('input[type="search"]').disabled, true);
  saved.resolve(); await work;
  assert.equal(decisions, 1); assert.equal(refreshed, 1);
  assert.equal(container.querySelector('input[type="search"]').value, 'Member One');
  assert.equal(container.querySelectorAll('details').length, 1);
  assert.equal(container.querySelector('details').open, true);
  assert.match(container.querySelector('summary').textContent, /History/);
});

test('class approval advances immediately from its saved response without reloading the queue or awaiting other panels', async t => {
  const { w }=fixture(t), container=w.document.createElement('section'); w.document.body.append(container);
  const rows=[
    {id:'a',classId:'a',owner:'member',className:'Calculus',memberName:'Member One',credits:3,approvedCredits:null,approvedAccountCredits:0,currentAccountCredits:15,projectedAccountCredits:3,status:'pending',version:'a1'},
    {id:'b',classId:'b',owner:'member',className:'History',memberName:'Member One',credits:3,approvedCredits:null,approvedAccountCredits:0,currentAccountCredits:15,projectedAccountCredits:3,status:'pending',version:'b1'},
  ];
  let reads=0, saves=0, refreshed=false; const unrelated=deferred();
  await mountSyllabusQueue(container,{api:async(path,options)=>{
    if(!options) { if(path !== '/api/syllabi') return {}; reads++; return {syllabi:rows}; }
    saves++; assert.equal(options.body.credits,3); assert.equal(options.body.version,'a1');
    return {member:{id:'member',credits:3},classReviews:{owner:'member',removals:[],syllabi:[
      {...rows[0],status:'approved',version:'a2',approvedCredits:3,approvedAccountCredits:3,currentAccountCredits:3},
      {...rows[1],approvedAccountCredits:3,currentAccountCredits:3,projectedAccountCredits:6},
    ]}};
  },esc,loading:()=>'',isCurrent:()=>container.isConnected,onReviewed:()=>{refreshed=true;return unrelated.promise;}});
  await container.querySelector('form').onsubmit({preventDefault(){},submitter:{value:'approved'}});
  assert.equal(reads,1); assert.equal(saves,1); assert.equal(refreshed,true);
  assert.equal(container.querySelectorAll('.syllabus-review-card').length,1);
  assert.equal(container.querySelector('.syllabus-review-card').open,true);
  assert.match(container.querySelector('.class-credit-change').textContent,/3 → 6/);
  assert.equal(container.querySelector('[value="approved"]').disabled,false);
  unrelated.resolve();
});

test('class corrections are explicit, require a reason, and submit the reviewed hours and version once', async t => {
  const {w}=fixture(t), container=w.document.createElement('section'); w.document.body.append(container);
  const item={id:'a',classId:'a',owner:'member',className:'Calculus',memberName:'Member One',credits:3,approvedCredits:3,approvedAccountCredits:15,currentAccountCredits:15,projectedAccountCredits:15,status:'approved',version:'a2'};
  const calls=[]; const saving=deferred();
  await mountSyllabusQueue(container,{api:async(path,options)=>{
    if(!options) return {syllabi:[item]}; calls.push({path,body:options.body}); return saving.promise;
  },esc,loading:()=>'',isCurrent:()=>container.isConnected,selectedFilter:'all',ownerFilter:'member'});
  const form=container.querySelector('form'); assert.equal(form.hidden,true);
  container.querySelector('[data-correct-class]').click(); assert.equal(form.hidden,false);
  form.querySelector('[name="credits"]').value='4'; form.querySelector('[name="credits"]').dispatchEvent(new w.Event('input'));
  assert.match(form.querySelector('.class-credit-change').textContent,/15 → 16/);
  const event={preventDefault(){},submitter:{value:'approved'}};
  await form.onsubmit(event); assert.equal(calls.length,0);
  form.querySelector('textarea').value='Corrected syllabus hours';
  const work=form.onsubmit(event); await form.onsubmit(event); assert.equal(calls.length,1);
  assert.equal(calls[0].path,'/api/syllabi/a/revise'); assert.equal(calls[0].body.version,'a2'); assert.equal(calls[0].body.credits,4);
  saving.resolve({classReviews:{owner:'member',syllabi:[{...item,credits:4,version:'a3'}],removals:[]},member:{credits:16}}); await work;
  assert.match(container.querySelector('.class-review-result').textContent,/correction saved/);
  await form.onsubmit(event); assert.equal(calls.length,1,'saved form cannot replay');
});

test('approved submission offers an explicit correction and saves replacement points without advancing the pending queue', async t => {
  const {w}=fixture(t); w.user={id:'chair',role:'chair'};
  const item={id:'done',owner:'member',activity:'minor',title:'Reviewed quiz',course:'History',date:'2026-11-09',status:'approved',awarded:4,estimate:5,base:5,grade:95,history:[{event:'Approved · 4 points',at:'2026-11-09',note:'First decision'}],reviewVersion:'fresh-version'};
  w.api=async(path,options)=>{w.requests.push({path,options});return options ? {submission:{...item,awarded:6},points:{approved:6}} : {submission:item};};
  await w.detail('done'); assert.ok(w.$('[data-action="correct-submission"]')); assert.equal(w.$('#review-form'),null);
  assert.match(w.$('.history').textContent,/First decision/);
  await w.detail('done',true);
  const form=w.$('#review-form'); assert.equal(form.dataset.correction,'true'); assert.equal(form.querySelector('[name="points"]').value,'4');
  assert.equal(form.querySelector('[name="reviewNext"]'),null);
  form.querySelector('[name="points"]').value='6'; form.querySelector('textarea').value='Corrected arithmetic';
  w.submissions=[item]; w.roster=[{id:'member',approved:4}];
  await w.review({preventDefault(){},target:form,submitter:{value:'approved'}});
  const sent=w.requests.find(row=>row.options);
  assert.equal(sent.path,'/api/submissions/done/revise'); assert.equal(sent.options.body.version,'fresh-version');
  assert.equal(sent.options.body.points,6); assert.equal(w.roster[0].approved,6); assert.equal(w.modal.open,false);
});
