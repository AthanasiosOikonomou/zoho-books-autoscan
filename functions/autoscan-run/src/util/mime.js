'use strict';

/**
 * Detect the document type from magic bytes first, file name second.
 * Claude accepts application/pdf as a document block and jpeg/png/gif/webp
 * as image blocks. Anything else is UNSUPPORTED.
 */
function detectMime(buffer, fileName = '') {
  if (buffer && buffer.length >= 4) {
    const b = buffer;
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'; // %PDF
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  }
  const ext = String(fileName).toLowerCase().split('.').pop();
  const byExt = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  return byExt[ext] || 'application/octet-stream';
}

function isSupported(mime) {
  return mime === 'application/pdf' || mime.startsWith('image/');
}

/**
 * Cheap PDF page count: counts "/Type /Page" objects (not "/Pages").
 * Good enough to enforce a page cap without a PDF library. Returns 1 for images.
 */
function estimatePageCount(buffer, mime) {
  if (mime !== 'application/pdf') return 1;
  const text = buffer.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page(?![s\w])/g);
  const n = matches ? matches.length : 0;
  return n > 0 ? n : 1;
}

module.exports = { detectMime, isSupported, estimatePageCount };
