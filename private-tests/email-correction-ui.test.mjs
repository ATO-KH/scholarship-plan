import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function correctInvitationAddress('), source.indexOf('async function loadInvitationStatus('));
function fixture(t) {
  const w = new Window({ url: 'https://portal.example.test' });
  t.after(() => w.happyDOM.abort());
  w.document.body.innerHTML = '<dialog open></dialog><section></section>';
  Object.assign(w, { user:{id:'chair'},sessionEpoch:1,roster:[{id:'member',email:'typo@example.edu'}],rosterAccounts:[],
    esc:value=>String(value),loading:String,requests:[],messages:[],refreshes:0,
    $:selector=>w.document.querySelector(selector),modal:w.document.querySelector('dialog'),
    openModal:(title,subtitle,body)=>{w.modal.innerHTML=body;},toast:message=>w.messages.push(message),
    loadInvitationStatus:async()=>{w.refreshes++;},
  });
  w.eval(code);
  const item={name:'Fictional Member',email:'typo@example.edu',emailVersion:'v1'};
  const open=()=>w.correctInvitationAddress(item,w.document.querySelector('section'));
  w.api=(path,options)=>{w.requests.push({path,options});return new Promise((resolve,reject)=>{w.resolveSave=resolve;w.rejectSave=reject;});};
  return {w,open,submit:()=>w.$('form').onsubmit({preventDefault(){}})};
}

test('email correction confirms address consequences, sends one versioned save, and does not send an invitation',async t=>{
  const f=fixture(t);await f.open();
  assert.match(f.w.modal.textContent,/does not send an email/);
  await f.submit();assert.equal(f.w.requests.length,0);
  f.w.$('[name="email"]').value='correct@example.edu';const save=f.submit();await f.submit();
  assert.equal(f.w.requests.length,1);assert.equal(f.w.requests[0].path,'/api/admin/invitations/typo%40example.edu/correct-email');
  assert.equal(f.w.requests[0].options.body.version,'v1');
  f.w.resolveSave({email:'correct@example.edu',memberId:'member',message:'Saved. Send a fresh invitation.'});await save;
  assert.equal(f.w.roster[0].email,'correct@example.edu');assert.equal(f.w.refreshes,1);assert.equal(f.w.requests.length,1);
});

test('a stale correction requires a fresh recipient view and a changed session cannot update the screen',async t=>{
  for(const mode of ['conflict','session']) {
    const f=fixture(t);await f.open();f.w.$('[name="email"]').value='correct@example.edu';const save=f.submit();
    if(mode==='conflict') f.w.rejectSave(Object.assign(Error('Recipient changed'),{status:409}));
    else {f.w.sessionEpoch++;f.w.resolveSave({email:'correct@example.edu',memberId:'member'});}
    await save;assert.equal(f.w.roster[0].email,'typo@example.edu');assert.equal(f.w.refreshes,0);
    if(mode==='conflict') {assert.equal(f.w.$('[type="submit"]').disabled,true);assert.match(f.w.$('.invitation-feedback').textContent,/refresh invitation status/);}
  }
});
