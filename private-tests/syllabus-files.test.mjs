import test from 'node:test';
import assert from 'node:assert/strict';
import { validFileBytes, syllabusMime } from '../web/syllabus-files.mjs';
import { syllabusFixtures, documentArchive, wordParts, legacyWord } from './syllabus-fixtures.mjs';

test('historical document files retain validation while new selection only accepts previewable formats', async () => {
  for (const file of syllabusFixtures) {
    assert.equal(await validFileBytes(file.bytes, file.mime), true, file.name);
    for (const type of ['', 'application/octet-stream', 'application/zip']) assert.equal(syllabusMime({ name: file.name.toUpperCase(), type }), '');
  }
  assert.equal(await validFileBytes(documentArchive(wordParts, { compressed: false }), syllabusFixtures[0].mime), true);
  assert.equal(await validFileBytes(Buffer.concat([Buffer.from([255,254]), Buffer.from('Syllabus – schedule', 'utf16le')]), 'text/plain'), true);
  assert.equal(syllabusMime({ name: 'syllabus.PDF', type: '' }), 'application/pdf');
  assert.equal(syllabusMime({ name: 'syllabus.docm', type: syllabusFixtures[0].mime }), '');
});

test('renamed archives, spreadsheets, HTML, corrupt documents and oversized expansion are refused', async () => {
  const docx = syllabusFixtures[0].mime;
  for (const bytes of [
    documentArchive({ 'hello.txt': 'Not a Word document' }),
    documentArchive({ ...wordParts, 'word/vbaProject.bin': 'macro' }),
    documentArchive({ ...wordParts, 'word/document.xml': 'Not document XML' }),
    documentArchive({ ...wordParts, 'word/document.xml': 'a'.repeat(2 * 1024 * 1024 + 1) }),
    documentArchive({ ...wordParts, '../outside': 'invalid path' }),
    syllabusFixtures[0].bytes.subarray(0, -1),
    Buffer.from('<html>Not a document</html>'),
  ]) assert.equal(await validFileBytes(bytes, docx), false);
  const forgedSize = documentArchive(wordParts);
  const central = forgedSize.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  forgedSize.writeUInt32LE(1, central + 24);
  assert.equal(await validFileBytes(forgedSize, docx), false, 'actual inflated bytes must respect the declared size');
  assert.equal(await validFileBytes(legacyWord('Workbook'), 'application/msword'), false);
  assert.equal(await validFileBytes(Buffer.from('<script>alert(1)</script>'), 'text/plain'), false);
  assert.equal(await validFileBytes(Buffer.from([0,1,2,3]), 'text/plain'), false);
  assert.equal(await validFileBytes(Buffer.from('Not rich text'), 'application/rtf'), false);
  assert.equal(await validFileBytes(Buffer.alloc(5 * 1024 * 1024 + 1), 'text/plain'), false);
  assert.equal(await validFileBytes(Buffer.from('%PDF-1.4\n'), docx), false);
});
