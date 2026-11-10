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

test('class form normalizes generic document MIME types and completes upload before submitting the class', async t => {
  const { w, container } = fixture(t);
  for (const file of syllabusFixtures) {
    const requests = [], transfers = [];
    globalThis.fetch = async (url, options) => { transfers.push(options); return new Response('{}'); };
    const api = async (path, options) => {
      requests.push({ path, body: options?.body });
      if (path === '/api/uploads/init') return { id: 'fictional-upload', uploadUrl: 'https://storage.example.test/temporary' };
      if (path.endsWith('/complete')) return { upload: { id: 'fictional-upload' } };
      return { classes: [] };
    };
    await mountProfile(container, { api, esc: String, loading: String, isCurrent: () => true, config: { uploadMode: 'direct' } });
    container.querySelector('#add-class').click();
    container.querySelector('#class-name').value = 'Fictional course';
    container.querySelector('#class-credits').value = '3';
    const input = container.querySelector('#class-syllabus');
    Object.defineProperty(input, 'files', { value: [new w.File([file.bytes], file.name, { type: 'application/octet-stream' })] });
    await container.querySelector('form').onsubmit({ preventDefault() {} });
    assert.equal(requests.find(call => call.path === '/api/uploads/init').body.mime, file.mime);
    assert.equal(transfers[0].headers['Content-Type'], file.mime);
    assert.equal(transfers[0].body.type, file.mime);
    assert.equal(requests.find(call => call.path === '/api/classes' && call.body).body.evidenceId, 'fictional-upload');
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
