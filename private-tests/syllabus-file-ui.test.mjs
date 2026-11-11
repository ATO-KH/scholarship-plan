import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { mountProfile } from '../web/profile-ui.mjs';
import { mountFilePreview } from '../web/file-preview-ui.mjs';
import { syllabusFixtures } from './syllabus-fixtures.mjs';

function fixture(t) {
  const w = new Window({ url: 'https://portal.example.test/' });
  const saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver, File: globalThis.File, fetch: globalThis.fetch };
  Object.assign(globalThis, { document: w.document, MutationObserver: w.MutationObserver, File: w.File });
  t.after(async () => { await w.happyDOM.close(); Object.assign(globalThis, saved); });
  const container = w.document.createElement('section'); w.document.body.append(container);
  return { w, container };
}

test('class form rejects Word and non-previewable files before starting an upload', async t => {
  const { w, container } = fixture(t);
  for (const file of syllabusFixtures) {
    const writes = [];
    const api = async (path, options) => { if (options) writes.push(path); return { classes: [] }; };
    await mountProfile(container, { api, esc: String, loading: String, isCurrent: () => true });
    container.querySelector('#add-class').click();
    container.querySelector('#class-name').value = 'Fictional course';
    container.querySelector('#class-credits').value = '3';
    const input = container.querySelector('#class-syllabus');
    assert.doesNotMatch(input.accept, /docx|msword|rtf|odt|txt/);
    Object.defineProperty(input, 'files', { value: [new w.File([file.bytes], file.name, { type: 'application/octet-stream' })] });
    await container.querySelector('form').onsubmit({ preventDefault() {} });
    assert.deepEqual(writes, []);
    assert.match(container.querySelector('.profile-feedback').textContent, /PDF.*PNG.*JPEG/);
  }
});

test('document syllabus preview immediately offers its private download instead of a broken image or PDF viewer', async t => {
  const { container } = fixture(t);
  for (const file of syllabusFixtures) {
    globalThis.fetch = () => assert.fail('document previews must not fetch a public document viewer');
    const control = mountFilePreview(container, { name: file.name, mime: file.mime, previewUrl: '/api/uploads/fictional/preview', downloadUrl: '/api/uploads/fictional' }, { loading: String, label: 'Syllabus' });
    await new Promise(resolve => setImmediate(resolve));
    const link = container.querySelector('a');
    assert.equal(link.textContent, 'Download syllabus');
    assert.equal(link.getAttribute('href'), '/api/uploads/fictional');
    assert.equal(link.download, file.name);
    assert.equal(container.querySelector('img,iframe'), null);
    assert.equal(container.querySelector('.file-preview-frame').getAttribute('aria-busy'), 'false');
    control.dispose();
  }
});
