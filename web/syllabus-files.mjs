export const EVIDENCE_MIME_TYPES = Object.freeze(['application/pdf', 'image/png', 'image/jpeg']);
export const SYLLABUS_FORMATS = Object.freeze([
  { mime: 'application/pdf', extensions: ['pdf'], label: 'PDF' },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extensions: ['docx'], label: 'Word document' },
  { mime: 'application/msword', extensions: ['doc'], label: 'Word document' },
  { mime: 'application/vnd.oasis.opendocument.text', extensions: ['odt'], label: 'OpenDocument text' },
  { mime: 'application/rtf', extensions: ['rtf'], label: 'Rich text document' },
  { mime: 'text/plain', extensions: ['txt'], label: 'Text document' },
  { mime: 'image/png', extensions: ['png'], label: 'PNG image' },
  { mime: 'image/jpeg', extensions: ['jpg', 'jpeg'], label: 'JPEG image' },
]);
export const SYLLABUS_MIME_TYPES = Object.freeze(SYLLABUS_FORMATS.map(format => format.mime));
export const SYLLABUS_ACCEPT = SYLLABUS_FORMATS.flatMap(format => [...format.extensions.map(extension => `.${extension}`), format.mime]).join(',');
export const SYLLABUS_TYPES_LABEL = 'PDF, Word (.docx or .doc), ODT, RTF, TXT, PNG, or JPEG';

// Some browsers report Word files as ZIP or omit MIME altogether. The server
// checks the actual bytes; this only gives uploads a consistent Content-Type.
export function syllabusMime(file) {
  const extension = file?.name?.split('.').at(-1)?.toLowerCase();
  return SYLLABUS_FORMATS.find(format => format.extensions.includes(extension))?.mime || '';
}

