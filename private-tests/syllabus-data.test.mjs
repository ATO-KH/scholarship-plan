import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classView, assignmentClass, submissionSyllabus } from '../web/syllabus-data.mjs';
import { profileView } from '../web/profile-data.mjs';

test('legacy course strings remain visible and unapproved; historical submissions have no invented syllabus', () => {
  const state = { memberProfiles: { a: { courses: ['MTH 2002'], version: 'legacy-v1' } } };
  assert.deepEqual(classView(state, 'a').classes[0], { id: null, name: 'MTH 2002', syllabusId: null, status: 'missing', version: 'legacy-v1', fileName: '', reviewNote: '' });
  assert.deepEqual(profileView(state, 'a').courses, ['MTH 2002']);
  assert.throws(() => assignmentClass(state, 'a', { grade: true }, { course: 'MTH 2002' }), { status: 422 });
  assert.equal(submissionSyllabus(state, { owner: 'a', course: 'MTH 2002' }), null);
  state.classRecords = [{ id: 'c', owner: 'a', name: 'MTH 2002', archived: true }];
  assert.deepEqual(classView(state, 'a').classes, []);
});
