import assert from 'node:assert/strict';

export async function reviewCorrectionsScenario(call, evidence, persona = 'alex') {
  const signIn = who => call('/api/demo/session', {persona:who});
  await signIn(persona);
  const today = (await call('/api/me')).today;
  const submitted = await call('/api/submissions', {activity:'office',title:'Correctable office hours',course:'General studies',date:today,quantity:1,evidence:'sample',confirm:true});
  const pending = await call('/api/submissions', {activity:'office',title:'Credit correction pending estimate',course:'General studies',date:today,quantity:1,evidence:'sample',confirm:true});
  assert.equal(submitted.status,201); assert.equal(pending.status,201);
  const first = await call('/api/classes',{name:'Correction class A',credits:12,...evidence});
  const second = await call('/api/classes',{name:'Correction class B',credits:3,...evidence});
  assert.equal(first.status,201); assert.equal(second.status,201);
  const path=`/api/submissions/${submitted.submission.id}`;
  assert.equal((await call(path+'/revise',{decision:'approved',points:3,note:'Correction reason',version:'fake'})).status,403);
  await signIn('chair');
  let detail=(await call(path)).submission;
  assert.equal((await call(path+'/review',{decision:'denied',points:0,note:'Initial mistaken denial',version:detail.reviewVersion})).status,200);
  detail=(await call(path)).submission;
  assert.equal((await call(path+'/revise',{decision:'approved',points:7,note:'',version:detail.reviewVersion})).status,422);
  assert.equal((await call(path+'/revise',{decision:'approved',points:7,note:'Correct evidence verified',version:detail.reviewVersion})).status,200);
  assert.equal((await call(path+'/revise',{decision:'denied',points:0,note:'Stale review must not win',version:detail.reviewVersion})).status,409);
  detail=(await call(path)).submission;
  const before=detail.history.length;
  assert.equal((await call(path+'/revise',{decision:'approved',points:3,note:'Corrected point calculation',version:detail.reviewVersion})).status,200);
  detail=(await call(path)).submission;
  assert.equal(detail.awarded,3); assert.equal(detail.history.length,before+1);
  assert.equal(detail.history.at(-1).before.awarded,7); assert.equal(detail.history.at(-1).note,'Corrected point calculation');
  const approved=(await call('/api/members')).members.find(row=>row.id===persona).approved;
  assert.equal((await call(path+'/revise',{decision:'denied',points:0,note:'Duplicate evidence confirmed',version:detail.reviewVersion})).status,200);
  assert.equal((await call('/api/members')).members.find(row=>row.id===persona).approved,approved-3,'correction removes the original award rather than adding another');
  const historical=(await call(path)).submission;

  for (const course of [first,second]) {
    const item=(await call('/api/syllabi')).syllabi.find(row=>row.id===course.class.syllabusId);
    assert.equal((await call(`/api/syllabi/${item.id}/review`,{decision:'approved',version:item.version,note:''})).status,200);
  }
  const classPath=`/api/syllabi/${first.class.syllabusId}`;
  let item=(await call('/api/syllabi')).syllabi.find(row=>row.id===first.class.syllabusId);
  assert.equal(item.currentAccountCredits,15);
  const correct = body => call(classPath+'/revise',{decision:'approved',version:item.version,credits:9,note:'Syllabus lists nine hours',...body});
  assert.equal((await correct({note:''})).status,422);
  assert.equal((await correct({credits:30})).status,422);
  assert.equal((await correct({credits:'9'})).status,422);
  const changed=await correct({}); assert.equal(changed.status,200);
  assert.equal(changed.member.credits,12); assert.equal(changed.syllabus.approvedCredits,9);
  assert.equal(changed.classReviews.syllabi.length,2);
  assert.equal(changed.classReviews.syllabi.find(row=>row.id===second.class.syllabusId).currentAccountCredits,12);
  assert.equal(changed.pendingEstimates.find(row=>row.id===pending.submission.id).estimate,(await call(`/api/submissions/${pending.submission.id}`)).submission.estimate);
  assert.equal(changed.syllabus.history.at(-1).before.approvedCredits,12);
  assert.equal((await correct({})).status,409,'stale correction cannot replay');
  item=changed.syllabus;
  const denied=await correct({decision:'denied',credits:undefined,note:'Approved the wrong class'});
  assert.equal(denied.status,200); assert.equal(denied.member.credits,3); assert.equal(denied.syllabus.approvedCredits,null);
  item=denied.syllabus;
  const restored=await correct({note:'Verified correct syllabus and hours'});
  assert.equal(restored.status,200); assert.equal(restored.member.credits,12);
  assert.deepEqual((await call(path)).submission, historical,'class corrections preserve prior assignment decisions');
  await signIn(persona);
  assert.equal((await call(classPath+'/revise',{decision:'approved',version:restored.syllabus.version,credits:30,note:'Member cannot edit awards'})).status,403);
  const classes=await call('/api/classes'), current=classes.classes.find(row=>row.id===first.class.id);
  assert.equal((await call('/api/classes',{...evidence,classId:current.id,version:current.version,name:current.name,credits:6})).status,201);
  await signIn('chair');
  assert.equal((await call(classPath+'/revise',{decision:'approved',version:restored.syllabus.version,credits:9,note:'Superseded syllabus cannot change current hours'})).status,409);
}
