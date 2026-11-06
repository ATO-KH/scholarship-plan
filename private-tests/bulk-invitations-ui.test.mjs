import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const extract = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const selectionSource = extract('function mountInvitationSelection(', '\nfunction reviewBulkInvitations(');
const reviewSource = extract('function reviewBulkInvitations(', '\nasync function loadInvitationStatus(');
const statusSource = extract('async function loadInvitationStatus(', '\nasync function loadRosterSync(');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const recipients = [
  {name:'First Fictional Member', email:'first@example.test', status:'unprepared', canSendInitial:false, canInviteFromRoster:true},
  {name:'Second Fictional Member', email:'second@example.test', status:'ready', canSendInitial:true, canInviteFromRoster:true},
  {name:'Already Sent Member', email:'sent@example.test', status:'sent', canSendInitial:false, canInviteFromRoster:false},
];

function fixture() {
  const requests = [], pending = [], delays = [], outcomes = [{textContent:''}, {textContent:''}];
  const feedback = {textContent:'', innerHTML:''}, confirmation = {checked:false, disabled:false};
  const submit = {disabled:false}, stop = {disabled:false, textContent:''};
  const fields = {'.invitation-feedback':feedback, '#invitation-batch-confirm':confirmation, '[type="submit"]':submit, '[data-batch-stop]':stop};
  const form = {isConnected:true, querySelector: key => fields[key]}, panel = {isConnected:true};
  const context = {
    user:{id:'chair',role:'chair'}, sessionEpoch:4, location:{hash:'#roster'},
    modal:{open:true, close() { this.open = false; }},
    esc: value => String(value), loading: value => `Loading: ${value}`,
    openModal: (title, subtitle, body) => { context.body = body; },
    $: selector => selector === '#invitation-batch-form' ? form : {querySelector: key => outcomes[Number(key.match(/"(\d+)"/)[1])]},
    api: (path, options) => { const d = deferred(); pending.push(d); requests.push({path,options}); return d.promise; },
    setTimeout: callback => { delays.push(callback); }, rosterPage: async () => { context.refreshes++; }, refreshes:0,
  };
  runInNewContext(`(${reviewSource})`,context)(recipients,panel);
  return {context, form, panel, feedback, confirmation, submit, stop, requests, pending, delays, outcomes,
    send: () => form.onsubmit({preventDefault(){}})};
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test('canceling or closing the batch confirmation never prepares an account or sends an email', async () => {
  for (const mode of ['cancel', 'close']) {
    const f = fixture();
    f.confirmation.checked = true;
    if (mode === 'cancel') f.stop.onclick(); else f.context.modal.close();
    await f.send();
    assert.equal(f.requests.length, 0, mode);
    assert.equal(f.context.refreshes, 0, mode);
  }
});

test('one confirmation invites unprepared and prepared members together without per-person forms or bulk-resends', async () => {
  const f = fixture();
  assert.match(f.context.body,/first@example.test/); assert.match(f.context.body,/second@example.test/);
  assert.doesNotMatch(f.context.body,/sent@example.test/);
  assert.match(f.context.body,/Accounts are created automatically/);
  assert.match(f.context.body,/Existing account settings and imported tiers are kept/);
  assert.match(f.context.body,/15 credits/); assert.match(f.context.body,/Tier 1 if none is assigned/);
  assert.match(f.context.body,/adjust details afterward through Manage member/);
  assert.doesNotMatch(f.context.body,/name="(?:tier|credits|email|name)"/,'no per-person preparation form');
  await f.send(); assert.equal(f.requests.length,0,'explicit confirmation required');
  f.confirmation.checked = true;
  const batch = f.send(); await f.send();
  assert.equal(f.requests.length,1,'double clicks cannot start another batch');
  assert.equal(f.requests[0].path,'/api/admin/invitations/first%40example.test/invite-roster');
  assert.equal(JSON.stringify(f.requests[0].options),'{"method":"POST","body":{}}');
  f.pending[0].resolve({invitation:{status:'sent'}}); await tick();
  assert.equal(f.requests.length,1,'next send waits for pacing');
  f.delays.shift()(); await tick();
  assert.equal(f.requests.length,2);
  assert.equal(f.requests[1].path,'/api/admin/invitations/second%40example.test/invite-roster');
  f.pending[1].resolve({invitation:{status:'sent'}}); await batch;
  assert.equal(f.context.refreshes,1,'new accounts become editable after the roster refresh'); assert.match(f.feedback.textContent,/2 of 2 accepted/);
  assert.match(f.feedback.textContent,/Inbox delivery is not verified/);
  assert.equal(f.stop.textContent,'Done');
  await f.send(); assert.equal(f.requests.length,2,'completed confirmation cannot replay');
});

test('rate limits and ambiguous results stop the batch without attempting later recipients or automatic retries', async () => {
  for (const mode of ['error','unknown']) {
    const f=fixture(); f.confirmation.checked=true; const batch=f.send();
    if(mode==='error') f.pending[0].reject(Object.assign(Error('Email service limit reached.'),{status:429}));
    else f.pending[0].resolve({invitation:{status:'delivery_unknown'}});
    await batch;
    assert.equal(f.requests.length,1); assert.equal(f.delays.length,0);
    assert.match(f.feedback.textContent,/remaining invitations were not sent/);
    assert.equal(f.outcomes[0].textContent,'Needs checking');
    assert.equal(f.context.refreshes,1);
  }
});

test('stop remaining lets the current send finish and blocks every later recipient', async () => {
  const f=fixture(); f.confirmation.checked=true; const batch=f.send();
  f.stop.onclick(); assert.equal(f.stop.disabled,true);
  f.pending[0].resolve({invitation:{status:'sent'}}); await batch;
  assert.equal(f.requests.length,1); assert.equal(f.delays.length,0);
  assert.match(f.feedback.textContent,/1 of 2 accepted/);
  assert.match(f.feedback.textContent,/Remaining invitations were not sent/);
  f.stop.onclick(); assert.equal(f.context.modal.open,false);
});

test('closing, replacing, navigating, or changing sessions blocks later sends and stale UI updates', async () => {
  for(const changed of ['closed','replaced','navigated','panel','session']) {
    const f=fixture(); f.confirmation.checked=true; const batch=f.send();
    if(changed==='closed') f.context.modal.close();
    if(changed==='replaced') f.form.isConnected=false;
    if(changed==='navigated') f.context.location.hash='#overview';
    if(changed==='panel') f.panel.isConnected=false;
    if(changed==='session') {f.context.user={id:'different',role:'member'}; f.context.sessionEpoch++;}
    f.pending[0].resolve({invitation:{status:'sent'}}); await batch;
    assert.equal(f.requests.length,1,changed); assert.equal(f.delays.length,0,changed);
    assert.equal(f.feedback.textContent,'',changed);
    if(['navigated','panel','session'].includes(changed)) assert.equal(f.context.refreshes,0,changed);
  }
});

test('closing during pacing stops the next recipient', async () => {
  const f=fixture(); f.confirmation.checked=true; const batch=f.send();
  f.pending[0].resolve({invitation:{status:'sent'}}); await tick();
  f.context.modal.close(); f.delays.shift()(); await batch;
  assert.equal(f.requests.length,1);
});

test('select-all respects visible unsent rows, preserves explicit hidden selections, and clear resets everything', () => {
  const rows=[{hidden:false},{hidden:true}], boxes=rows.map((row,index)=>({dataset:{selectInvitation:String(index)},checked:false,closest:()=>row}));
  const fields={'[data-select-ready]':{},'[data-clear-ready]':{},'[data-review-invitations]':{},'[data-selected-count]':{},'#prepared-search':{value:'First'},'#prepared-status':{value:'all'}};
  const panel={querySelector:key=>fields[key],querySelectorAll:()=>boxes};
  const reviews=[];
  const update=runInNewContext(`(${selectionSource})`,{reviewBulkInvitations:items=>reviews.push(items)})(panel,recipients);
  fields['[data-select-ready]'].onclick();
  assert.equal(boxes[0].checked,true); assert.equal(boxes[1].checked,false);
  assert.equal(fields['[data-selected-count]'].textContent,'1 selected');
  rows[0].hidden=true; rows[1].hidden=false; fields['#prepared-search'].value='Second'; update();
  fields['[data-select-ready]'].onclick(); fields['[data-review-invitations]'].onclick();
  assert.equal(reviews[0].length,2,'review contains all selected recipients, including hidden ones');
  assert.equal(fields['[data-selected-count]'].textContent,'2 selected (1 hidden by filters)');
  fields['[data-clear-ready]'].onclick();
  assert.equal(boxes.some(box=>box.checked),false); assert.equal(fields['[data-review-invitations]'].disabled,true);
});

async function renderStatus(emailReady) {
  const refresh = {}, panel = {isConnected:true, innerHTML:'', querySelector:key=>key==='[data-refresh-invitations]'?refresh:null, querySelectorAll:()=>[]};
  const selections = [];
  const context = {$:()=>panel, invitationStatusLoad:0, esc:value=>String(value),
    api:async path=>{assert.equal(path,'/api/admin/invitations'); return {invitations:recipients,emailReady};},
    mountInvitationSelection:(destination,items)=>{selections.push(items);return ()=>{};}};
  await runInNewContext(`(${statusSource})`,context)();
  return {html:panel.innerHTML,selections};
}

test('recipient list includes selectable unprepared members without needing a tier assignment first', async () => {
  const f=await renderStatus(true);
  assert.match(f.html,/2 can be invited/);
  assert.match(f.html,/Account created when sent/);
  assert.match(f.html,/data-select-invitation="0"/);
  assert.match(f.html,/data-select-invitation="1"/);
  assert.doesNotMatch(f.html,/data-select-invitation="2"/);
  assert.match(f.html,/Select all unsent/);
  assert.match(f.html,/No individual account preparation is required/);
  assert.equal(f.selections[0].length,3);
});

test('loading the list only reads status and leaves email actions unavailable while sending is disabled', async () => {
  const f=await renderStatus(false);
  assert.match(f.html,/Email sending is not enabled/);
  assert.doesNotMatch(f.html,/data-select-invitation="/);
  assert.match(f.html,/data-select-ready type="button" disabled/);
});