const starts = (bytes, signature) => bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
export function mediaMime(bytes) {
  if (starts(bytes, [37, 80, 68, 70, 45])) return 'application/pdf';
  if (starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (starts(bytes, [255, 216, 255])) return 'image/jpeg';
  return null;
}
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const requireValid = condition => { if (!condition) throw Error('Invalid document'); };

// Inspect ZIP metadata before decompressing the small document manifests. Never
// extract to disk, follow archive paths, or expand arbitrary embedded media.
async function documentZip(bytes, mime) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
  requireValid(end >= 0 && view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length);
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directory = view.getUint32(end + 16, true);
  requireValid(view.getUint16(end + 4, true) === 0 && view.getUint16(end + 6, true) === 0 &&
    count === view.getUint16(end + 8, true) && count > 0 && count <= 1024 && directory + directorySize === end);
  const entries = new Map(), ranges = [];
  let offset = directory, expanded = 0;
  for (let index = 0; index < count; index++) {
    requireValid(offset + 46 <= end && view.getUint32(offset, true) === 0x02014b50);
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
    const nameSize = view.getUint16(offset + 28, true), extraSize = view.getUint16(offset + 30, true), commentSize = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    requireValid(!(flags & 0x41) && [0, 8].includes(method) && view.getUint16(offset + 34, true) === 0 &&
      offset + 46 + nameSize + extraSize + commentSize <= end && local + 30 <= directory);
    const name = utf8(bytes.subarray(offset + 46, offset + 46 + nameSize));
    requireValid(name && !name.startsWith('/') && !name.includes('\\') && !name.includes('\0') &&
      !name.split('/').includes('..') && !entries.has(name) && !/vbaProject|activeX/i.test(name));
    expanded += size;
    requireValid(expanded <= 25 * 1024 * 1024 && view.getUint32(local, true) === 0x04034b50 &&
      view.getUint16(local + 6, true) === flags && view.getUint16(local + 8, true) === method);
    const localNameSize = view.getUint16(local + 26, true), data = local + 30 + localNameSize + view.getUint16(local + 28, true);
    requireValid(data + compressed <= directory && utf8(bytes.subarray(local + 30, local + 30 + localNameSize)) === name);
    ranges.push([local, data + compressed]);
    entries.set(name, { data, compressed, size, method, crc: view.getUint32(offset + 16, true) });
    offset += 46 + nameSize + extraSize + commentSize;
  }
  requireValid(offset === end);
  ranges.sort((a, b) => a[0] - b[0]);
  requireValid(ranges.every((range, index) => !index || ranges[index - 1][1] <= range[0]));
  async function text(name, limit) {
    const entry = entries.get(name);
    requireValid(entry && entry.size > 0 && entry.size <= limit);
    const input = bytes.subarray(entry.data, entry.data + entry.compressed);
    let output = input;
    if (entry.method === 8) {
      const reader = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const chunks = []; let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          requireValid(length <= entry.size && length <= limit);
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      output = new Uint8Array(length);
      let at = 0;
      for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; }
    }
    requireValid(output.length === entry.size);
    let crc = 0xffffffff;
    for (const byte of output) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    requireValid((crc ^ 0xffffffff) >>> 0 === entry.crc);
    const value = utf8(output);
    requireValid(!/<!DOCTYPE|<!ENTITY/i.test(value));
    return value;
  }
  if (mime === 'application/vnd.oasis.opendocument.text') {
    requireValid(await text('mimetype', 100) === mime);
    const content = await text('content.xml', 2 * 1024 * 1024);
    requireValid(/urn:oasis:names:tc:opendocument:xmlns:office:1\.0/.test(content) && /<(?:[\w-]+:)?document-content\b/.test(content));
  } else {
    const types = await text('[Content_Types].xml', 256 * 1024);
    const mainType = types.split('<').some(part => {
      const close = part.indexOf('>');
      if (close < 0 || !/^Override\s/.test(part)) return false;
      const tag = part.slice(0, close);
      return /\bPartName=["']\/word\/document\.xml["']/.test(tag) &&
        /\bContentType=["']application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document\.main\+xml["']/.test(tag);
    });
    requireValid(!/macroEnabled|vbaProject|activeX/i.test(types) && mainType);
    const content = await text('word/document.xml', 2 * 1024 * 1024);
    requireValid(/(?:schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main|purl\.oclc\.org\/ooxml\/wordprocessingml\/main)/.test(content) && /<(?:[\w-]+:)?document\b/.test(content));
  }
  return true;
}

// A legacy Word file uses a compound-file container. Check its directory through
// the allocation table instead of accepting every OLE file (such as Excel).
function legacyWord(bytes) {
  requireValid(starts(bytes, [208, 207, 17, 224, 161, 177, 26, 225]) && bytes.length >= 512);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = view.getUint16(26, true), shift = view.getUint16(30, true), size = 2 ** shift;
  requireValid(view.getUint16(28, true) === 0xfffe && ((major === 3 && shift === 9) || (major === 4 && shift === 12)));
  const sectors = Math.floor(bytes.length / size) - 1, fatCount = view.getUint32(44, true);
  // A file within the upload limit fits the header's 109 FAT sector references.
  requireValid(fatCount > 0 && fatCount <= 109 && view.getUint32(72, true) === 0);
  const fat = [];
  for (let index = 0; index < fatCount; index++) {
    const sector = view.getUint32(76 + index * 4, true);
    requireValid(sector < sectors && !fat.includes(sector)); fat.push(sector);
  }
  const visited = new Set(); let sector = view.getUint32(48, true), word = false;
  while (sector !== 0xfffffffe) {
    requireValid(sector < sectors && !visited.has(sector) && visited.size * size < 128 * 1024 && !fat.includes(sector));
    visited.add(sector);
    const start = (sector + 1) * size;
    for (let at = start; at < start + size; at += 128) {
      if (bytes[at + 66] !== 2) continue;
      const length = view.getUint16(at + 64, true);
      requireValid(length >= 2 && length <= 64 && length % 2 === 0);
      const name = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(at, at + length - 2));
      if (name === 'WordDocument') word = view.getUint32(at + 120, true) > 0;
    }
    const table = fat[Math.floor(sector / (size / 4))];
    requireValid(table !== undefined);
    sector = view.getUint32((table + 1) * size + sector % (size / 4) * 4, true);
  }
  return word;
}

export async function validFileBytes(bytes, mime) {
  try {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 5 * 1024 * 1024) return false;
    const media = mediaMime(bytes);
    if (media || EVIDENCE_MIME_TYPES.includes(mime)) return media === mime;
    if (mime === 'application/msword') return legacyWord(bytes);
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mime === 'application/vnd.oasis.opendocument.text') return await documentZip(bytes, mime);
    if (mime === 'application/rtf') return /^\{\\rtf[1-9]\b/.test(new TextDecoder().decode(bytes.subarray(0, 32)).trimStart());
    if (mime === 'text/plain') {
      const encoding = starts(bytes, [255, 254]) ? 'utf-16le' : starts(bytes, [254, 255]) ? 'utf-16be' : 'utf-8';
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      return Boolean(text.trim()) && !/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text) && !/^\s*(?:<!doctype\s+html|<html\b|<script\b|<svg\b)/i.test(text);
    }
    return false;
  } catch { return false; }
}
