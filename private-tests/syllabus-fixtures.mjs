import { crc32, deflateRawSync } from 'node:zlib';

export function documentArchive(entries, { compressed = true } = {}) {
  const locals = [], directories = []; let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const bytes = Buffer.from(value), nameBytes = Buffer.from(name), data = compressed ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30), directory = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(compressed ? 8 : 0, 10);
    directory.writeUInt32LE(crc32(bytes), 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); directories.push(directory, nameBytes); offset += local.length + nameBytes.length + data.length;
  }
  const end = Buffer.alloc(22), directory = Buffer.concat(directories), count = Object.keys(entries).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
export const wordParts = {
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fictional syllabus</w:t></w:r></w:p></w:body></w:document>',
};
export function legacyWord(streamName = 'WordDocument') {
  const file = Buffer.alloc(11 * 512);
  Buffer.from([208,207,17,224,161,177,26,225]).copy(file);
  file.writeUInt16LE(3, 26); file.writeUInt16LE(0xfffe, 28); file.writeUInt16LE(9, 30); file.writeUInt16LE(6, 32);
  file.writeUInt32LE(1, 44); file.writeUInt32LE(0, 48); file.writeUInt32LE(4096, 56); file.writeUInt32LE(0xfffffffe, 60); file.writeUInt32LE(0xfffffffe, 68);
  file.fill(255, 76, 512); file.writeUInt32LE(1, 76);
  const directory = 512, fat = 1024;
  Buffer.from('Root Entry\0', 'utf16le').copy(file, directory); file.writeUInt16LE(22, directory + 64); file[directory + 66] = 5;
  Buffer.from(streamName + '\0', 'utf16le').copy(file, directory + 128); file.writeUInt16LE((streamName.length + 1) * 2, directory + 192); file[directory + 194] = 2;
  file.writeUInt32LE(2, directory + 244); file.writeUInt32LE(4096, directory + 248);
  file.fill(255, fat, fat + 512); file.writeUInt32LE(0xfffffffe, fat); file.writeUInt32LE(0xfffffffd, fat + 4);
  for (let i = 2; i < 10; i++) file.writeUInt32LE(i === 9 ? 0xfffffffe : i + 1, fat + i * 4);
  file.writeUInt16LE(0xa5ec, 1536);
  return file;
}
export const syllabusFixtures = [
  { name: 'class.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: documentArchive(wordParts) },
  { name: 'class.doc', mime: 'application/msword', bytes: legacyWord() },
  { name: 'class.odt', mime: 'application/vnd.oasis.opendocument.text', bytes: documentArchive({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body/></office:document-content>' }) },
  { name: 'class.rtf', mime: 'application/rtf', bytes: Buffer.from('{\\rtf1\\ansi Fictional syllabus}') },
  { name: 'class.txt', mime: 'text/plain', bytes: Buffer.from('Fictional syllabus\nClass hours: 3\n') },
];
