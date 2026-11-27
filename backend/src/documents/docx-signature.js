/**
 * Structural DOCX check for uploads: a .docx is a ZIP (OOXML package) whose central directory
 * lists [Content_Types].xml and word/document.xml. Only the central directory is read — nothing
 * is decompressed — so the check is cheap and cannot be turned into a zip bomb. Any ZIP that is
 * not a Word document (a renamed .zip, .xlsx, .jar, ...) or a truncated/corrupt archive fails.
 */

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const MAX_ENTRIES = 20000;
const REQUIRED = ['[Content_Types].xml', 'word/document.xml'];

/** Offset of the End Of Central Directory record, or -1. */
function findEocd(buf) {
  const stop = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + EOCD_MIN + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  return -1;
}

/** Entry names from the central directory, or null if the archive is malformed (or ZIP64). */
function listZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < EOCD_MIN) return null;
  const eocd = findEocd(buf);
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12);
  const offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) return null; // ZIP64: not expected under the upload limit
  if (count > MAX_ENTRIES || offset + size > eocd) return null;

  const names = [];
  let p = offset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > offset + size || buf.readUInt32LE(p) !== CDH_SIG) return null;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const end = p + 46 + nameLen;
    if (end > offset + size) return null;
    names.push(buf.toString('utf8', p + 46, end));
    p = end + extraLen + commentLen;
  }
  return names;
}

function isDocx(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return false; // PK\x03\x04
  const names = listZipEntries(buf);
  if (!names) return false;
  const set = new Set(names.map(n => n.split('\\').join('/')));
  return REQUIRED.every(name => set.has(name));
}

module.exports = { isDocx, listZipEntries };
