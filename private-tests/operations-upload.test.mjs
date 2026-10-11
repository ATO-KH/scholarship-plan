import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Exercise the real browser handler with a small DOM boundary, without starting
// the entire portal. This catches mobile file-provider MIME and retry regressions.
const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function uploadEvidence(');
const end = source.indexOf('\nasync function ', start + 1);
assert.ok(start >= 0 && end > start);
const handlerSource = source.slice(start, end);

async function uploadFixture(file, { fail = false } = {}) {
  const fields = { '#evidence': { value: 'old-evidence' }, '#upload-status': { innerHTML: '' }, 'button[type="submit"]': { disabled: false } };
  const form = { isConnected: true, querySelector: selector => fields[selector] };
  const input = { files: [file], value: 'old-filename', disabled: false, closest: () => form };
  const requests = [], errors = [];
  const handler = runInNewContext(`(${handlerSource})`, {
    File, URL, Uint8Array, AbortSignal, btoa, user: { id: 'fictional' }, appConfig: { uploadMode: 'local' },
    $: () => form, formError: error => errors.push(error), loading: () => 'loading', esc: value => value, toast: () => {},
    api: async (path, options) => {
      requests.push({ path, body: options.body });
      if (fail) throw Error('Fictional interrupted upload');
      return { upload: { id: 'verified-evidence', name: options.body.name, size: file.size } };
    },
  });
  await handler({ target: input });
  return { input, requests, errors, fields };
}

test('mobile evidence files with empty MIME use supported extension and remain retryable', async () => {
  for (const [name, mime] of [['Syllabus.PDF', 'application/pdf'], ['photo.JPG', 'image/jpeg'], ['scan.jpeg', 'image/jpeg'], ['proof.png', 'image/png']]) {
    const result = await uploadFixture(new File(['fictional bytes'], name));
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].path, '/api/uploads');
    assert.equal(result.requests[0].body.mime, mime);
    assert.equal(result.requests[0].body.base64, btoa('fictional bytes'));
    assert.equal(result.input.value, '', 'same-file selection must fire change on retry');
    assert.equal(result.fields['#evidence'].value, 'verified-evidence');
    assert.equal(result.input.disabled, false);
  }
});

test('unsupported or explicitly conflicting mobile MIME never reaches upload API', async () => {
  for (const file of [new File(['data'], 'photo.heic'), new File(['data'], 'fake.pdf', { type: 'text/html' }), new File(['data'], 'no-extension')]) {
    const result = await uploadFixture(file);
    assert.equal(result.requests.length, 0);
    assert.equal(result.fields['#evidence'].value, '');
    assert.match(result.errors.at(-1), /PDF, PNG, or JPEG/);
  }
});

test('interrupted mobile evidence upload clears old proof and re-enables controls', async () => {
  const result = await uploadFixture(new File(['fictional'], 'evidence.pdf'), { fail: true });
  assert.equal(result.fields['#evidence'].value, '');
  assert.equal(result.fields['button[type="submit"]'].disabled, false);
  assert.equal(result.input.disabled, false);
  assert.equal(result.input.value, '');
  assert.match(result.errors.at(-1), /interrupted upload/);
});
