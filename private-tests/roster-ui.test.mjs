import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { mountRosterMembers } from '../web/roster-ui.mjs';
const esc=value=>String(value??'').replaceAll('<','&lt;').replaceAll('"','&quot;');
test('member workspace searches aliases, separates inactive accounts and exposes point and class controls',async t=>{
  const w=new Window(); t.after(()=>w.happyDOM.close());
  const container=w.document.createElement('section'); w.document.body.append(container);
  const state={filter:'active'};
  const members=[
    {id:'a',name:'Alex <Example>',email:'alex@example.test',role:'member',active:1,credits:15,creditsManaged:true,tier:2,approved:20,goal:50,pending:2,identities:[{provider:'login',subject:'kh-alex'}]},
    {id:'b',name:'Former Member',role:'member',active:0,credits:12,tier:3,approved:10,goal:80,pending:0},
    {id:'chair',name:'Chair Office',role:'chair',active:1},
  ];
  mountRosterMembers(container,members,{esc,state,chapterAuth:true,currentUserId:'chair'});
  assert.equal(container.querySelectorAll('tbody tr').length,1);
  assert.equal(container.querySelector('[data-action="adjust-points"]').dataset.id,'a');
  assert.equal(container.querySelector('[data-action="manage-credits"]').dataset.id,'a');
  assert.equal(container.querySelector('Example'),null);
  const search=container.querySelector('input'); search.value='KH-ALEX'; search.dispatchEvent(new w.Event('input'));
  assert.equal(container.querySelectorAll('tbody tr').length,1);
  search.value='missing'; search.dispatchEvent(new w.Event('input')); assert.equal(container.querySelector('tbody'),null);
  search.value=''; search.dispatchEvent(new w.Event('input'));
  const filter=container.querySelector('select'); filter.value='inactive'; filter.dispatchEvent(new w.Event('change'));
  assert.match(container.querySelector('tbody').textContent,/Former Member/); assert.equal(container.querySelector('[data-action="adjust-points"]'),null);
  mountRosterMembers(container,members,{esc,state,chapterAuth:true,currentUserId:'chair'});
  assert.equal(container.querySelector('select').value,'inactive','state survives an update');
});
